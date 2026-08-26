# 2026-08-26 · Grok 真机验收(九步,Mac ↔ Windows)

> 原始记录在验收机器带回的 `tmp/acceptance/out_r4/`(两份 record + 双机各 8–13 张快照),不入库。
> 本文是脱敏摘要。剧本:[testing.md §9.6](../testing.md);判定依据:
> [findings/2026-08-24-grok-probe.md](./2026-08-24-grok-probe.md)、架构文档 §6.6.1、ADR-52…54。
>
> 这一轮的目的只有一个:P6 证明了 Grok **能**同步,但**没有一个字节真的在两台机器之间走过**。
> 本轮补上的就是那件事。

## 环境

| 项 | 机器 A | 机器 B |
|---|---|---|
| OS | macOS 26.5.2 | Windows 11(10.0.26200) |
| grok | 1.0.5 (5115b46bc909) | 1.0.5 (5115b46bc9) |
| Claudian | 2.2.4 | 2.2.4 |
| 插件 | 0.1.0,`main.js` 归一化 sha256 `8e4295cc…`(同一构建) | 同 |
| 同步工具 | Dropbox 267.4.3466 | Dropbox 268.4.4072 |
| workspaceId | 两台相同 ✓ | machineId 两台不同 ✓ |

## 判定

| 步 | 内容 | 结果 |
|---|---|---|
| G1 | A 推送,同步集**恰好** 4 个文件 | ✅ |
| G2 | B 落地,四个 sha256 逐字一致,`info.id` == 目录名 | ✅ |
| G3 | B `grok sessions list` 认得(**G1 充分性的一半**) | ✅ |
| **G4** | **B `--resume` 历史完整** | ✅ 模型准确复述 A 机聊过的两个暗号 |
| G5 | B 续写推送,`summary.json` 走 `remote-at-converged-base` 不是 CONFLICT | ✅ |
| G6 | A 拉回、快进、备份齐全,resume 看得到 B 那两轮 | ✅ |
| **G7** | **反方向(B 起 → A 落地 → A resume)整套重跑** | ✅ |
| **G8** | 半落地:`primary-not-in-replica`,**零文件落地、目录未创建** | ✅ |
| G9 | 分叉 → CONFLICT → 隔离 → 解决收敛 | 🟡 引擎侧全成立;**面板侧有缺陷(F-4)**,已修 |

**核心断言(G4/G7)双向通过 ⇒ OQ-15 关闭:Grok 跨机 resume 成立。**
**G8 通过 ⇒ 最危险的那条路径(半落地 → turn 落进别的会话)被挡住了。**

零字节丢失:B 机 `evidence.mjs check` 两个区间全 ✓;A 机报的一条 unreachable 已查明是
**执行验收的那个 Claude Code 会话自己的记录文件**(从 9.3 MB 长到 79 MB 并被压缩重写),
它从未被本插件同步(ADR-47 未准入)——取证副作用,非缺陷。

## 五条发现

### F-1 · 首次启用没有强制 dry-run(**已修**)

§6.1 与 README 都承诺「首次启用强制 dry-run 确认」,**它从来没有被实现过**——`setProvider`
只是写 binding。实测后果具体:打开 Grok 开关的一瞬间,A 的 8 个、B 的 6 个历史 Grok 会话
(共 56 个文件)被纳入同步范围,用户没有机会先看一眼。

修法:`ProviderBinding` 增加 `introducedAt`,首次启用后立刻跑一轮 **dry-run**(ADR-27:
dry-run 一个字节都不写)并在设置面板给出 Notice——「刚才那一轮列出了会被复制的东西,
现在还什么都没复制;打开 Show last sync report 看一眼,不对就把开关关掉」。
关掉再打开**不会**重复(闸门是关于「引入」而不是每次切换,否则会训练用户点掉它)。

### F-2 · 套件命令名写错(**已修**)

验收附录与 README 写的 `evidence.mjs init` 不存在,实际是 `config --vault`。文档错,已改。

### F-3 · `summary.json` 走了快进而不是 CONFLICT —— **设计内,非缺陷**

分叉恢复后 B 侧 `summary.json` 被 `PULL_OVERWRITE` 成 A 的版本,而三个 jsonl 正确判
`divergent-content`。验收人给出的机理分析成立,复核后采纳:

> Dropbox 在对账时把 A 的版本放回主路径、把 B 的版本改名成「冲突副本」。从 B 的引擎视角
> 看,本机 `summary.json` 自上次推送后**没有再变**(local == 本机记录的收敛基点),而 remote
> 变了 ⇒ §7.2b 的 `local-at-converged-base` 快进是自洽的。**引擎无从得知「remote 的这次变化
> 其实是同步工具丢弃了本机的推送」。**

