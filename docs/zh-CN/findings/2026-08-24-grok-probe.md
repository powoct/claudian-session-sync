# 2026-08-24 · Grok 可同步性探测(P6,Mac + Windows)

> 完整原始记录在两台验收机器带回的 `tmp/probe-m2/out_r2/`(38 张 grok 生命周期快照 +
> 两份平台小结),不入库。本文是回填文档用的脱敏摘要。
> 套件:`tmp/probe-m2/`(P6 任务书见其 `AGENTS.md` §6b)。判定基准:架构文档
> §6.1(Tier 规则)、§6.6(group 原子性与不变式 G1)、§7.2/§7.2b(两张决策表)。
>
> **本文的每条判定都在开发机上按原始快照复核过**,复核方法写在各节的「复核」里;
> 只能由 CLI 交互输出证明的结论(如 `sessions list` 是否列出)标注为「双平台各自独立口述」。

## 环境

| 项 | 机器 1 | 机器 2 | 开发机(旁证) |
|---|---|---|---|
| OS | macOS(darwin,node 26.5.0) | Windows(win32,Git Bash **无 TTY**,node 24.18.0) | Linux |
| grok | **1.0.5 (5115b46bc909)** | **1.0.5 (5115b46bc9) [stable]** | 1.0.5 |
| 沙箱 | `GROK_HOME=~/aiss-probe-m2/grok-home` | 同 | —(只读旁证) |
| 真实库规模 | 6 projects / 22 sessions | 2 / 11 | 1 / 1 |

沙箱门禁(6b.0)双平台三条全过:沙箱内出现真实会话目录、真实 `~/.grok` 会话数前后
不变(22→22 / 11→11)、指向空 `GROK_HOME` 时 `sessions list` 为空。**第三条是关键**——
它证明读侧也认 `GROK_HOME`,后续所有删文件实验都没有碰到用户的真实会话。

## 一、Grok 能不能同步:能

两条独立的必要条件都成立:

| 条件 | 结果 | 证据 |
|---|---|---|
| **跨 cwd 落位**(6b.2) | ✅ | 把会话目录 `mv` 到另一 cwd 对应的项目目录后,新 cwd 下列表可见、`--resume` 成功、历史完整;旧 cwd 下消失。Windows 另做了「原样拷进全新 `GROK_HOME`」的跨机模拟,同样可被列出 |
| **发现机制不是外部索引**(6b.1) | ✅ | `sessions/` 下确有 `session_search.sqlite`(36,864 B),但把会话拷进一个**没有任何索引**的全新 `GROK_HOME` 后仍被列出(list 现场自己建了索引)⇒ 它是搜索缓存,不是可见性门槛 |

**落位规则 = 按对端 cwd 重算项目目录名**,与 Claude Code 同构:

```
<GROK_HOME | ~/.grok>/sessions/<encodeURIComponent(<cwd 的绝对路径>)>/<sessionId>/
```

双平台逐字节验证 EXACT(Windows 形态 `C%3A%5C…`,反斜杠编为 `%5C`)。开发机复核:
`encodeURIComponent(decodeURIComponent(dirname)) === dirname` 成立。

> **与 Claudian 源码互证**:`src/providers/grok/history/GrokHistoryPathResolver.ts` 里
> `encodeGrokSessionCwd = encodeURIComponent(path.resolve(cwd))`,会话目录取
> `path.join(root, encodeGrokSessionCwd(vaultPath), sessionId)`,`GROK_HOME` 优先于
> `~/.grok`,Windows 上 `USERPROFILE` 优先于 `HOME`。**因此 Claudian 记录里的
> `sessionId` 就是会话目录名**——ADR-47 的准入对 Grok 直接可用(本轮 P3 实测 15 条
> grok 记录 `sessionId` 全部非空)。
> 一处差异:CLI 落位用的是 **realpath**(探测实测),Claudian 用 `path.resolve`(不解
> 符号链接)。vault 路径含符号链接时两者会分叉,本插件按 CLI 的口径取 realpath。

## 二、group 的成员语义:**同一个 session 里两张决策表并存**

