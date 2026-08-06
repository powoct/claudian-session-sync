# 探测报告 · Windows

> 填写者：Kimi Code CLI（agent）　日期：2026-08-06　套件版本：aiss-probe/1
>
> 标注约定：✅ 已实测确认　⚠️ 未测 / 不确定（必须写原因）　❌ 实测结果与预期不符（写详细）
>
> 执行环境备注：agent 的 shell 是 Git Bash；凡是 AGENTS.md 标注"PowerShell"的步骤（T1 的 cd+claude 调用等），均按原文通过 `powershell -NoProfile -Command "..."` 执行，避免 Git Bash 规范化路径拼写导致样本失真。

## 0. 环境

| 项 | 值 |
|---|---|
| Windows 版本 / build | Windows_NT 10.0.26200（x64） |
| 架构 | x64 |
| Node 版本 | v24.18.0 |
| Claude Code 版本（及安装方式） | 2.1.223 (Claude Code)；原生 `claude.exe`，位于 `<HOME>\.local\bin\claude.exe`（非 .cmd wrapper、非 WSL）。探测中曾按用户许可降级 2.1.220 再装回 2.1.223（§2.5） |
| Codex 版本 | codex-cli 0.146.0 |
| 其他 agent CLI | opencode 1.18.11；grok 0.2.118 (1e1687c1cf) [stable]；pi 0.83.0；（另发现 `~/.gemini`、`~/.cursor` 目录，未见对应独立 CLI 版本输出） |
| 用户主目录（用户名已脱敏） | `C:\Users\<USER>` |
| 用户名是否含空格/非 ASCII | 否（5 字符、无空格、无点、无非 ASCII、无大写） |
| 卷文件系统（NTFS / ReFS） | C: NTFS、D: NTFS（`Get-Volume` 实测。machine-report 该项采集显示为 `DriveLetter FileSystemType\r`，是采集小瑕疵，以此处实测为准） |
| LongPathsEnabled 注册表值 | `0`（未开启；但 Node 实测 >260 路径可用，见 §8，二者并存值得注意） |
| 开发者模式（AllowDevelopmentWithoutDevLicense） | `1`（开启） |
| 是否在 WSL 里跑（应为否） | 否 ✅ |

自动产物：`out\machine-report.json`、`out\machine-report.md`

---

## 1. OQ-3 · 项目目录转义规则（阻塞 M1）

### 1.1 样本表

原始数据：`out\oq3-samples.json`

| 标签 | 输入路径（原样，用户名已替换为 `<USER>`） | 生成的目录名 | 备注 |
|---|---|---|---|
| plain | `C:\Users\<USER>\aiss-probe\plain` | `C--Users-<USER>-aiss-probe-plain` | 基准 |
| lower-drive | `c:\users\<USER>\aiss-probe\plain` | **未产生新目录**：会话落在已有 `C--Users-<USER>-aiss-probe-plain`（已核实该目录新增 1 个 jsonl） | ✅ 全小写拼写 → 同一目录名，大小写被归一化 |
| with-space | `C:\Users\<USER>\aiss-probe\with space` | `C--Users-<USER>-aiss-probe-with-space` | 空格 → `-` |
| with-dot | `C:\Users\<USER>\aiss-probe\my.vault` | `C--Users-<USER>-aiss-probe-my-vault` | ❌ `.` → `-`（与原生 `-` 不可区分） |
| with-cjk | `C:\Users\<USER>\aiss-probe\中文目录` | `C--Users-<USER>-aiss-probe-----` | ❌ 每个非 ASCII 字符 → 一个 `-`（4 个汉字 → `----`）；已核实磁盘上目录确为 `中文目录` 本名 |
| with-dash | `C:\Users\<USER>\aiss-probe\dash-in-name` | `C--Users-<USER>-aiss-probe-dash-in-name` | 原生 `-` 原样保留（与转义来的 `-` 无法区分） |
| other-drive | `D:\aiss-probe\plain` | `D--aiss-probe-plain` | 盘符规则一致 |
| unc（可选） | `\\localhost\c$\...` | ⚠️ 未测 | `\\localhost\c$\Users` 不可达（"找不到路径"），管理共享无权限；按指导书不再尝试、不改共享设置 |
| forward-slash（可选） | `C:/Users/<USER>/aiss-probe/plain` | **未产生新目录**：会话落在已有 `C--Users-<USER>-aiss-probe-plain`（已核实该目录新增 1 个 jsonl） | ✅ 正斜杠拼写被归一化，与反斜杠同名 |

### 1.2 规则总结

