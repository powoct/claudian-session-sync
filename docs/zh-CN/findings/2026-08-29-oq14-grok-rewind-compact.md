# 2026-08-29 · OQ-14:Grok 的 rewind 与 `/compact` 就地重写历史——以及本插件会**静默撤销 rewind**

> 补测在 macOS、grok 1.0.5 `(5115b46bc909)`、沙箱 `GROK_HOME` 内完成。P6 时双平台各两次
> pty 注入 TUI 均挂起,所以这次由**用户本人在 TUI 里按键**,agent 只负责搭环境与测量。
> 4 张快照(r00 基线 → r01 rewind 后 → r02 再聊一轮 → r03 `/compact` 后),
> 每次 `snap` 之前都先 `quiet` 等到文件静止——OQ-17 已证明流式期间就地改写,
> 不等安静会把「出字过程」误当成 rewind。
>
> **本文最重要的结论不是 Grok 做了什么,而是本插件对它的反应**:
> 架构文档写了三个月的「风险已封顶 ⇒ 判 `CONFLICT`、不丢字节」是**错的**,
> 真实动作是 `PULL_OVERWRITE`——rewind 被悄悄撤销,而且**一句提示都没有**。

## 一、Grok 做了什么(实测)

会话 `01a04db3…`,5 轮对话。逐文件:

| 文件 | r00 基线 | r01 rewind 后 | r02 再聊一轮 | r03 `/compact` 后 | 判定 |
|---|---|---|---|---|---|
| `chat_history.jsonl` | 165,566 B / 69 行 | **159,924 / 53** | 161,841 / 59 | **21,699 / 5** | ❌ rewind 截断,compact 整份重写 |
| `rewind_points.jsonl` | 515 / 5 | **206 / 2** | 309 / 3 | 309 / 3 | ❌ 同样被截断(恰为 103 B/条) |
| `updates.jsonl` | 381,317 / 107 | 381,647 / 108 | 383,845 / 112 | 384,681 / 114 | ✅ **穿过 rewind 与 compact 全程严格追加** |
| `events.jsonl` | 77,914 / 853 | 78,709 / 857 | 82,646 / 896 | 83,441 / 900 | ✅ 全程严格追加(不同步) |
| `summary.json` | 722 | 722 | 722 | 721 | 每步整份重写(P6 已知:开 TUI 就重写) |
| `announcement_state.json` | 462 | 462 | 462 | **162** | compact 时缩短,小结漏记 |

- **会话 uuid 全程不变,没有新建会话目录**——rewind **不是** fork,是就地改写。
- **`/compact` 确实存在于 grok 1.0.5**,且与 Claude Code / Codex 的「新条目追加进同一文件」
  (OQ-8 / OQ-13)**不同**:它把 `chat_history.jsonl` 整份换成压缩视图,被压掉的内容搬进
  新建的 `compaction/segment_000.md`(134,668 B)。
- **`/compact` 让会话目录净增 38%**:639,141 B → 880,363 B(+241,222 B),
  其中 `compaction_requests/<uuid>.json` 一个就 220,616 B。小结只报了 `chat_history` 的 −87%,
  方向是反的——对同步而言 compact 让这个会话**变大**了。
- 其余 3 个沙箱会话全程 sha 与 mtime 逐字节未动(隔离性旁证);真实 `~/.grok` 会话数 32 → 32 不变。

## 二、⛔ 阻塞级:本插件会**静默撤销** rewind,不是判 `CONFLICT`

架构文档 §16 的 OQ-14 行原话是:

> **风险已封顶**:若是截断,对本插件表现为一次前缀违反 ⇒ 判 `CONFLICT`、两侧进 `.quarantine/`、不丢字节(I1)

**这个推理不成立。** 它把「同一台机器上文件的新旧两版」当成了插件比较的对象,
而插件从来不比这个——它比的是**本地当前版本 vs 同步目录里的版本**。rewind 之后:

- 本地 = rewind 后的 159,924 B
- 同步目录 = rewind 前推上去的 165,566 B
- 若 rewind 是**纯截断**,那么本地是远端的**严格前缀** ⇒ §7.2 #9 `r-extends-l` ⇒ **`PULL_OVERWRITE`**

**已在测试里端到端复现**(单机即可,连第二台机器都不需要——撤销 rewind 的是这台机器
自己早先推上去的那一份):