这是 Grok 与已接入的两个 provider 最根本的差别。逐文件判定(38 张快照,每步对**此前
所有版本**做「旧字节是否为当前文件严格前缀」校验):

| 文件 | 语义 | 双平台一致? | 复核 |
|---|---|---|---|
| `chat_history.jsonl` | **严格追加**(§7.2) | ✅ | 正常使用期间 PREFIX_VIOLATION **0 条**;唯一两次违反发生在 6b.5 人为移走该文件、以及把原件盖回的那两步 |
| `updates.jsonl` | **严格追加** | ✅ | 全程 0 违反、0 缩短(mac 39 次采样 / win 34 次) |
| `rewind_points.jsonl` | **严格追加**(每 turn 一条) | ✅ | 0 违反、0 缩短。条数是每 turn 一条,**字节数不是常数**(mac 103–104,win 103–107;win 有一步 +212 是那一步跑了两个 turn,由 `prompt_history.jsonl` +2 行佐证) |
| `events.jsonl` | **严格追加** | ✅ | 违反只出现在移走后重建的那步 |
| `prompt_history.jsonl`(**项目级**,不属任何 session) | 严格追加 | ✅ | 0 违反 |
| `summary.json` | **每次会话进程启动即整份重写**(§7.2b) | ✅ | 每一版都不是下一版的前缀;多次「字节数不变但 hash 变」(win 步 5/7/8/9/13/14/16/18) |
| `signals.json` | 整份重写 | ✅ | 计数器,尺寸可增可减(1507→1505) |
| `prompt_context.json` | **进程启动时**整份重写(不是 turn 结束时) | ✅ | mac ±1 B、win ±3 B 抖动。判据:win 的「孤儿进程写完」那一步有 6 个文件变化而它没变;它与 `system_prompt.txt` 的 mtime 毫秒级相同,两者在进程启动时一起写 |
| `title_refresh_idx` | 1 字节整份重写,**但不是每 turn** | ⚠️ mac 全程只变一次(`"0"`→`"2"`,**跳过 `"1"`**),win 20 张快照全程未变 | 不是单调计数器,**不带顺序信息,不能按 max() 合并**;两平台都证明它缺席不影响可见性与 resume |
| `announcement_state.json` | **只变一次**,不是每 turn | 仅 mac 出现 | 第 5 张快照才出现(1438 B),第 6 张变成 357 B,此后 12 张快照**字节完全相同**(跨至少 6 个 turn)。**机器/环境作用域而非会话状态**:同机另一个会话是同一个 hash,fork 出的副本连 mtime 都与父会话相同(早于 fork 目录自身的创建时间)⇒ fork 是原样拷贝而非重新序列化 |
| `*.lock` × 4 | **恒 0 字节** | ✅ | 全部快照全部平台 sha256 恒为空文件 hash;运行期间也是 0;强杀后残留但不阻塞 resume(flock 语义) |

**「只增不减」不等于追加**,所以上表用的是前缀校验而不是尺寸比较;`.lock` 那一行则是
反过来——它永远是 0 字节,所以「同步它」在任何意义上都没有内容可搬,只有噪声。

三条必须跟着这张表一起读的限定,否则它会被读成比证据更强的东西:

1. **「严格追加」是对「turn 写它」的判断,不是对文件的判断。** 一旦文件缺失、由 CLI
   重建,重建版**与被移走的版本互不为前缀**且短得多(win `events.jsonl` 1,591,673 B →
   1,840 B;`chat_history.jsonl` 78,523 B → 47,826 B,报告里有 6 条显式 PREFIX_VIOLATION),
   **重建之后它又以合法的样子继续纯追加**。含义很硬:**任何按尺寸、按行数、按末尾比较
   的合并规则都会在这里静默拼接两段互不相干的历史**。本插件的前缀表要求「更长**且**包含
   对方前缀」,所以它把这种情况判成 `CONFLICT`、两侧都留——这正是需要的结果,但它是被
   规则救下的,不是被这条实测保证的。