| 问题 | 结论 | 标注 |
|---|---|---|
| `\` → ? | `-` | ✅ |
| 盘符 `C:` → ?（冒号去哪了） | `C-`（冒号 → `-`），故 `C:\` → 前缀 `C--` | ✅ |
| 盘符大小写是否被归一化 | 是：`c:\...` 与 `C:\...` 派生同一目录名 | ✅ |
| 路径其余部分大小写是否被归一化 | 是（`lower-drive` 整条路径全小写仍派生出 `C--Users-<USER>-...`，与原拼写目录同名） | ✅ |
| `.` → ? | `-`（❌ 因此"目录名 → 路径"在数学上不可逆：`my.vault`、`my-vault`、`my vault` 三者撞名） | ✅ |
| 空格 → ? | `-` | ✅ |
| 中文 → ? | 每个非 ASCII 字符替换为一个 `-`（不保留、不百分号编码；❌ 不同的非 ASCII 目录名会互相撞名，且与同长度 `-` 串撞名） | ✅ |
| UNC 前导 `\\` → ? | ⚠️ 未测（无权限，见上） | ⚠️ |
| 正斜杠拼写是否产生不同目录名 | 否，与反斜杠拼写同名 | ✅ |
| 是否有长度截断或哈希后缀 | 未见：目录名就是逐字符映射结果，无截断、无哈希 | ✅（样本路径 ≤38 字符，超长路径未专项测） |
| 目录名总长度是否可能触碰 260 限制 | 可能：目录名长度 ≈ 路径长度（`C--` 多 1 字符），`~/.claude/projects/` 前缀约 30 字符，深度嵌套的工作目录有触限风险；本机实测 >260 路径可创建（Node 侧） | ⚠️ 推断 |

补充观察：会话目录里除 `<uuid>.jsonl` 外还会出现 `memory\` 子目录（2.1.223 行为）。

### 1.3 与 macOS 的对照（等价路径产生的目录名差异）

| 概念上的同一个 vault | macOS 目录名 | Windows 目录名 |
|---|---|---|
| `~/aiss-probe/oq1`（来自 mac Round 1 包的 `meta.json`，实测） | `-Users-<USER>-aiss-probe-oq1` | `C--Users-<USER>-aiss-probe-oq1` |
| `~/aiss-probe/plain` | ⚠️ 未直接采样（由上一条推断应为 `-Users-<USER>-aiss-probe-plain`） | `C--Users-<USER>-aiss-probe-plain` |

macOS 规则（由 mac 包实证）：前导 `/` → `-`，分隔符 `/` → `-`，与 Windows 同一套逐字符映射，只差盘符段。

### 1.4 实际执行的命令

每个标签一轮（示例为 `plain`；其余仅替换路径 / `--label` / `--path`）：

```bash
# ① 快照（Git Bash，套件目录下）
node probe.mjs projects-snapshot

# ② 建目录 + 最小会话（严格按 AGENTS.md §4.3 用 PowerShell 5.1 语法）
powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path 'C:\Users\<USER>\aiss-probe\plain' | Out-Null; Push-Location 'C:\Users\<USER>\aiss-probe\plain'; claude -p 'reply with the single word ok' | Out-Null; Pop-Location"