```
rewind 前 210B/6行  →  rewind 后 140B/4行  →  一次 pass 之后 210B/6行
用户看到的提示: （没有任何提示）

同一次 pass 的动作:
  PULL_OVERWRITE   remote-extends-local        chat_history.jsonl
  NOOP             e1-cache-hit                updates.jsonl
  PUSH_OVERWRITE   remote-at-converged-base    summary.json
```

三件事同时成立,每一件单独都够严重:

1. **rewind 被撤销**。字节没丢(`PULL_OVERWRITE` 前必定备份,I1 成立),但用户看到的是
   「我 rewind 了,过一会儿又变回去了」。
2. **一句提示都没有**。`replacedByPeer` 那句「N 条记录被对端版本替换」门控在
   `file.mode === "opaque-file"`(sync-engine.ts:667),而 `chat_history.jsonl` 是
   `append-jsonl` ⇒ 走不到。状态栏、报告、通知,全都不响。
3. **同一次 pass 里 group 朝两个方向写**。`summary.json` 走 §7.2b、命中 #4a
   `remote-at-converged-base` ⇒ **推**出 rewind 后的状态;`chat_history.jsonl` 走 §7.2 ⇒
   **拉**回 rewind 前的历史。终局是一个**两台机器都没有过的混合态**:
   元数据说「已 rewind」,历史却是没 rewind 的。

`/compact` 是同一个形状(161,841 → 21,699),`rewind_points.jsonl` 也是(515 → 206)。

### ✅ 前提已证实(2026-08-30 重测):**rewind 就是纯截断**

第二轮补测按 6c.6 的协议在 rewind **之前**留下了字节,`prefix-check` 给出字节级判定:

| 文件 | rewind 前 → 后 | 判定 |
|---|---|---|
| `chat_history.jsonl` | 44,968 → 39,790 B(41 → 25 行) | **PREFIX ✅** 新版 = 旧版前 39,790 字节切掉尾巴 |
| `rewind_points.jsonl` | 515 → 206 B(5 → 2 条) | **PREFIX ✅** 同上 |

**落在下表更严重的那一行。** 上一轮之所以判反,是因为只问了「旧版是不是新版的前缀」——
截断场景下那个方向永远是否,有决定意义的是反方向:**短的新版是不是长的旧版的前缀**。

**危险窗口有边界,r02 给出了它。** rewind 后再聊一轮:`chat_history.jsonl`
39,790 → 41,711 B(从截断处纯追加),此时与 rewind 前的旧版**互不为前缀**(旧版前 41,711
字节的 sha 与新版全文的 sha 不同)⇒ 退回 `CONFLICT`。**即静默撤销只发生在「rewind 完、还没说话」这段时间里的同步**。
常见用法——rewind 完立刻接着聊——只有几秒,pass 正好落进去的概率不高。
**但为「把刚才那段删掉」而 rewind、然后就关掉 CLI 的场景,这个窗口是无限长的**,
而那恰恰是 rewind 最要紧的用法:用户以为删掉了,下一次同步把它原样搬了回来。

⚠️ 一处仍未测:`rewind_points.jsonl` 在「rewind + 再聊一轮」后是 309 B,它是否仍是
rewind 前 515 B 那版的前缀**没有测**(按 103 B/条,新的第 3 条与旧的第 3 条是否逐字节相同
取决于记录里有没有时间戳/id)。若仍是前缀,那么即使过了危险窗口,这个文件也仍会被
`PULL_OVERWRITE` 悄悄改回去。**修复对两支都成立**(ADR-61 的判据是「跌破收敛基点」,
不是前缀关系),所以不阻塞;记下来是因为它说明「过了窗口就安全」这句话对逐个文件并不都成立。

**`/compact` 不是这个形态**:41,711 → 19,818 B,`prefix-check` 给出 **NOT A PREFIX ❌**
——它是「截断 + 整体改写」,两版互不为前缀 ⇒ 判 `CONFLICT`,即架构文档写的封顶形态。
compact 从来没有 `PULL_OVERWRITE` 风险,只有 rewind 有。

### 第一轮为什么没能定案(方法教训,值得留着)

第一轮(2026-08-29)只证到:r00 与 r01 的两级 64 KB checkpoint 逐个相同 ⇒ 前 131,072 字节
逐字节相同;r01 尾部还剩 28,852 字节(18.0%)没有任何覆盖。两支未分,而它们后果相反:

| rewind 的真实形态 | 关系 | 插件动作 | 后果 | 实测 |
|---|---|---|---|---|
| **纯截断** | 本地是远端前缀 | **`PULL_OVERWRITE`** | rewind 被静默撤销(已复现) | ✅ **就是这一支**(2026-08-30) |
| 截断 + 尾部重写 | 互不为前缀 | `CONFLICT` | 两侧进隔离,等人选 —— 文档所写的那个上限 | `/compact` 是这一支 |

两条方法教训:

1. **`snap` 只问了一个方向。** 它验的是「旧版是不是新版的严格前缀」——append-only 该问的那个。
   文件**变短**时这个方向恒为否,而有决定意义的是反方向。工具因此对 OQ-14 的核心事件
   只输出了一句「变短了」。已修:`SHRUNK` 现在报出「已证实相同 N 字节 / 其余 M 字节无从判定」,
   并新增 `prefix-check` 回答反方向。
2. **证据必须在破坏性操作之前留下。** 第一轮的 6c.0 备份拍在建会话之前,里面没有被测会话;
   rewind 一发生旧字节就没了,而 r01 的字节随后又被 r02、r03 覆盖两次——**回头补是补不上的**。
   已修:6c.1 末尾把 rewind 前的两个文件单独留一份,6c.6 靠它定案。

顺带:本轮 r00 的 `chat_history.jsonl` 只有 44,968 字节,**连一个 64 KB 分段都不到**,
所以这一轮 checkpoint 一个都没有——若没有 `prefix-check`,第二轮同样定不了案。

**怎么补上这一刀**:见 `tmp/probe-m2/AGENTS.md` 6c.6。要点是
**证据必须在 rewind 之前留下**——6c.0 的整目录备份是在 6c.1 建会话**之前**拍的,
里面没有被测会话;而 rewind 一旦发生旧字节就没了(本轮 r01 的字节已被 r02、r03 覆盖两次)。
协议:聊够 4 轮 → `quiet` → **把 `chat_history.jsonl` 拷一份到 `~/aiss-probe-m2/` 下** →
rewind → `quiet` → `prefix-check --file <拷贝> --bytes <rewind后size> --expect <rewind后sha>`。
10 分钟,复用现有会话即可,不必重跑整节。

## 三、`/compact` 之后对端拿到什么

白名单只带四个成员,所以 compact 后同步过去的是:压缩后的 `summary.json`、
5 行的 `chat_history.jsonl`、完整的 `updates.jsonl`、`rewind_points.jsonl`。
**380 KB 的 `compaction*` 家族一个字节都不走**,而且:

- 本地成员不在白名单里时是一句 `continue`,**不进报告、不出提示**——
  用户无从知道有东西留在了本机。
- `compaction/` 是**子目录**,而 Grok 的 `classifyNeutral` 要求恰好 3 段路径。
  (共享层本身支持更深:Codex 就是 5 段,path-safety 允许 8 段,replica 遍历是递归的,
  `targetPathFor` 已经原样展开所有段——挡住的只有 adapter 里那几行。)
- `updates.jsonl` **穿过 compact 仍是严格追加**(r02 是 r03 的字节前缀),
  所以被压掉的内容未必只存在于 `segment_000.md` 里。这一条削弱了
  「compact 会把历史锁在本机」的担心,但没有证据说 CLI 会拿 `updates.jsonl` 重建什么。

## 四、由此产生的待办

> **2026-08-30 更新**:第 1–3、5 项已随 ADR-61 完成(973 个用例,四条注入各自变红)。
> 修法与本文初稿开的方子**不同**——初稿说「账本 `sig.size` 现成可用」,那是死码,详见第 2 项。
> 实际改动:①§7.2 新增 #9a「跌破收敛基点 ⇒ `CONFLICT`」;②收敛基点扩到 append-jsonl
> (§7.2b 原文本就写着「含 append-jsonl 表的」,是代码没实现);③group 内有成员冲突时其余成员不许写
> (§7.1 P5,同样是既有规范未实现);④§9.1.6 标着「M1 必做」的 `PULL_OVERWRITE` 提示扩到全部合并模式。
> **第 4、6 项仍未做**,第三节的 `compaction*` 不同步也仍然只是记录在案。