这是一条值得记住的**同步工具交互**:**当同步工具用「保留一方 + 冲突副本」化解掉文件级
冲突时,落败那台机器上的 opaque 成员会跟着快进。** 数据安全不受影响——B 的版本同时在
①B 的备份区、②Dropbox 冲突副本里。剧本(§9.6 / 验收附录)对 G9 的期望已按此更正。

### F-4 · 冲突面板认不出是哪个文件(**高,已修**)★

**报告为「面板漏列一条冲突」,复核后是更简单也更糟的东西:面板一条都没漏,是三条长得一模一样。**

用测试复现:`describeConflict` 生成的标题是 `Session <id8> (<provider>)` ——**不含文件名**。
在 Grok 之前每个 provider 一个会话一个文件,所以「会话 id + provider」就是完整身份;Grok
一次分叉产生**每个成员一条**冲突,于是三条渲染成三个 `Session 01a03d22 (grok)`,连按钮都
一样。验收人解决了两条却无法确认解决的是哪两条,把剩下那条报成「面板里没有」。

修法:标题在**文件名不足以标识会话时**补上文件名 ⇒ `Session 01a03d22 · chat_history.jsonl (grok)`。
Claude Code 的 `<uuid>.jsonl`、Codex 的 `rollout-<ts>-<uuid>.jsonl`、Claudian 的
`conv-<id>.meta.json` 都自带 id,措辞一字不变;只有 Grok 这类会变。已注入验证。

### F-5 · 单机也会产生 CONFLICT —— 无数据风险,但暴露一个未测面

A 机在 Claudian UI 里对一个会话续聊一轮后,`chat_history.jsonl` 判了 `divergent-content`——
**全程只有一台机器写入**。成因:UI 那一轮刚落盘时第一轮 pass 就把一个**中间态**推进了
replica(19418 B / 15 行),而随后落定的版本是 20410 B / 18 行,两者**互不为前缀**。

复核排除了一种解释:**Claudian 不写这些文件**(源码里 `chat_history` 零命中,grok provider
下无任何 `writeFile`/`appendFile`),所以不是 UI 改写造成的。剩下的解释指向 CLI 本身——
**`chat_history.jsonl` 可能在一条消息流式生成期间就地改写末行**,只有在 turn 之间才是纯追加。
P6 的 38 张快照**全部取在 turn 之间**,这个面从未被测过。记为 **OQ-17**。

处置:插件的表现是安全的(判 CONFLICT、两分支入隔离、一次点击解决、零字节丢失);
顺带修掉冲突面板开场白里「Both machines added to these sessions separately」的断言语气——
它在单机场景下会把用户支去找一件没发生过的事。

**顺带结论**:同为 Grok 多文件 group 的冲突,这一条在 A 侧被面板正常列出并一次解决,
说明 F-4 触发的是「同一会话多条冲突同时存在」这个窄条件,与本条互为对照。

## 补测 · Claudian UI 跨机入口(疏通性)

方向:B 起的会话 → A 机 Claudian UI 续聊。手工把 B 的两个 `conv-*.json` 记录拷到 A 的 vault 后:
列表出现 → 历史完整 → UI 续聊成功 → **写入同一个会话目录**(未新建)→ 回传收敛。**通过。**

一条有用的观察:记录里 `providerState.sessionDirectory` 存的是 B 的绝对路径,
**Claudian 打开时会自动改写成本机路径**,不影响使用——这解释了为什么本插件不必、也不该
去碰记录里的机器相关路径(ADR-46 的「只取 id」)。

## 未做

**OQ-14(rewind / `/compact`)本轮未跑**,时间未及,不阻塞。

## 结论:摘掉 `experimental`

闸门是 §9.6 九步。G1–G8 全部通过且 **G4/G7 双向成立**;G9 的**引擎侧**全部成立
(三个成员正确判 CONFLICT、每组双分支入隔离、两侧原始字节未变、A 侧一次点击解决成功),
唯一的失败面是**面板认不出哪条是哪条**——UI 缺陷,已修并有会红的测试。

据此:**Grok 摘掉 `experimental`,保持默认关闭**(默认关闭是 ADR-39 的长期行为,与 Tier 无关)。

复验只需一件事,不必重跑九步:验收人**有意把 B 机那条 `chat_history.jsonl` 冲突留着没解**
(local `dd99708b` / replica `bcf70031`,两分支都在 `.quarantine/…/c6ee29a2a0866727/`)。
装上新构建后打开冲突面板,应当看到 **`Session 01a03d22 · chat_history.jsonl (grok)`**,
按钮可用,一次点击收敛、计数归零。