2. **报告里的违反条数不能读成「坏了几次」。** 工具把每一步与**此前所有**版本比对,所以
   一次改写会在后续每一步各记一条,条数是 O(版本数²)。`announcement_state.json` 的 12 条
   全部来自同一次 1438→357 的变化。
3. **「差异从偏移 0 开始」不成立于本数据集。** 快照只在 65,536 B 的整数倍处存前缀 hash,
   而这里所有 JSON 状态文件都小于 64 KB(`checkpoints: []`),所以工具报的偏移只是
   「已证明相等的下界」= 0,意思是「什么都没证明相等」,不是「第一个字节就不同」。
   两份小结都把这个下界当成了测量值。

### 无写行为的两种操作(重要,决定稳定性判定的成本)

- `grok export`(纯读路径):macOS 快照 3 显示 14 个文件**零变化**;
- 静置 60 s:双平台**零变化**,无后台偷写。

反例一条:macOS 上 **TUI resume 即使一条消息都不发,也会重写 `prompt_context.json`
与 `summary.json`**。Windows 全程 headless,未观察到(其 `g02-resume-readonly` 步
summary.json「未变」)。含义见第五节。

## 三、不变式 G1 成立,primary = `summary.json`

6b.5 逐个移走文件,每步实测「列表是否还列出」「能否 resume」「CLI 是否重建」:

| 移走 | 列表 | resume | CLI 重建? |
|---|---|---|---|
| `title_refresh_idx` | 还在 | 成功 | 否 |
| `prompt_context.json` | 还在 | 成功 | **是** |
| `system_prompt.txt` | 还在 | 成功 | **是**(且**字节完全相同**) |
| `events.jsonl` | 还在 | 成功 | **是**(只含新 turn) |
| **`summary.json`** | **消失** | 见下 | **否** |
| `chat_history.jsonl` | 还在 | 成功但**历史有损** | **是**(mac 37→26 行 / win 78,523→47,826 B ≈ 61%) |

**恰好一个文件的缺席让会话从列表消失** ⇒ G1 成立,Grok 可以走 §6.6 的 group 落地
路径:先落 aux、**最后落 `summary.json`**,在 primary 就位前该 session 对 CLI 的
列表完全不可见。

### ⚠️ 缺 `summary.json` 时 resume 的真实行为:**turn 落进了另一个会话**

两份小结在这一格互相矛盾(mac 写「exit=0 但如同全新会话/0 行」,win 写「成功(按 ID)」),
按快照复核的结果是**两个都不对,而真相比两个都糟**:

- **macOS 快照 16**:目标会话 `01a02f27…` **零变化**(newFiles 空、changedFiles 空),
  而 g06 fork 出来的那个会话 `01a02f3c-ac4b` 同一步长大了——`chat_history` 14322→14889
  (25→28 行)、`events` 1926→3678、`updates` 15154→17255、`rewind_points` 103→206、
  `summary.json` 被重写,项目级 `prompt_history.jsonl` +126 B(正好一条真实输入)。
- **Windows 快照 17**:形状完全相同——目标 `01a02f3c-8efb` 零变化,fork `01a02f43-c326`
  的 `chat_history` 12403→12963(20→23 行)、`updates` 12936→15034、`prompt_history` +129 B。

也就是说:**`summary.json` 缺席时,用户的下一个 turn 被静默追加到了另一个会话**。
不是报错,不是新建会话。mac 那一侧还排除了「回落到最近使用的会话」这条解释——fork
的最后写入时间(15:28:23)早于同机另一个会话(15:32:13)。**实际的解析规则未知**
(可疑对象是从未被快照的 HOME 级 `active_sessions.json`,2 字节)。

这条改变了 G1 的分量。G1 原本读作「primary 到位前不可见」,现在必须读作:

> **primary 到位之前,这个会话目录不能对 CLI 存在。** 不是「看不见就安全」——
> 一次指向它的 resume 会污染**别人的**对话,而且那些写入是合法的纯追加,
> 会被本插件忠实地复制到所有机器。