# ③ diff（--path 与 cd 进去的路径原样一致）
node probe.mjs projects-diff --label "plain" --path "C:\Users\<USER>\aiss-probe\plain"
```

`lower-drive` 轮次 `Push-Location 'c:\users\<USER>\aiss-probe\plain'`（全小写）；`forward-slash` 轮次 `Push-Location 'C:/Users/<USER>/aiss-probe/plain'`；`other-drive` 为 `D:\aiss-probe\plain`。

---

## 2. OQ-8 · session 生命周期是否严格 append-only（阻塞 M1，最重要）

自动产物：`out\lifecycle-report.md`、`out\lifecycle\`

### 2.1 总判定

| 项 | 结论 | 标注 |
|---|---|---|
| 全程严格 append-only？ | **是。16 个快照、覆盖新建/追加/resume/retry/compact/kill/fork/空会话/noop/跨版本，全部 `APPEND_ONLY_OK`，0 违反、0 删除、0 改名替换** | ✅ |
| 哪一步破坏了（若有） | 无。`/compact` 与 fork（回退分叉）也都是物理追加 | ✅ |
| 文件名是否恒等于 `sessionId` | 是（被跟踪文件始终为 `c62ae144-….jsonl`；fork 后文件末尾行的 `sessionId` 仍为原值；T0 对既有 3 个 jsonl 的核查也全部一致） | ✅ |
| 过程中是否出现新文件 | 被跟踪会话从未换文件。目录里出现过第二个 jsonl（`254175df-…`），那是 T3 另建的独立交互会话，非本会话裂变 | ✅ |
| 旧文件是否被删除 / 清空 / 重写 | 否（compact、fork、kill、跨版本均未动旧字节） | ✅ |
| 每次快照末尾是否总有换行 | **是，16/16 快照全部 `末尾换行 ✅`**（含强杀后的 07-after-kill） | ✅ |
| 行尾是 LF 还是 CRLF | LF（T0：`crlfLines: 0`；本测试文件同） | ✅ |
| 强杀之后末行是否残缺 | 本次未观察到半截行：kill -9 后 07 快照行数完整、末尾换行 ✅（单次样本，不能排除极端时序下半截写的可能，但本版本写入行相当小步快走） | ✅（单次样本） |
| 残缺末行是否影响 resume | 未出现残缺末行；强杀后 resume 正常、继续严格追加（08） | ✅ |

**附带重大发现（影响 OQ-1/OQ-5 的解释）**：用 `claude -p`（headless）创建的会话，其行内 `entrypoint` 为 `sdk-cli`，**在 `claude --resume` 的任何列表视图（本项目 / Ctrl+A 全项目）中都不出现**；但 `claude --resume <sessionId>` 按 ID 进入完全正常、历史完整。交互式会话（entrypoint 非 sdk-cli）正常出现在列表中。即：**列表不可见 ≠ 文件不存在或不可 resume**。

### 2.2 逐步结果

| 快照 | 操作 | size 变化 | 判定 | 备注 |
|---|---|---|---|---|
| 00-baseline | 首次会话后初始化 | c62ae144….jsonl = 23065B / 10 行 | APPEND_ONLY_OK | |
| 01-new-session | 新建会话补快照 | 未变 | APPEND_ONLY_OK | |
| 02-append-turns | `--resume` 连发 3 轮 | 23065→56084B（+33019） | APPEND_ONLY_OK | |
| 03-after-resume | 退出后重新 `--resume` 1 轮 | 56084→58242B（+2158） | APPEND_ONLY_OK | headless 每轮本就是新进程 |
| 04-append-after-resume | 再追加 2 轮 | 58242→62576B（+4334） | APPEND_ONLY_OK | |
| 05-after-compact | 交互式 `/compact` | 110208→141562B（+31354） | APPEND_ONLY_OK | 追加 `compact_boundary` + `isCompactSummary` + `compactMetadata` 各 1 行，未改写历史 |
| 05b-after-retry | headless 重发完全相同的 `"say ok again"` | 62576→77607B（+15031） | APPEND_ONLY_OK | **文件层面是"再追加一轮"，未见改写** |
| 06-append-after-compact | compact 后追加 2 轮 | 141562→156384B（+14822） | APPEND_ONLY_OK | |
| 07-after-kill | 强杀自起进程（pid 1412） | 77607→85187B（+7580） | APPEND_ONLY_OK | 杀前已写入部分保持完整前缀；末行完整 |
| 08-after-resume-from-kill | 杀后 resume 同一会话 | 85187→103808B（+18621） | APPEND_ONLY_OK | resume 正常，未报错 |
| 09-append-final | 再追加 2 轮 | 103808→110208B（+6400） | APPEND_ONLY_OK | |
| 10-cross-version-resume | 降级 2.1.220 后 resume 追加 1 轮 | 161218→177942B（+16724） | APPEND_ONLY_OK | 版本见 §2.5 |
| 10b-restored-2.1.223 | 装回 2.1.223 后再追加 1 轮 | 177942→193478B（+15536） | APPEND_ONLY_OK | （自加标签，验证恢复后仍正常） |
| 11-empty-session | 新会话不发消息直接 `/exit` | 未变（**未产生任何文件**） | APPEND_ONLY_OK | 见 §2.6 |
| 12-after-fork（**必做**） | 交互式回退到 `"say ok after compact"` 再发 `ok` | 156384→161218B（+4834） | APPEND_ONLY_OK | 见 §2.7（注：A3/A4/A5 连续操作，12 快照含 A4 状态，但 A4 未产生文件，无混淆） |
| 13-resume-noop（可选） | resume 打开列表直接退出 | 未变 | APPEND_ONLY_OK | |

强杀那一步实际杀掉的 pid（证明只杀了自己起的那一个）：`1412`（Git Bash 起 `claude -p --resume …` 后台进程，`$!` 捕获，`kill -9 1412`，`wait` 退出状态 137）

### 2.3 `/compact` 细节

- 执行方式（交互 / headless / 未执行）：交互 —— 用户 `claude --resume c62ae144-…` 进入后 `/compact`，成功完成
- 执行后原文件发生了什么：+31354B **严格追加**；文件内新增 `compact_boundary`（subtype）、`isCompactSummary`、`compactMetadata` 各 1 行；旧字节零改动
- 是否产生新文件、新 sessionId：否（被跟踪会话）
- resume 之后看到的历史是完整的还是压缩后的：文件层面完整保留（前缀校验 ✅）；UI 层面 compact 后的 fork 步骤能回退到 compact 之后的 `"say ok after compact"` 消息，compact 本身未造成文件层面任何可见性损失；⚠️ 未逐项核对 UI 是否以摘要替代旧消息显示（文件证据已足够支撑 append-only 结论）

### 2.4 retry 同一条消息（05b）

| 观察点 | 结果 | 标注 |
|---|---|---|
| retry 的触发方式 | headless：把完全相同的一句 `claude -p --resume "$SID" "say ok again"` 再发一次 | ✅ |
| 是"再追加一轮"还是"改写了上一轮的 assistant 回复" | **再追加一轮**（文件 +15031B，严格前缀保持） | ✅ |
| 是否报 `PREFIX_VIOLATION`；若是，`firstDiffOffset` 是多少 | 否 | ✅ |
| 是否产生新文件 / 新 sessionId | 否 | ✅ |

### 2.5 跨版本 resume（10）

| 观察点 | 结果 | 标注 |
|---|---|---|
| 升级/降级前的 `claude --version` | 2.1.223 (Claude Code) | ✅ |
| 升级/降级后的 `claude --version` | 2.1.220 (Claude Code)（`claude install 2.1.220`，经用户同意；测后 `claude install 2.1.223` 装回原版本并核实） | ✅ |
| 换版本后 resume 是否还能看到完整历史 | 能：2.1.220 headless resume 成功并正常对话（+16724B）；装回 2.1.223 后同样（+15536B） | ✅ |
| 换版本后文件是否仍是严格追加（有无 `PREFIX_VIOLATION`） | 是，两次均 `APPEND_ONLY_OK` | ✅ |
| 新版本写入的行，顶层 key / `version` 字段有无变化 | `version` 字段逐行记录写入方版本：文件末 40 行中 `2.1.223`×15、`2.1.220`×6 **混存**；顶层 key 集合未见结构性删减（跨版本写入兼容） | ✅ |
| 未测的原因 | —（已测；升降级经用户明确同意，并已恢复原版本） | |

### 2.6 空会话（11 · 新建会话不发消息直接退出）

| 观察点 | 结果 | 标注 |
|---|---|---|
| 是否生成了 jsonl 文件 | **否**。交互式 `claude` 启动后一句话不发直接 `/exit`，目录文件数不变（2→2），无任何新文件 | ✅ |
| 文件大小 / 行数 | 无文件 | ✅ |
| 末尾有没有换行 | 无文件 | — |
| 它会不会出现在 `claude --resume` 列表里 | 无文件可列（用户未报告列表出现空条目） | ✅ |
| 对同步逻辑的含义 | 空会话不落盘，同步侧无需担心"0 字节空文件覆盖真文件"的情形（0 字节文件只会来自异物，见 §3，CLI 也不理它） | ✅ |

### 2.7 fork（12 · 必做）

| 观察点 | 结果 | 标注 |
|---|---|---|
| 本版本的分叉入口是什么 | 交互式 resume（按 ID 进入）后回退到历史消息继续发送（用户实操：回退到 `"say ok after compact"` 发 `ok`，成功）。`claude --help` 无 `rewind`/`fork` 命令行入口（`--fork-session` 仅 resume 时换新 id） | ✅ |
| 分叉后是改写原文件，还是新开一个文件 | **都不是**：在原文件末尾追加（+4834B）。无新文件、sessionId 不变 | ❌ 与"fork 会改写或裂变"的预期不符（对同步是好消息） |
| 是否报 `PREFIX_VIOLATION`；`firstDiffOffset` / `oldSize` / `newSize` 各是多少 | 否；oldSize=156384，newSize=161218 | ✅ |
| 逻辑上如何表达分叉 | 追加的新轮次带 `logicalParentUuid`（×1）指向历史中间的逻辑父节点；**逻辑分叉、物理追加**。本文件未见 `retractedMessageUuids`/`supersedesUuids`（这两个 key 在 T0 的既有大会话语料中存在） | ✅ |
| 若未测 | —（已测） | |

---

## 3. OQ-5 · 会话目录里的异物文件（阻塞 M1）

放置目录：`<HOME>\.claude\projects\C--Users-<USER>-aiss-probe-lifecycle`；放置记录：`out\oq5-planted.json`。
测试分两轮（第一轮发现列表空转与异物无关 —— 是 §2.1 的 headless 不可见现象；第二轮在目录里有一个**可见的交互会话**时复核，并把 `aiss-probe-x.conflict.jsonl` 的内容换成该交互会话的副本以排除混淆）：

| 放置的文件 | 是否出现在会话列表 | CLI 是否报错 | 文件是否被改动/删除 |
|---|---|---|---|
| `aiss-probe-x.conflict` | 否 | 无 | 否（两轮放置前后大小/mtime 逐项一致） |
| `aiss-probe-x.bak` | 否 | 无 | 否 |
| `aiss-probe-x.jsonl.bak` | 否 | 无 | 否 |
| `aiss-probe-x.jsonl.tmp` | 否 | 无 | 否 |
| `aiss-probe-zero.jsonl`（0 字节） | 否（不列、不报错、**不被自动删除**） | 无 | 否 |
| `aiss-probe-x.conflict.jsonl` | 否（内容=headless 会话副本、内容=交互会话副本两轮均不列；列表只显示原交互会话一个条目） | 无 | 否 |

错误信息原文（如有）：

```
（无）
```

结论：隔离副本可以放在 session 目录里吗？ **可以**。picker 只列 uuid 命名且非 headless 的 `.jsonl`；非 uuid 命名的副本（含 `.jsonl` 后缀的伪造副本）与 0 字节文件均不显示、不报错、不被改动。⚠️ 变体未测：uuid 形状文件名 + 他人内容的 `.jsonl`（理论上有撞 sessionId 的风险，同步工具应避免这种命名）。

清理是否已执行：☑ 是（两轮 `oq5-clean`，`ls` 核实原有 jsonl 一个不少）

---

## 4. OQ-1 · 跨平台 resume（阻塞 M1）

### 4.1 Round 1（本机产包）

| 项 | 值 |
|---|---|
| 工作目录 | `C:\Users\<USER>\aiss-probe\oq1` |
| 项目目录名 | `C--Users-<USER>-aiss-probe-oq1` |
| session 文件名 | `5b0fab1e-e498-4f90-b630-d3dcfe30af30.jsonl` |
| sha256 | `98d7894691735cf238722c2b2f5035ec4ccae2d63a39a758149a25d694fb6f3f` |
| 行数 | 22 |
| 末尾换行 | 是 |
| `cwd` 值 | `C:\Users\<USER>\aiss-probe\oq1`（脱敏版；全部行同一值） |
| `gitBranch` / `version` 值 | `HEAD` / `2.1.223` |
| 包已交付给 macOS 机器 | ☑（用户已拷贝至 mac 并改名 `oq1-package-in`；**含真实 jsonl，不进报告、不外发**） |

补充：来源平台 win32 / 10.0.26200，Claude 2.1.223。打包产物刻意不在 `out\` 里（R8）。

### 4.2 Round 2（落地来自 macOS 的会话）

包信息：sourcePlatform `darwin`（25.5.0），Claude `2.1.223`，session `9d47f4f2-6d23-40b2-b38a-c9d18107c00d.jsonl`（15320B / 20 行 / sha256 `16856460…bc750`），落地目录 `C--Users-<USER>-aiss-probe-oq1`（本机该目录由 Round 1 已建出，落地未覆盖任何已有文件）。

| 观察点 | 结果 | 标注 |
|---|---|---|
| 落地后 sha256 一致 | ✅ `sha256Match: true` | ✅ |
| 会话出现在 `claude --resume` 列表 | 未出现 —— **符合 §2.1 预期**（会话为 headless `sdk-cli` 来源，任何列表视图都不显示），不是落地失败 | ✅（预期内） |
| 历史完整可见（轮数对得上） | ✅ 用户按 ID `claude --resume 9d47f4f2-…` 进入，mac 侧全部 ok 轮次完整可见 | ✅ |
| 能继续对话 | ✅ 续发 `ok` 得到回复 | ✅ |
| 有无路径 / `cwd` 相关警告（`cwd` 是 `/Users/...` 这种 POSIX 路径） | 无报错/警告（用户操作全程无异常提示） | ✅ |
| 续聊后 `cwd` 字段是否同时出现两台机器的路径 | ✅ 是：`/Users/<USER>/aiss-probe/oq1`（mac 旧行）与 `C:\Users\<USER>\aiss-probe\oq1`（Windows 新行）共存 | ✅ |
| 续聊后文件仍是严格追加 | ✅ 15320B→37506B，前 15320 字节 sha256 与落地时完全一致 | ✅ |
| 续聊后行尾是否混入 CRLF | 否，CRLF 行数=0（Windows 侧继续写 LF），末尾换行 ✅ | ✅ |

错误信息原文（如有）：

```
（无）
```

**结论**：`cwd` 等绝对路径字段**不影响**跨平台 resume —— ✅ OQ-1 通过：mac 产生的会话文件原样落到 Windows 对应项目目录，按 ID resume 历史完整、可续聊，续聊严格追加、行尾仍 LF。`cwd`/POSIX 路径只是元数据。**唯一注意事项**：headless 来源的会话不进 picker 列表（§2.1），同步工具的用户引导应使用「按 ID resume」。

---

## 5. OQ-4 · 网盘按需文件占位符（仅 Windows）

自动产物：`out\oq4-placeholder.json`（三次观测已累积）。测试文件：`%USERPROFILE%\OneDrive\aiss-probe-test.txt`（内容 4 字节）。

| 观察点 | 在线可用时 | 释放空间后 | 读取之后 |
|---|---|---|---|
| `stat.size` | 4 | 4（占位符不影响 stat） | 4 |
| `attributesRaw`（十进制） | 1056（0x420） | **5248544**（0x501420） | 1056（0x420） |
| `attributes` 位 | ARCHIVE + REPARSE_POINT | ARCHIVE + SPARSE_FILE + REPARSE_POINT + **OFFLINE** + **UNPINNED** + **RECALL_ON_DATA_ACCESS** | ARCHIVE + REPARSE_POINT（占位标记全部消失 = 已被水合） |
| `attrib` 命令输出 | `A` | `A      O      U` | `A` |
| 读前 4KB 是否成功 | 成功 | 成功 | 成功 |
| `firstReadMs` | 0 | **862**（水合延迟，本网络下 4KB） | 0 |

| 问题 | 结论 |
|---|---|
| 用哪一位能可靠判定"未下载的占位符" | **OFFLINE（0x1000）+ RECALL_ON_DATA_ACCESS（0x400000）**（伴随 SPARSE_FILE / UNPINNED）。❌ REPARSE_POINT **不能**用 —— 该文件水合状态下也始终带 REPARSE_POINT（OneDrive 占位机制常态），只靠它会把正常文件误判成占位符 |
| 读取占位符会阻塞多久 / 会报错吗 | 不报错；首次读 862ms（触发水合），读完占位标记消失、再读 0ms |
| 断网状态下读取占位符会怎样（若测了） | 未测 |
| 对**目录**设置释放空间时，`readdir` 是否正常 | OneDrive 根目录属性 raw=1073（DIRECTORY+ARCHIVE+REPARSE_POINT，`attrib` = `A R`）；`ls` 列举正常（本次只对文件做了释放，目录仅观测属性） |
| 用的是 OneDrive 还是 Dropbox | OneDrive |

测试文件是否已恢复"始终保留在此设备"：☐ 是（已请用户恢复，待确认）

---

## 5b. OQ-9 · junction / 8.3 短名（阻塞 M1，仅 Windows）

自动产物：`out\oq9-links.json`（`node probe.mjs win-links`，全部在 `%USERPROFILE%\aiss-probe\links\` 沙箱）

### 5b.1 junction 行为

| 观察点 | `cmd /c mklink /J` 造的 | `fs.symlinkSync(target, s, "junction")` 造的 |
|---|---|---|
| 创建是否成功 | ✅ | ✅ |
| `lstat().isSymbolicLink()` | **true** | **true** |
| `lstat().isDirectory()` | **false**（lstat 不跟随链接；size=84） | **false**（size=84） |
| `readlink()` 是否可用 | 可用，返回目标路径 `<HOME>\aiss-probe\links\aiss-probe-link-target-…` | 可用，返回目标路径 |
| `realpath()` 结果 | ❌ **展开成目标路径**（链接路径丢失） | ❌ **展开成目标路径** |
| PowerShell `(Get-Item -Force).LinkType` | `Junction` | `Junction` |
| PowerShell `(Get-Item -Force).Target` | 目标路径 | 目标路径 |

### 5b.2 8.3 短名

| 观察点 | 结果 | 标注 |
|---|---|---|
| `dir /x` 里是否有 8.3 短名 | **有**（C 卷开启了 8dot3name）：`AISS-P~1`（目标目录）、`AISS-P~2` / `AISS-P~3`（两个 junction） | ✅ |
| 短名是什么 | `AISS-P~1` ↔ `aiss-probe-link-target-with-a-deliberately-long-name` | ✅ |
| 对短名路径跑 `realpath` 是否**展开成长名** | ❌ **不展开**：`realpath("<HOME>\aiss-probe\links\AISS-P~1")` 返回 `…\AISS-P~1` 原样 | ✅ |
| 短名路径 `stat` 是否正常 | 正常 | ✅ |
| `fsutil 8dot3name query C:` 的结果 | ⚠️ 未跑成：`错误 5: 拒绝访问`（需提权，按 §14 不做）；`dir /x` 已直接证明短名存在 | ⚠️ |

### 5b.3 结论

| 问题 | 结论 | 标注 |
|---|---|---|
| vault 若位于 junction 之下，两台机器会不会派生出**不同的**项目目录名 | 会。`realpath` 会把 junction 展开成目标路径：若 CLI（或同步工具）用 realpath，派生名取决于目标路径；若用 cwd 字符串，则取决于 junction 路径 —— 两种口径在两台机器上只要有一处不一致就派生出不同目录名 | ✅（基于 5b.1 实测推断） |
| cwd 以短名形式传给 CLI 时，会不会派生出**第三个**目录名 | 会。短名不展开（`AISS-P~1` ≠ `aiss-probe-…`），转义后是另一个完全不同的目录名 | ✅ |
| 同步工具能否把"路径字符串"直接当会话身份 | **不能**。同一目录在 Windows 上至少有：长名 / 8.3 短名 / junction 路径 / junction 目标路径，最多四种字符串写法，且 realpath 行为对两者不一致 | ✅ |

清理：☑ 两个 junction 已由脚本用 `rmdir` 删除（**未**用 `rm -rf` / `Remove-Item -Recurse`）；目标目录 `aiss-probe-link-target-…` 保留，留待 §13 整体清理

---

## 6. OQ-2 · Codex（M2）

| 项 | 结论 |
|---|---|
| Codex 是否安装 / 版本 | ✅ codex-cli 0.146.0 |
| Codex home 路径 | `<HOME>\.codex` |
| `sessions\` 是否存在、分层结构 | ✅ 存在；按 `YYYY\MM\DD\` 三层目录分层（本机 14 个目录 / 23 个文件，最大深度 4） |
| rollout 文件名模式 | `rollout-<ISO时间戳，如 2026-08-06T16-51-11>-<uuid>.jsonl`；文件名 uuid = 会话 id（`codex exec` 打印的 session id 与落地文件名一致） |
| rollout jsonl 的顶层 key | `timestamp` / `type` / `payload`（type 分布示例：`session_meta`、`event_msg`、`response_item`、`world_state`、`turn_context`） |
| sqlite 文件清单（含 -wal/-shm） | `state_5.sqlite`（+wal/shm）、`logs_2.sqlite`（+wal/shm，112MB，名字匹配 logs* 按红线跳过未读 schema）、`goals_1.sqlite`（+wal/shm）、`memories_1.sqlite`（+wal/shm）；另有 `sqlite\` 目录 |
| `threads` 表列 | `id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at, git_sha, git_branch, git_origin_url, cli_version, first_user_message, agent_nickname, agent_role, memory_mode, model, reasoning_effort, agent_path, created_at_ms, updated_at_ms, thread_source, preview, recency_at, recency_at_ms, history_mode, name, is_pinned, thread_section_id`（另有触发器维护 `*_at_ms` 列） |
| 哪些列是绝对路径 | `rollout_path`、`cwd` |
| 是否有 `session_index.jsonl` 等非 sqlite 索引 | 有 `<HOME>\.codex\session_index.jsonl`（411B / 3 行，形状 `{id, thread_name, updated_at}`）。**但 `codex exec` 新会话后该文件未变（mtime 仍为 2026-07-18），`threads` 表 23→24** —— 本版本（0.146.0）新会话只写 sqlite，`session_index.jsonl` 疑似旧版遗留索引 | 
| **只拷 rollout 文件、不动 sqlite → 能否在 resume 列表里看到** | ✅ **能**。把 rollout 复制为同目录新文件名（uuid 末位改动，两个索引都未动）后，`codex resume --all --include-non-interactive` 列表里出现**两个**相同标题的会话（用户实测）。且打开 picker 后：`threads` 行数不变（24）、副本 sha256 与源一致 —— 发现靠**扫目录即时解析**，picker 不把副本回写进 sqlite |
| 有无官方 import / reindex 命令 | 未见。子命令清单：`exec / review / login / logout / mcp / plugin / mcp-server / app-server / remote-control / app / completion / update / doctor / sandbox / debug / apply / resume / archive / delete / unarchive / fork / cloud / exec-server / features / help`；`debug` 下仅 `models / app-server / prompt-input`，无 reindex/import |

补充：
- 第 2 层（往 `session_index.jsonl` 追加一行）**未执行**：第 1 层已能被列表发现，按实验决策树无需再做；用户已口头同意，同意未被动用。`session_index.jsonl` 全程零改动。
- 新会话落到 `sessions\2026\08\06\rollout-2026-08-06T16-51-11-019fd60e-…a079.jsonl`（63372B）。
- rollout append-only 专项（lifecycle-snapshot 对日期目录跑一轮）：⚠️ 未测 —— lifecycle 工具同时只能跟踪一个目录，本机额度被 T2 占用；codex 侧从 picker 行为与文件结构（jsonl、时间戳命名、末行换行 ✅）推断为追加模型，但未做逐步前缀校验。
- `codex exec` 在探测目录需要 `--skip-git-repo-check`（非 git 目录会被拒）。

复制出来的测试文件是否已删除：☑ 是（删了：`…\sessions\2026\08\06\rollout-2026-08-06T16-51-12-019fd60e-0629-7a30-aa81-63ef9551a080.jsonl`，经用户逐个确认后按完整路径删除，删后目录仅剩源文件 a079）

---

## 7. OQ-6 · 其他 provider（M2/M3）

### OpenCode

| 项 | 值 |
|---|---|
| 是否安装 / 版本 | ✅ 1.18.11 |
| 存储根 | `<HOME>\.local\share\opencode`（数据）；`<HOME>\.opencode`（安装/插件）；`<HOME>\AppData\Roaming\opencode`（空） |
| 一个会话由哪些文件构成 | 不是文件：会话在 sqlite `opencode.db`（+wal/shm）的 `message`/`session` 等表里；另有 `snapshot\` 下 git 裸仓（每项目）存快照 |
| logicalId 来源 | DB 主键（`session.id` 之类；session 表 schema 未完整导出，仅采到建表语句前缀） |
| 是否 append-only | 否（sqlite 行更新模型，非追加文件） |
| 是否有外部索引 | 本体就是 sqlite；不存在"文件不进索引"的形态 |
| 是否含绝对路径字段 | 是：`project.worktree`、`project_directory.directory`、`workspace.directory` |
| resume 命令 | `opencode --continue` / `opencode --session <id>`（`--fork` 可分叉；另有 `opencode export/import [sessionID]` 官方导出导入） |

### Grok CLI

| 项 | 值 |
|---|---|
| 是否安装 / 版本 | ✅ grok 0.2.118 (1e1687c1cf) [stable] |
| 存储根 | `<HOME>\.grok` |
| 一个会话由哪些文件构成 | `sessions\<uuid>\` 目录下多文件：`chat_history.jsonl`、`events.jsonl`、`updates.jsonl`、`rewind_points.jsonl`、`summary.json`、`prompt_context.json`、`system_prompt.txt`（伴生 `.lock`） |
| logicalId 来源 | 目录名 uuid |
| 是否 append-only | ⚠️ 主历史是 jsonl（`chat_history.jsonl`），追加性未实测；`summary.json` 等明显是整体重写 |
| 是否有外部索引 | 有：`sessions\session_search.sqlite`（FTS5：`session_docs` + 触发器）。不进索引是否就看不见会话：⚠️ 未测 |
| 是否含绝对路径字段 | 是：`session_docs.cwd`（NOT NULL） |
| resume 命令 | `grok --continue` / `grok --resume`（`--fork-session` 分叉） |

### Pi agent

| 项 | 值 |
|---|---|
| 是否安装 / 版本 | ✅ 0.83.0 |
| 存储根 | `<HOME>\.pi\agent` |
| 一个会话由哪些文件构成 | 单个 jsonl：`sessions\<转义cwd>\<ISO时间戳>_<uuid>.jsonl`（例：`--C--Users-<USER>-OneDrive-…--\2026-07-25T11-40-24-947Z_….jsonl`） |
| logicalId 来源 | 文件名 uuid 段（行内 `id` 字段另有逐条目 id；首行 `type:"session"` 带 `version:3`） |
| 是否 append-only | ⚠️ 形状是 jsonl、行内 `parentId` 链；追加性未实测（仅 1 个样本文件） |
| 是否有外部索引 | 未见（`agent\` 下仅 `auth.json`、`models.json`、`settings.json`、`sessions\`、`bin\`） |
| 是否含绝对路径字段 | 是：首行 `cwd` |
| resume 命令 | `pi --continue` / `pi --resume` / `pi --session <path\|id>` / `pi --fork <path\|id>` |

备注：pi 的项目目录转义是 `--C--Users-<USER>-…--`（双横线包裹），与 Claude Code 的单 `-` 映射不同，是另一套规则。

---

## 8. 文件系统事实（Windows 关键项）

| 事实 | 值 | 是否符合预期 |
|---|---|---|
| mtime 粒度 | 987.7us（≈1ms；300 次突发写入只出现 39 个不同时间戳） | ✅ NTFS 预期 |
| mtimeMs 是否有小数 | true | ✅ |
| 大小写敏感 | false（`readViaOtherCase` 成功，双写只留 1 个条目） | ✅ |
| Unicode 规范化不敏感 | **false**：NFC 与 NFD 是两个并存条目（`café-a.txt` 与 `café-b.txt` 同时存在） | ✅（与 macOS 相反，跨平台同步文件名需自行归一化） |
| readdir 返回 NFC 还是 NFD | 原样返回（创建时是什么就返回什么，无归一化） | ✅ |
| 目录 fsync 是否可用 | 不可用：`EPERM: operation not permitted, fsync` | ✅ 预期失败（Windows 不支持目录 fsync） |
| 能否创建 symlink | 能（开发者模式已开） | ✅ |
| >260 字符路径可用 | true（Node 侧；尽管注册表 LongPathsEnabled=0，Node 自身 manifest 声明了 longPathAware） | ❌ 与"注册表=0"的朴素预期不符，已如实记录 |
| 各长度点结果（180/250/259/268/300/400） | 全部 `ok:true`、`cleaned:true` | ✅ |
| 长路径清理是否成功 | 是 | ✅ |
| **rename 覆盖被自身打开的文件** | ❌ 失败：`EPERM`（读、追加两种打开方式都失败）——Windows 上不能原子替换被自己持有的文件 | ✅ 符合 Windows 预期 |
| 旧句柄写入是否进入新文件 | 追加模式下 `oldHandleWritesVisibleInTarget: true`（替换未成功，写进入了旧目标） | ✅ |
| **rename 覆盖被他进程 FileShare.None 独占的文件** | ⚠️ 观察到 `renameSucceeded: true`（"no EPERM observed even with FileShare.None"），**但** locker 进程回收时 `taskkill` 返回 `ok:false, status:128`，不能排除锁进程提前退出导致实验失真 | ⚠️ 结论存疑，建议上游在受控环境复测 |
| 保留名 / 尾随点空格 / 冒号星号 | `CON`、`aux.txt`、`trailingdot.`、`trailingspace ` 均**可创建**且 readdir 原名返回（Node 走 `\\?\` 前缀）；`colon:name.txt` "创建成功但名字被规范化"（冒号为 ADS 分隔符，readdir 只见冒号前部分）；`star*.txt` 创建失败 ENOENT | ❌ 与"Windows 不允许保留名"的直觉不符，已如实记录 |

---

## 9. 异常与未完成项

| 项 | 原因 | 后续怎么补 |
|---|---|---|
| OQ-3 `unc` 样本 | `\\localhost\c$` 管理共享不可达（无权限） | 按指导书不改共享设置，标未测 |
| `fsutil 8dot3name query C:` | 需提权（错误 5） | 不补；`dir /x` 已证短名存在 |
| `renameOverForeignLock` | locker 回收 `taskkill status:128`，实验可能失真 | 建议受控环境复测 |
| T4 Round 2 | ~~需 mac 侧的 Round 1 包拷回本机~~ | **已完成**（§4.2：落地 sha 一致、按 ID resume 历史完整、续聊严格追加） |
| 清理记录（§13，经用户逐项确认） | ① codex 副本 rollout（a080）已删；② `~/aiss-probe`、`D:\aiss-probe` 用户选择**先保留**；③ `~/.claude/projects` 下 8 个 aiss-probe 目录按默认**跳过不删**；④ `~/.codex/session_index.jsonl` 全程未动（第 2 层未执行，无需恢复）；⑤ OneDrive 测试文件待用户右键"始终保留在此设备"恢复 | — |
| OQ-5 变体：uuid 形状文件名 + 伪造内容 | 本轮只测了非 uuid 命名的副本 | 若同步工具会产 uuid 命名副本需补测 |
| rollout append-only 逐步校验 | lifecycle 工具单目录额度被 T2 占用 | 可在 T2 结束后对 `~/.codex/sessions/<日期目录>` 补跑 |
| macOS 对照（§1.3） | 属 mac 侧报告内容 | mac 报告产出后回填 |
| machine-report 卷文件系统字段 | 采集显示为 `DriveLetter FileSystemType\r`（PowerShell 输出解析小瑕疵） | 已在 §0 用 `Get-Volume` 实测补正 |
| **脚本脱敏遗漏（bug，已处理）** | `probe.mjs projects-snapshot` 写的 `out\oq3-snapshot.json`（`root` 字段与目录名列表）和 `oq5-plant` 写的 `out\oq5-planted.json`（`dir` / 文件路径字段）**未做用户名脱敏**，含 `C:\Users\<真实用户名>\…` 原文。对比之下 `oq3-samples.json`、`machine-report.*`、`lifecycle/*` 均正常脱敏 | 已在交付物里把两个文件中的用户名替换为 `<USER>`（共 49 处），复检无命中；**建议上游修脚本**：这两路输出应走与其他产物相同的 redact 通道 |

---

## 10. 隐私复检

- ☑ 已 grep `out\*.md` `out\*.json`，无对话正文；两条检查实际命中情况：① 密钥样式仅命中本报告 §10/§11 里作为检查命令字面量出现的那两行（模板自带的自引用，非真实密钥）；② 用户名检查最初命中 `out\oq3-snapshot.json` 与 `out\oq5-planted.json`（脚本未脱敏，见 §9 末行），已替换为 `<USER>` 后复检**无命中**
- ☑ 无 `sk-` / `ghp_` / `Bearer ` / PRIVATE KEY 样式字符串
- ☑ 未打开任何凭证文件（`auth.json` / `config.toml` / `.credentials.json` 等均只登记存在与大小）
- ☑ `oq1-package-out\` 未进入报告、未外发（它在 `%USERPROFILE%\aiss-probe\oq1-package-out\`，本来就不在 `out\` 里）
- ☑ 已删除 `out\lifecycle\.dir-raw`（含本机绝对路径）
- ☑ 所有测试会话都在 `%USERPROFILE%\aiss-probe\` 下发起
- ☑ 未修改 OneDrive 全局设置、未改注册表

## 11. 实际执行过的关键命令（便于复现）

```powershell
# 前置
node --version; claude --version; codex --version
New-Item -ItemType Directory -Force -Path "$HOME\aiss-probe" | Out-Null

# T0
node probe.mjs

# T1（每标签一轮，示例见 §1.4）
node probe.mjs projects-snapshot
#   → powershell -NoProfile -Command "New-Item …; Push-Location <path>; claude -p 'reply with the single word ok' | Out-Null; Pop-Location"
node probe.mjs projects-diff --label <label> --path <path>

# T2（headless 部分，Git Bash）
claude -p "reply with the single word ok" --output-format json > $HOME/aiss-probe/oq8-first-session.json
node lifecycle-snapshot.mjs init --dir "C:\Users\<USER>\.claude\projects\C--Users-<USER>-aiss-probe-lifecycle"
node lifecycle-snapshot.mjs snap "00-baseline"   # … 01/02/03/04/05b/07/08/09/05/06/12/11/13/10/10b 同法
claude -p --resume "$SID" "say ok again"          # 追加轮
claude -p --resume "$SID" "write a short poem" &  # 强杀：$! 得 pid=1412，kill -9 1412
# 交互步骤（用户）：claude --resume <sid> 进会话后 /compact；回退到历史消息发 ok（fork）；
#                   新会话直接 /exit（空会话）；打开列表直接退出（noop）
# 跨版本（经用户同意）：claude install 2.1.220 → resume 一轮 → claude install 2.1.223 恢复

# T3
node probe.mjs oq5-plant --dir "<lifecycle 项目目录>" --from "<会话 jsonl>"
node probe.mjs oq5-clean --dir "<同上>"   # 两轮均已执行

# T4 Round 1
claude -p "reply with the single word ok" --output-format json > $HOME/aiss-probe/oq1-first.json
claude -p --resume "$SID1" "say ok again"; claude -p --resume "$SID1" "say ok a third time"
node probe.mjs pack-session --dir "<oq1 项目目录>" --workdir "C:\Users\<USER>\aiss-probe\oq1"

# T5
codex exec --skip-git-repo-check "reply with ok"   # 于 %USERPROFILE%\aiss-probe\codex
node probe.mjs                                     # 复采对比 threads 行数（23→24）
# 第 1 层：cp rollout-…a079.jsonl rollout-…a080.jsonl（同目录，索引不动）→ 列表出现两个
# 第 2 层：未执行（第 1 层已被发现，无需动 session_index.jsonl）

# T7
node probe.mjs win-placeholder --path "C:\Users\<USER>\OneDrive\aiss-probe-test.txt"   # 在线 / 释放后 / 读后 共 3 次
node probe.mjs win-placeholder --path "C:\Users\<USER>\OneDrive"                       # 目录属性

# T9
node probe.mjs win-links

# 隐私复检（交付前跑，均应无输出）
grep -rnE "sk-|ghp_|Bearer |BEGIN [A-Z ]*PRIVATE KEY" out --include=*.md --include=*.json --include=*.jsonl --include=*.txt
grep -rnF -e "$(whoami)" -e "$HOME" out --include=*.md --include=*.json
```