| # | 事项 | 依据 |
|---|---|---|
| 1 | **改架构文档 §16 的 OQ-14 行**:删掉「风险已封顶 ⇒ CONFLICT」,换成本文第二节 | 该推理已被证伪 |
| 2 | **修 planner:本地变短且被远端包含时,不许快进** | ⚠️ **本行初稿说「账本 `sig.size` 现成可用、不需要新状态」——那是错的,已订正**:`signaturesEqual` 把 `size` 算进签名(stability.ts:93),文件一变短就判 `changed-since-last-pass` ⇒ 该轮走 `DEFER / side-unstable`(planner.ts:163)**并把账本刷成新的短 size**;等到下一轮真能走到 `r-extends-l` 时,`local.stable === true` 已经蕴含 `ledger.sig.size === local.size`——「变短过」这个信息此时必然已经没了。**所以信号必须活过「不稳定」那一轮**,只能来自一个不随每次观察移动的基点:**收敛基点的 size**(`LedgerEntryRecord.lastConvergedHash` 旁边加一个 size;它只在见证收敛时移动)。注意今天 `recordConverged` 只对 `opaque-file` 调用(sync-engine.ts:692),要用到 append 文件上得先把它扩过去 |
| 3 | **`append-jsonl` 的 `PULL_OVERWRITE` 也要出提示** | 现在门控在 `opaque-file`,历史被替换是完全静默的 |
| 4 | 改 Grok adapter 头注释与 §6 表里「严格追加」的说法 | 对 `chat_history.jsonl` 与 `rewind_points.jsonl` 已被证伪(限 rewind/compact;正常使用期间 P6 的结论仍成立) |
| 5 | 补一个「一侧变短但仍是另一侧前缀」的决策表用例 | 现有用例覆盖了截断末行、不稳定、零字节、发散,唯独没有这一类 |
| 6 | 记 compact 的 `compaction*` 不同步 + 用户无从知晓 | 第三节;是否要带它们是独立决策,倾向先不动白名单(ADR-33/45 的 fail-closed) |

## 五、探测套件本轮暴露的问题(已修)

| 问题 | 影响 | 处置 |
|---|---|---|
| `SHRUNK` 分支直接 `continue`,不做任何定位 | **OQ-14 存在的意义就是刻画这个事件,而工具对它的全部输出只有一句「变短了」**;「前 131,072 字节相同」是人工从快照里推出来的,不是工具报的 | 已改:变短时比对两侧 checkpoint 阶梯,报出「已证实相同 N 字节 / 其余 M 字节无从判定」 |
| 小于 64 KB 的文件被报成「该快照由旧版本工具生成、没有分段哈希」 | 归因完全错误(真实原因是文件小于分段粒度),会把读者引向「工具版本不对」 | 随上一条一并改掉 |
| 无法回答「短的新版是不是长的旧版的前缀」 | 正是本轮的决定性问题 | 新增 `prefix-check` 子命令(只输出一个哈希与一句判定,不输出任何内容) |
| `quiet --dir` 绕过了 `init` 的允许目录门禁 | 它每秒 stat 一遍整个目录、连跑几分钟,指向密钥目录就是反复读取(`id_rsa` 无扩展名,黑名单也挡不住) | 已加 `assertAllowedDir` |

未修、记录在案:零字节文件会让重命名启发式对该快照里每个新文件都命中
(两侧都是 `sha256("")`);报告的「违反」计数按「每个更早版本一条」累加,
一次 compact 就产生 3 条 `chat_history` SHRUNK,数字偏大。

## 六、隐私自检

`out/grok-oq14/` 全部 7 个产物逐一读过:只有相对路径、字节数、行数、sha256、mtime 与判定枚举;
无消息正文、无工具输出、无 `title`/`aiTitle`。`<HOME>`/`<USER>`/`<encoded-path:4segs>` 全部脱敏,
`.dir-raw` 已删(整个 `tmp/probe-m2` 树下无残留)。快照 JSON 的字段只有 10 个已知项。

两处轻微的、记录下来备查:小结第 5 行抄了探测自己用的测试语句
(`remember code ALPHA-1..5`)——严格讲是 R1 意义上的「消息正文」,但它是 agent 自己造的
无意义串,属于方法描述;`title_refresh_idx` 只有 1 字节,发布它的 sha256 等于发布内容本身
(实测就是 `sha256("0")`/`sha256("1")`),这次泄漏的只是一个刷新计数器的数字,
但对**任何 1 字节文件**这条都成立,以后要注意。