落到实现上是三条硬规则(见 §6.6.1、ADR-52):同组按 primary 最后落地;组内预算
不可分割;**replica 里没有 primary 的 group 一个文件都不落**(`primary-not-in-replica`)。

### 其余三条限定

1. **`summary.json` 不被 CLI 重建**——它既是可见性开关又是身份载体,同步必须搬它。
   开发机复核:会话 uuid 出现在 `summary.json` 的 **`info.id`**,与目录名相等;
   该机的 `chat_history.jsonl`/`events.jsonl` 里**不含** uuid。
   ⇒ **绝不能改会话目录名**(目录名与 `info.id` 必须一致)。
   ⚠️ 但「不被重建」这一点在那一步其实**没有被真正考验**:CLI 当时压根没碰这个目录
   (零写入)。它成立的证据是「移回之前它一直没回来」,不是「CLI 试过重建而失败」。
2. `chat_history.jsonl` 的「还能看到」是**有损重建**的结果,不是它可以不搬。
3. **`--resume <uuid>` 不看列表**(Windows 实测),所以「列表里没有」从来不等于「碰不到」。

**这个实验测的是必要性,而且是在一个已经退化的组上测的。** 到移走 `summary.json` 那一步,
`events.jsonl` 已经是前一步留下的 1,927 B 重建件(原件 26,739 B),`prompt_context.json`
也已被重写过。按**文件名**看这个组是完整的,按**内容**看不是。
**充分性方向(只放同步集、其余全无 ⇒ 可见且历史完整)从未测过**,它是发布前验收的必测项。

## 四、混龄 group 不会弄坏会话(这条决定了不需要 staging 事务)

双平台各做了一次:把 `summary.json` 回滚到旧版本、`chat_history.jsonl` 保持最新,
然后 resume。

- 结果:**resume 正常、轮数正确、无报错、会话未被截断**;
- `summary.json` 在下一轮被 CLI **按当前历史重新生成**。

开发机复核(Windows 快照):步 11 的 summary.json hash `47e1705d392f` 与 g00 基线
**完全相同**(确认回滚生效),步 12 变成 `408864e1447b`——**一个此前从未出现过的
hash**,既非回滚版也非回滚前版本。这就是「重新生成而非恢复」的字节级证据。

> Windows 的偏差已知并已评估:任务书要求回滚到 g01,实际回滚到 g00(手上只有 g00
> 的字节副本)。回滚得**更旧**只会让测试更严苛,不削弱结论。

含义:**混龄的 group 不会坏,但「自愈」这个词要收窄。** 复核发现一处两份小结都没记的
事实:macOS 上 `summary.json` 在回滚前是 **851 B / 23 行**,回滚后 CLI 重新生成的是
**713 B / 21 行**,并且此后六张快照一直是 713 B——**回滚前存在的 138 字节 / 2 行状态
再也没有回来**。Windows 也没回到原尺寸(720→728,原本 728 但内容不同)。

所以准确的说法是:

> `chat_history.jsonl` 是权威,`summary.json` 会被按当前历史重新生成;
> 会话不被截断、resume 正常、历史完整——**但陈旧副本里独有的那部分状态被静默丢弃**,
> 没有报错也没有可见症状。尺寸也不是新鲜度信号(711/713/851 与 720/722/728 都是合法状态)。

这足以支撑「撕裂的**更新**不会毁掉会话」,因此 §6.6 里为多文件 provider 预留的
`.aiss-stage-<passId>/` 暂存事务对 Grok **不是正确性的必要条件**——顺序化的逐文件原子写
(primary 最后)已经够。它**不**足以支撑「陈旧的 `summary.json` 落到对端无所谓」,
所以 §7.2b 的收敛基点判定必须照常执行,不能因为「反正 CLI 会重写」就放宽。

## 五、机器相关内容与「打开即写」

- **含绝对路径的键**:`summary.json` → `grok_home`;`prompt_context.json` →
  `working_directory`、`shell_path`(开发机复核另见 `agents_md_files`、`os_name`)。
- 字节计数(不记内容):`summary.json` 命中 HOME×2、cwd×1、GROK_HOME×1;
  `prompt_context.json` HOME×1、cwd×1;`chat_history.jsonl` HOME×1;其余全 0。
- 路径形态有三种:原样 `C:/…`、JSON 转义 `C:\\…`、percent-encoded(仅目录名)。
  ⚠️ 任务书给的 `^([A-Za-z]:\\|/)` 正则**抓不到 `C:/` 正斜杠形态**,Windows 侧靠补扫
  才发现;macOS 侧用同一正则,可能同样低报。修正后的口径记在下一轮套件里。

两份小结在这里也不一致(mac 写「未被 CLI 改写」,win 写「后续使用中被正常改写」)。
复核判定:**文件级 win 对、mac 错**——`summary.json` 与 `prompt_context.json` 在**两台
机器上都**几乎每次会话进程启动就换 hash(mac 的 `prompt_context.json` 在 18 张快照里
出现过 12 个不同 hash)。**字符串级无法判定**:快照按红线不记内容,所以「那几个陈旧
绝对路径是否在重写中被换掉」在任何一台机器上都没有证据。

能确定的只有两件事,而它们已经够用:

- 6b.2 实测**带着旧绝对路径的会话搬过去照样可见、可 resume、历史完整**——陈旧路径不是
  阻塞项;
- 两台机器的 `summary.json` 尺寸区间就不一样(mac 711/713/851,win 720/722/728),
  所以跨机之后**两边几乎不可能字节相等**。这不影响正确性:§7.2b 的收敛基点快进按
  「本机上次收敛过的字节」判定,不按「两边是否相等」;但它意味着 Grok 的 primary
  每次往返都会重写一遍。

不做内容规范化(`toNeutral`/`fromNeutral` 保持 identity)的理由见 ADR-52;
「CLI 每次启动都重写它」这条实测反而是理由之一——落地的外来 `grok_home` 是短命的。

## 六、强杀:文件停在半截,但 Windows 上进程可能还活着

- 双平台:SIGTERM 后文件停在半截状态,无损坏;锁文件残留但**不阻塞** resume。
- ⚠️ **Windows 观察到孤儿进程**:Git Bash 里 `kill` 杀掉的是 MSYS 包装进程,**grok 原生
  子进程存活并继续写**——最后一次写入在杀进程快照之后 **165.9 秒**,`events.jsonl`
  单步 +829,178 B(16 KB → **1.59 MB**)。
- **这不构成「Windows 与 macOS 不同」的结论。** 两边杀的根本不是同一个实验:mac 杀的是
  一个**全新会话**(10/13 个文件,`rewind_points`/`signals` 还没生成),win 杀的是一个
  **已有会话的 resume**;而且 **mac 根本没跑杀后静置那一步**,它的杀进程快照距
  `events.jsonl` 的 mtime 只有 53 ms——同样兼容「有个子进程活着而探测没去看」。

对本插件的含义有两条,第二条是新的:

1. 「CLI 看起来结束了」与「文件真的停了」之间可以差几分钟。§9.1 的稳定窗口本来就是按
   观察而不是按进程状态判定的,这条实测**支持**现有设计,并说明 quiet window 调得过短
   会真的踩到。
2. ⚠️ 那个孤儿进程在 resume 已经写过 `summary.json` **之后**又把它重写了一遍(杀进程后
   2 分 46 秒)。也就是说,**一轮 pass 有可能抓到一个 CLI 自己随后丢弃的 primary**,
   而 `summary.json` 是 opaque、没有版本号,事后无从分辨。缓解手段是既有的:覆盖前备份
   (I1)+ 下一轮重新收敛;但它是「无法预防、只能可恢复」的一类,记在这里。

## 七、还没测的东西(以及它们各自封顶多大风险)

这一节比上面几节重要。P6 回答了「Grok 能不能同步」,没有回答「这次同步做对了没有」——
下表按「弄错了会多糟」排序,`⛔` 是发布闸门。

| # | 未测的事 | 弄错的后果 | 怎么关掉 |
|---|---|---|---|
| ⛔ 1 | **真正的两机往返从未做过。** 6b.2 的两个实验都在**同一台机器**上换 cwd(同一个 `GROK_HOME`、同一个 OS、同一个 CLI 构建、同一份登录态);Windows 那次「跨机模拟」用的 `summary.json` 是它**自己**的基线副本(720 B / `47e1705d392f`)——**两台机器之间没有一个字节真的走过** | 功能整体不成立,或成立但静默出错。同步真正会改变的每一个变量,这两个实验恰好全都固定住了 | **M4 式两机验收**:A 机三轮对话 → 静置 → 整个会话目录搬到 B 机重算出的项目目录 → B 机 `sessions list` + `--resume <id> -p` → 校验历史完整 → 再搬回 A 机 resume。**两个方向都要过**。见 testing.md §9.6 |
| ⛔ 2 | **G1 的充分性**:把候选同步集放进一个**空的**项目目录,CLI 认不认 | 对端会话「列表里有、resume 成功、答得却是残缺历史」——用户察觉不到也撤销不了 | **列表这一半已关闭**(见 §七之二:只放 `summary.json`+`chat_history.jsonl` 仍被列出);**resume + 历史完整**这一半要登录态,留在验收 G3/G4 |
| 3 | **`updates.jsonl` / `rewind_points.jsonl` / `signals.json` / `announcement_state.json` 的移走实验从未做过** | 若 `updates.jsonl` 才是权威而 `chat_history.jsonl` 是派生,把前者判成「不同步」就会在对端丢对话 | 本插件**已选安全侧**:`updates.jsonl` 与 `rewind_points.jsonl` 都在同步集里。真实库普查也给了旁证:22 个真实会话里 11 个没有 `updates.jsonl`、8 个有 `signals.json`——**多数真实会话本来就缺这些文件而照常工作** |
| 4 | **`/compact` 从未在 Grok 上跑过** | 这是唯一一个**正常使用**中就可能就地重写 `chat_history.jsonl` 的操作(真实库里 3 个会话有 `compaction*` 条目)。若它截断,本插件判 `CONFLICT`、两侧都留、**不丢字节**——但会是一次人工冲突 | 与 rewind 一起补测(OQ-14) |
| 5 | **稳定窗口没有测量值。** 两次静置都发生在没有活跃写入者的时候;唯一的尾部观测是 Windows 那 165.9 秒 | quiet window 定太短 ⇒ 对端收到截断的组 | 现有设计已按观察判定(§9.1);要精确值需要专门的 5 秒粒度探测,列为 OQ-16 |
| 6 | **沙箱的 13/14 个文件不是 Grok 的真实文件集。** 真实库里还有 `resources_state.json`(mac 9/22、win 7/11)、`terminal`、`compaction*`、`plan*`、`web_fetch`——**一个都没进过生命周期快照** | 白名单会静默漏掉它们 | **这是刻意的**:见下「不采纳的建议」 |
| 7 | **`$GROK_HOME` 顶层从未进快照**(`session_search.sqlite`、`active_sessions.json`(2 B)、`worktrees.db`、HOME 级锁)。「`session_search.sqlite` 是缓存不是门槛」这条结论只有口述实验支撑,`state.json` 里 grep 不到它 | 若索引真的参与某种解析,同步来的会话可能要等某次刷新才可见 | 下一轮把快照根上移一层(凭证文件仍在黑名单里)。`active_sessions.json` 尤其可疑——2 字节、HOME 级,正好是「当前会话指针」的形状,可能就是上面那个「turn 落进别的会话」的机制 |
| 8 | **目录名编码规则在交付物里只有散文。** `state.json` 把两个平台的项目目录名都脱敏成同一个 `<encoded-path:4segs>`,机器可读的痕迹只有 `parentLooksUrlEncoded: true` 这个布尔 | 落位目录名算错 ⇒ 会话落在 CLI 不扫的地方(不可见);算得「差一点」(大小写、结尾分隔符、符号链接解不解)⇒ 同一个 cwd 分裂成两个项目目录 | 证据链现在是:两台机器的操作者各自口述「逐字节 EXACT」+ 开发机上 `encodeURIComponent(decodeURIComponent(name)) === name` 复核 + **Claudian 源码用的是同一个表达式**。下一轮把它记成字段而不是散文 |

### 不采纳的一条建议

评审建议「改成**目录整体同步 + 排除清单**,让未知成员默认跟着走」。**不采纳**,理由是
它与 §8.2 / ADR-33 / ADR-45 的白名单优先原则直接冲突,而那条原则是被实测事故换来的
(三种网盘冲突副本曾被拉进 CLI 目录)。更具体地说,「未知成员默认跟着走」在 Grok 身上
恰好有一个已知的反例:`announcement_state.json` 被证明是**机器/环境作用域**(同机两个
会话同 hash),把它带过去就是把 A 机的 MCP/skill 指纹移植进 B 机的会话目录。
代价是承认的:白名单会漏掉 `resources_state.json` 与 compaction/plan/terminal 家族,
它们在报告里表现为「不同步」而不是「未知文件」(因为我们从不推送它们)。

## 七之二、开发机补测(2026-08-24,grok 1.0.5,沙箱 `GROK_HOME`)

用户开发机上也装了 grok,趁机把第七节里最便宜的两项做掉。全程只**读**真实 `~/.grok`
(操作前后 `find -newermt` 复核无写入),对话副本用完即删。

| 问题 | 结果 |
|---|---|
| ⛔2 **G1 充分性(列表这一半)** | ✅ **成立**。把**只有 `summary.json` + `chat_history.jsonl`** 的会话目录放进一个全新 `GROK_HOME` 的正确项目目录 ⇒ `grok sessions list` **列出它**,且列出的 SESSION ID 与目录名逐字相同。缺 `system_prompt.txt`/`prompt_context.json`/`events.jsonl`/`title_refresh_idx` 全都不妨碍可见性 |
| 发现机制(第一节的加强证据) | ✅ 那次 `list` 跑完之后 `sessions/` 下**依然没有** `session_search.sqlite`——不是「先建索引再列」,是**根本没建就列出来了**。比探测里「拷进无索引的 HOME 仍被列出」更硬一档 |
| `grok export` 是否只读 | ✅ 真实会话目录的 (文件名,字节数) 指纹在 export 前后完全相同 |
| HOME 级副作用 | `list` 会在 `$GROK_HOME` 顶层新建 `active_sessions.json`(**2 字节**)、`active_sessions.lock`、`auth.json.lock`、`docs/`、`logs/`。都在 sessions 之外,**同步不碰** |

⚠️ **一条新发现,并且它抬高了 `updates.jsonl` 的地位**:本机这个会话**没有** `updates.jsonl`,
而 `grok export <id>` 对它报 **`Session not found`**——在真实 `GROK_HOME` 下也一样,
所以不是沙箱造成的。但同一个会话 `sessions list` **列得出来**。⇒ **`export` 与 `list`
走的是两条不同的解析路径**,而 export 那条对这个会话失败。最省事的解释是 export 依据
`updates.jsonl` 重建 transcript(与 Windows 侧「chat_history 从 updates.jsonl 派生重建」
的观察一致,且探测机上 export 成功的那些会话都有 `updates.jsonl`)——**未证实,记为假设**。

对实现的影响:本插件的同步集**本来就包含 `updates.jsonl`**(见 §九),所以方向是对的;
但这说明它不是「可有可无的装饰」。真机验收必须在对端跑一次 `grok export` 来确认
(剧本 §9.6 的 G4 已经这么写)。

**剩下的半边只能上真机**:resume 并续聊需要登录态,本机沙箱没有(按红线未复制任何凭证)。

## 八、rewind:未测

grok 1.0.5 **没有任何 headless rewind 入口**(`grok sessions` 只有 list/search/delete,
`sessions restore` 不存在,`--help` 无 rewind),TUI 不接受经 `script(1)`/pty 注入的
按键(双平台各两次尝试均挂起;macOS 上注入的按键落进输入框变成了普通 turn——顺带
再次验证了 `chat_history.jsonl` 的纯追加)。

**风险边界**:如果 rewind 是**截断** `chat_history.jsonl`,那它对本插件表现为一次
前缀违反 ⇒ 判 `CONFLICT`、两侧都进 `.quarantine/`、**不丢字节**(I1)。也就是说
未测项的最坏后果是「多一次人工冲突」,不是数据损坏。因此它**不阻塞** Grok 接入,
记为 OQ-14 待人工补测。

## 九、Tier 判定与发布闸门

**Grok = Tier A/R 混合(逐文件分级),可写,但打 `experimental` 标签、默认关闭。**

- 走 §7.2 追加表:`chat_history.jsonl`、`updates.jsonl`、`rewind_points.jsonl`
- 走 §7.2b opaque 表:`summary.json`(primary)
- `derived`(既不 push 也不 pull):`prompt_context.json`、`system_prompt.txt`、
  `events.jsonl`、`signals.json`、`title_refresh_idx` 及其余未列名者
- 永不同步:`*.lock`、`session_search.sqlite`、项目级 `prompt_history.jsonl` 与 `.cwd`

`system_prompt.txt` 被判 `derived` 有一条额外的强证据:双平台各 3 个副本、38 次采样
里它只有**一个** hash——被移走后 CLI 重建出的字节与原件**完全相同**,是可确定性重建
的文件。

**为什么是「可写 + experimental」而不是「只读」。** 本轮评审的建议是留在只读,理由是
第七节的 ⛔1(没有真两机往返)。采纳一半:

- 生命周期证据**够了**——这正是 §6.1「Tier A 候选」档位设计的场景,也正是 Codex 走过的
  路:2026-08-13 生命周期通过即接入并打 experimental,2026-08-15 两机验收通过才摘标签。
  同一条闸门,同一个顺序。
- 「往返不成立」的失败模式是**有界且可恢复**的:A 机的会话原封不动,B 机原本什么都没有,
  覆盖前一律有备份(I1)。表现是「B 机上什么都没发生」,不是丢数据。
- 真正需要防的那个失败模式不是往返,而是第三节那条(半落地的组污染别的会话)——它已经
  由三条硬规则挡住,并各有一个会红的测试(`grok-provider.test.ts`)。

**因此:`experimental` 标签的摘除条件 = 第七节的 ⛔1 与 ⛔2 都通过**(testing.md §9.6)。
在此之前,设置面板显示实验性标记,首次启用强制 dry-run 确认(§6.1 的长期行为)。

## 十、顺带回填(非 P6)

- **Codex 0.147.0 新行为**:SIGTERM 强杀后 `~/.codex/thread-writer-locks/<threadId>.lock`
  残留,**其后约 5–7 分钟内 resume 该线程被拒**(`thread-store conflict: … already has
  an active writer`),到期自动清理后纯追加续写。锁在 `sessions/` 之外,**不影响文件
  同步**;但对端拿到一个「刚被强杀」的会话时可能撞上这个错,等几分钟即可,不要去搬
  或删锁文件。rollout 本身双平台仍 **PREFIX_VIOLATION 0**,Tier A 不变。
- `session_index.jsonl` 在 0.146 时代就已存在(r1 双平台产物可查),0.147 不是新增
  索引;M4 验收已实证跨机 resume 可用,Codex 的 Tier A 判定不受影响。
- **Grok 每会话的文件集随版本与功能使用而变**:真实库普查里 `chat_history.jsonl`/
  `events.jsonl`/`prompt_context.json`/`summary.json`/`system_prompt.txt` 每会话必有,
  其余(`updates.jsonl` 11/22、`rewind_points.jsonl` 10/22、`signals.json` 8/22、
  `announcement_state.json` 9/22、`title_refresh_idx` 16/22、`resources_state.json`
  9/22、`terminal`/`compaction*`/`plan*`/`web_fetch` 更少)都是懒创建。
  **adapter 不能硬编码「必须有哪些文件」**,只能声明「认得哪些名字」。
- P3:vault 记录 103 条,`idsMissing` 25(约 24%,codex 19 / claude 6);
  **grok 15 条 `sessionId` 全部可用**。
