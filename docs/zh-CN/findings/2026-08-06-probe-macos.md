# 探测报告 · macOS

> 填写者：Kimi Code CLI　日期：2026-08-06　套件版本：aiss-probe/1
>
> 标注约定：✅ 已实测确认　⚠️ 未测 / 不确定（必须写原因）　❌ 实测结果与预期不符（写详细）

## 0. 环境

| 项 | 值 |
|---|---|
| macOS 版本 | 26.5.2 (Build 25F84)，Darwin 25.5.0 |
| 芯片 / 架构 | arm64（Apple Silicon） |
| Node 版本 | v26.5.0 |
| Claude Code 版本 | 2.1.223 |
| Codex 版本 | codex-cli 0.146.0 |
| 其他 agent CLI | opencode 1.18.11 ✅ / grok 0.2.118 ✅ / pi 0.83.0 ✅；另发现 `~/.gemini`、`~/.cursor` 目录 |
| 文件系统（APFS?） | APFS（`/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)`） |
| 用户名是否含空格/非 ASCII | 否（长度 6，无空格/点/大写/非 ASCII） |

**T0 补充结论**（源自 `out/machine-report.md`，已通读、无对话正文泄漏）：

- `~/.claude/projects/` 下探测时有 **1 个**项目目录（用户真实项目，非本探测产生），目录名形如 `-Users-<USER>-Library-Mobile-Documents-...`（长度 82，`-` 分隔）。
- 抽样 3 个 jsonl：`sessionId` **全部等于文件名** ✅；末尾均有换行、无 BOM、无 CRLF。`parentUuid` 链：2 个文件 0 断点，1 个文件 **2/131 断点**（含 sidechain/attachment 等类型，断点含义待 T2 对照）。
- jsonl 顶层 key 含 `type/sessionId/parentUuid/cwd/version/gitBranch/entrypoint/userType` 等；`cwd` 为绝对路径（含 iCloud `iCloud~md~obsidian` 这类带 `~` 的目录名）。

自动产物：`out/machine-report.json`、`out/machine-report.md`

---

## 1. OQ-3 · 项目目录转义规则（阻塞 M1）

### 1.1 样本表

原始数据：`out/oq3-samples.json`

| 标签 | 输入路径（cd 进去的绝对路径，用户名已替换为 `<USER>`） | 生成的目录名 | 备注 |
|---|---|---|---|
| plain | `/Users/<USER>/aiss-probe/plain` | `-Users-<USER>-aiss-probe-plain` | 基准 ✅ |
| with-space | `/Users/<USER>/aiss-probe/with space` | `-Users-<USER>-aiss-probe-with-space` | 空格 → `-` ✅ |
| with-dot | `/Users/<USER>/aiss-probe/my.vault` | `-Users-<USER>-aiss-probe-my-vault` | `.` → `-`（不保留）✅ |
| with-cjk | `/Users/<USER>/aiss-probe/中文目录` | `-Users-<USER>-aiss-probe-----` | **每个非 ASCII 字符 → 1 个 `-`**：4 个汉字 + 1 个分隔符 = 5 个 `-` ✅ |
| with-dash | `/Users/<USER>/aiss-probe/dash-in-name` | `-Users-<USER>-aiss-probe-dash-in-name` | 原生 `-` 原样保留 ✅ |
| upper-case | `/Users/<USER>/aiss-probe/UPPER-Case` | `-Users-<USER>-aiss-probe-UPPER-Case` | 大小写原样保留 ✅ |
| underscore-paren | `/Users/<USER>/aiss-probe/a_b (c)` | `-Users-<USER>-aiss-probe-a-b--c-` | `_`、空格、`(`、`)` 全部 → `-` ✅ |
| outside-home | `/tmp/aiss-probe-outside` | `-private-tmp-aiss-probe-outside` | ❌ 与直觉不符但极重要：`/tmp` 被 realpath 成 `/private/tmp` 后才转义 |
| via-symlink | `/Users/<USER>/aiss-probe/link-plain`（指向 `plain` 的符号链接） | **无新目录**（`ambiguous: true`，新增 0 个） | 会话落进了已存在的 `-Users-<USER>-aiss-probe-plain`（内有 16:31:34 产生的新 jsonl，时间戳与本次运行吻合）✅ realpath 第二条证据 |

### 1.2 规则总结

| 问题 | 结论 | 标注 |
|---|---|---|
| `/` → ? | `-` | ✅ |
| 前导 `/` → ? | 也变成 `-`，故所有目录名以 `-` 开头 | ✅ |
| `.` → ? | **被替换成 `-`**，不保留 | ✅ |
| 空格 → ? | `-` | ✅ |
| 中文 → ?（原样 / NFC / NFD / 编码） | 每个非 ASCII 字符 → 1 个 `-`（不保留、不编码；NFC/NFD 无从谈起） | ✅ |
| 大小写 → ?（保留 / 归一化） | 保留原样（`UPPER-Case` 原样出现） | ✅ |
| 是否有长度截断或哈希后缀 | 未见（最长样本输入 37 字符无截断无哈希；未测超长路径） | ⚠️ 仅就样本而言 |
| 反转义是否可逆（`-` 能否区分原本是 `/` 还是 `.`） | **不可逆**：`/ . 空格 _ ( )` 及每个非 ASCII 字符全都变成 `-`，与原生 `-` 无法区分 | ✅ |
| CLI 用 `cwd` 字符串还是 realpath（symlink 实验） | **realpath**。证据一：`/tmp/...` → `-private-tmp-...`（macOS 上 `/tmp` 是指向 `/private/tmp` 的 symlink）；证据二：在 symlink 目录里开会话不产生新目录，落进 realpath 对应的目录 | ✅ |

观察到的字符分类（未穷举）：保留 `[A-Za-z0-9-]`；`/ . 空格 _ ( )` 与所有非 ASCII 字符 → `-`。其余字符类（如 `~` `+` `=`）⚠️ 未测。

### 1.3 实际执行的命令

```bash
# 每个标签一轮（共 9 轮，分 3 批执行）：
run_one() {
  local label="$1" path="$2"
  node probe.mjs projects-snapshot >/dev/null
  mkdir -p "$path"
  (cd "$path" && claude -p "reply with the single word ok" >"$HOME/aiss-probe/t1-logs/$label.log" 2>&1)
  node probe.mjs projects-diff --label "$label" --path "$path"
}
run_one plain            "$HOME/aiss-probe/plain"
run_one with-space       "$HOME/aiss-probe/with space"
run_one with-dot         "$HOME/aiss-probe/my.vault"
run_one with-cjk         "$HOME/aiss-probe/中文目录"
run_one with-dash        "$HOME/aiss-probe/dash-in-name"
run_one upper-case       "$HOME/aiss-probe/UPPER-Case"
run_one underscore-paren "$HOME/aiss-probe/a_b (c)"
run_one outside-home     "/tmp/aiss-probe-outside"
# via-symlink（目录是 symlink，不 mkdir）：
ln -sfn "$HOME/aiss-probe/plain" "$HOME/aiss-probe/link-plain"
node probe.mjs projects-snapshot >/dev/null
(cd "$HOME/aiss-probe/link-plain" && claude -p "reply with the single word ok" >/dev/null 2>&1)
node probe.mjs projects-diff --label "via-symlink" --path "$HOME/aiss-probe/link-plain"
# 验证 symlink 会话落点：
ls -lT ~/.claude/projects/-Users-<USER>-aiss-probe-plain/
```

claude 版本 `2.1.223`，全部 9 次 `claude -p` 退出码均为 0。

---

## 2. OQ-8 · session 生命周期是否严格 append-only（阻塞 M1，最重要）

自动产物：`out/lifecycle-report.md`、`out/lifecycle/`

### 2.1 总判定

| 项 | 结论 | 标注 |
|---|---|---|
| 全程严格 append-only？ | **是。** 20 次快照对会话文件全程无 `PREFIX_VIOLATION` / `SHRUNK`；`lifecycle-report.md` 的"总判定：存在违反"仅因 2 次 `DELETION` 行，那是**我自己跑 `oq5-clean` 删除异物文件**所致（"违反项明细：无"） | ✅ |
| 哪一步破坏了（若有） | 无。`/compact`、fork、强杀、跨版本 resume 全部为严格追加 | ✅ |
| 文件名是否恒等于 `sessionId` | 是（`4112acc9-…`、`f10b927d-…` 均一致；T0 对用户既有 3 个样本也一致） | ✅ |
| 过程中是否出现新文件 | 仅"新建交互式会话"一步产生第二个 jsonl；`/compact`、fork、retry、跨版本 resume **都不**产生新文件 | ✅ |
| 旧文件是否被删除 / 清空 / 重写 | 从未。文件从 10984B 单调增长到 106749B | ✅ |
| 每次快照末尾是否总有换行 | 是，20/20 次全部以 `\n` 结尾 | ✅ |
| 强杀之后末行是否残缺 | 本次**未出现**半截行：`kill -9` 前已落盘的 +947B 最后一行仍完整且以换行结尾（说明写入是按整行落盘的；单一样本，不保证必然） | ⚠️ 单一样本 |
| 残缺末行是否影响 resume | 未出现残缺故无从验证；强杀后 resume 本身正常、继续严格追加 | ⚠️ 未触发该场景 |

### 2.2 逐步结果

| 快照 | 操作 | size 变化 | 判定 | 备注 |
|---|---|---|---|---|
| 00-baseline | 首次会话后初始化 | 10984B（9 行） | ✅ | |
| 01-new-session | —（与 00 同刻补拍） | 未变 | ✅ | |
| 02-append-turns | `claude -p --resume` ×3 | +6542B | ✅ | |
| 03-after-resume | `claude -p --resume` ×1 | +6463B | ✅ | ⚠️ 我误在错误目录跑快照命令导致漏拍，此快照实际已包含 04 的两轮追加 |
| 04-append-after-resume | `claude -p --resume` ×2 | 未变（增长已计入 03） | ✅ | 同上，03/04 为同批补拍 |
| 05-after-compact | 交互式 `/compact` | +27524B（70→86 行） | ✅ | **追加，不是改写** |
| 05b-after-retry | headless 重发同一句 | +2153B | ✅ | 见 2.4 |
| 06-append-after-compact | 未单独执行 | — | ⚠️ | compact 后的继续追加已被 12/13/10 三步覆盖（均可正常追加） |
| 07-after-kill | `kill -9` pid=21879 | +947B | ✅ | 末行完整、有换行 |
| 08-after-resume-from-kill | 杀后 resume | +3160B | ✅ | |
| 09-append-final | 追加 ×2 | +4732B | ✅ | |
| 10-cross-version-resume | 降级 2.1.211 后 resume | +13752B | ✅ | 见 2.5 |
| 11-empty-session | 交互式起会话直接 `/exit` | **无新文件产生** | ✅ | 见 2.6 |
| 12-after-fork（**必做**） | Esc×2 回到 `/compact` 点分叉 | +28032B（86→97 行） | ✅ | 见 2.7 |
| 13-resume-noop（可选） | `--resume` 打开直接 `/exit` | +236B | ✅ | 什么都不做也会追加一小行元信息 |
| t3-01/02/03、t3b-01/02 | OQ-5 异物种入/清除 | 见 §3 | DELETION×2 | 均为我本人清理动作，非 CLI 行为 |

强杀那一步实际杀掉的 pid（证明只杀了自己起的那一个）：`21879`（后台启动 `claude -p --resume …` 时以 `$!` 捕获，`kill -0` 确认存活后才 `kill -9`，输出 `killed pid=21879 (was still running)`）

### 2.3 `/compact` 细节（最可疑的一步）

- 执行方式（交互 / headless / 未执行）：交互式（`claude --resume 4112acc9-…` 进入后输入 `/compact`）
- 执行后原文件发生了什么：**追加约 27.5KB**（37205→64729B，70→86 行），旧字节一个不少——compact 摘要是作为新行追加到**同一个文件**末尾的
- 是否产生新文件、新 sessionId：都没有
- resume 之后看到的历史是完整的还是压缩后的：**压缩后的**。用户实测：resume 后交互界面只显示 compact 摘要往后的内容；rewind（Esc×2）里 compact 之前的消息**不可见、不可选**（文件里旧字节仍在，只是 UI 不再展示）

### 2.4 retry 同一条消息（05b）

| 观察点 | 结果 | 标注 |
|---|---|---|
| retry 的触发方式（交互回退 / headless 重发同一句 / 未执行） | headless 重发同一句 `say ok again` | ✅ |
| 是"再追加一轮"还是"改写了上一轮的 assistant 回复" | 再追加一轮（+2153B，40→45 行） | ✅ |
| 是否报 `PREFIX_VIOLATION`；若是，`firstDiffOffset` 是多少 | 否 | ✅ |
| 是否产生新文件 / 新 sessionId | 否 | ✅ |

### 2.5 跨版本 resume（10）

| 观察点 | 结果 | 标注 |
|---|---|---|
| 升级/降级前的 `claude --version` | 2.1.223 (Claude Code) | ✅ |
| 升级/降级后的 `claude --version` | 2.1.211 (Claude Code)（`~/.local/bin/claude` symlink 指向 `~/.local/share/claude/versions/2.1.211`，该版本本机已有，未下载） | ✅ |
| 换版本后 resume 是否还能看到完整历史 | 能（`claude -p --resume <sid>` 退出码 0，正常应答） | ✅ |
| 换版本后文件是否仍是严格追加（有无 `PREFIX_VIOLATION`） | 是，+13752B 严格追加 | ✅ |
| 新版本写入的行，顶层 key / `version` 字段有无变化 | 顶层 key 不变；`version` 字段变为混合 `{"2.1.223":44,"2.1.211":8}`；`entrypoint` 同为混合 `{"sdk-cli":38,"cli":14}`（交互步骤写 `cli`，headless 写 `sdk-cli`） | ✅ |
| 未测的原因（若未测：用户不同意改 CLI 版本 / 无第二个版本可用 / 其他） | 已测（用户同意降级，测后**已恢复** symlink 至 2.1.223 并用 `claude --version` 复核） | — |

### 2.6 空会话（11 · 新建会话不发消息直接退出）

| 观察点 | 结果 | 标注 |
|---|---|---|
| 是否生成了 jsonl 文件 | **否**。交互式 `claude` 起会话后一句话不发直接 `/exit`，项目目录里没有任何新文件 | ✅ |
| 文件大小 / 行数（0 字节？只有一行 meta？） | n/a（文件不存在） | ✅ |
| 末尾有没有换行 | n/a | — |
| 它会不会出现在 `claude --resume` 列表里 | 不会产生文件，自然无从出现 | ✅ |
| 对同步逻辑的含义（空文件要不要同步 / 会不会被当成"更短的版本"覆盖掉真文件） | 该场景不存在：2.1.223 不落盘空会话，同步工具无需处理"空文件覆盖真文件" | ✅ |

### 2.7 fork（12 · 必做）

| 观察点 | 结果 | 标注 |
|---|---|---|
| 本版本的分叉入口是什么（`Esc` ×2 / 上箭头选历史 / `/rewind` / 其他 / **没有**） | `Esc` ×2（rewind 回退菜单）；但 `/compact` 之后**只能回退到 compact 点**，更早的消息不可见不可选 | ✅ |
| 分叉后是改写原文件，还是新开一个文件 | **改写（追加进）原文件**：64729→92761B（+28032，86→97 行），不产生新文件、不产生新 sessionId | ✅ |
| 是否报 `PREFIX_VIOLATION`；`firstDiffOffset` / `oldSize` / `newSize` 各是多少 | 否（oldSize=64729，newSize=92761，纯追加） | ✅ |
| 若未测：试过哪些入口、为什么判定本版本不支持 | 已测 | — |

---

## 3. OQ-5 · 会话目录里的异物文件（阻塞 M1）

观测手段说明：本机 2.1.223 的 `claude --resume` picker **只列交互式会话**（见 §8 重大发现），因此分两种手段观测——① picker 肉眼检查（目录里有一条交互式会话 `f10b927d` 时进行）；② 异物在场时跑 headless `claude -p --resume 4112acc9-…` 看退出码与 stderr。

| 放置的文件 | 是否出现在会话列表 | CLI 是否报错 | 文件是否被改动/删除 |
|---|---|---|---|
| `aiss-probe-x.conflict` | 否 | 否（picker 无报错；headless resume 退出码 0、stderr 为空） | 否（两轮种植期间字节数不变，退出后原样） |
| `aiss-probe-x.bak` | 否 | 同上 | 否 |
| `aiss-probe-x.jsonl.bak` | 否 | 同上 | 否 |
| `aiss-probe-x.jsonl.tmp` | 否 | 同上 | 否 |
| `aiss-probe-zero.jsonl`（0 字节） | 否（不出现空条目） | 否（0 字节未引起任何报错） | 否 |
| `aiss-probe-x.conflict.jsonl` | 否（不出现"双胞胎"） | 否 | 否 |

错误信息原文（如有）：

```
（无任何错误/警告输出。headless resume 的 stderr 为空，picker 无异常提示。）
```

结论：隔离副本可以放在 session 目录里吗？ **可以（就本版本实测而言）**。6 类异物文件对 picker 与 headless resume-by-id 均无影响、不被加载、不被改动。两点注意：① `aiss-probe-x.conflict.jsonl` 虽是合法 `.jsonl`，但其内容的 `entrypoint=sdk-cli`，picker 的交互过滤本来就会隐藏它——"picker 不可见"不能完全归功于扩展名过滤；② 未测试交互式 resume-by-id 打开会话时异物是否影响（headless 已覆盖主要路径）。

清理是否已执行：☑ 是（两轮 `oq5-clean`，每轮后用 `ls -l` 验证原有 jsonl 字节数不变、一个不少）

---

## 4. OQ-1 · 跨平台 resume（阻塞 M1）

### 4.1 Round 1（本机产包）

| 项 | 值 |
|---|---|
| 工作目录 | `/Users/<USER>/aiss-probe/oq1` |
| 项目目录名 | `-Users-<USER>-aiss-probe-oq1` |
| session 文件名 | `9d47f4f2-6d23-40b2-b38a-c9d18107c00d.jsonl` |
| sha256 | `16856460ab7d1457c33fc801177d29c6dba0c63727ce45ad4b7273da640bc750` |
| 行数 | 20 |
| 末尾换行 | 是 |
| `cwd` 值 | `/Users/<USER>/aiss-probe/oq1` |
| `gitBranch` / `version` 值 | `HEAD` / `2.1.223` |
| 包已交付给 Windows 机器 | ☐（包在 `~/aiss-probe/oq1-package-out/`，含真实 jsonl，未进 `out/`、未外发） |

### 4.2 Round 2（落地来自 Windows 的会话）

| 观察点 | 结果 | 标注 |
|---|---|---|
| 落地后 sha256 一致 | | ⚠️ 未测：Windows 机器的包尚未到达 |
| 会话出现在 `claude --resume` 列表 | | ⚠️ 未测；**且注意**：本机 2.1.223 的 picker 只列交互式会话（§8），若 Windows 侧会话由 headless 产生，picker 里将**看不到**——Round 2 验证应直接用 `claude --resume <sid>`（by-id 已实测不受此限制） |
| 历史完整可见（轮数对得上） | | ⚠️ 未测（同上） |
| 能继续对话 | | ⚠️ 未测（同上） |
| 有无路径 / `cwd` 相关警告 | | ⚠️ 未测（同上） |
| 续聊后 `cwd` 字段是否同时出现两台机器的路径 | | ⚠️ 未测（同上） |
| 续聊后文件仍是严格追加 | | ⚠️ 未测（同上） |

错误信息原文（如有）：

```
（Round 2 未执行，无）
```

**结论**：`cwd` 等绝对路径字段是否影响跨平台 resume？ ⚠️ 未定（Round 2 待 Windows 包）。间接证据：本机跨**版本** resume（2.1.223→2.1.211）完全无碍；`cwd` 在文件里只是逐行元数据，未见 CLI 校验它的迹象。

---

## 5. OQ-2 · Codex（M2）

| 项 | 结论 |
|---|---|
| Codex 是否安装 / 版本 | ✅ codex-cli 0.146.0 |
| `~/.codex/sessions/` 是否存在、分层结构 | ✅ 存在；`sessions/YYYY/MM/DD/` 三层日期目录（探测时 19 个目录、33 个 jsonl） |
| rollout 文件名模式 | `rollout-<ISO时间戳>-<uuid>.jsonl`（如 `rollout-2026-08-06T16-44-23-019fd607-….jsonl`；uuid = session id） |
| rollout jsonl 的顶层 key | `timestamp` / `type` / `payload`；`type ∈ {session_meta, event_msg, response_item, world_state, turn_context}` |
| sqlite 文件清单（含 -wal/-shm） | `goals_1.sqlite`、`logs_2.sqlite`（133MB，名字疑似含对话，按红线未查内容）、`memories_1.sqlite`、`state_5.sqlite`，全部带 `-wal` + `-shm`；另有 `sqlite/` 目录 |
| `threads` 表列 | `id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used, has_user_event, archived, …, first_user_message, …, cli_version, …`（共 30+ 列，另有 4 个 `*_at_ms` 触发器维护列） |
| 哪些列是绝对路径 | `rollout_path`、`cwd` |
| 是否有 `session_index.jsonl` 等非 sqlite 索引 | 有 `session_index.jsonl`（689B），但**整个实验期间（exec 建会话、交互建会话、两次 resume）其大小与 mtime 纹丝不动**（停在当天 10:13）——0.146.0 疑似已不再写它，可能只是旧版残留 |
| **只拷 rollout 文件、不动 sqlite → 能否在 resume 列表里看到** | ✅ **能。** 把交互式会话的 rollout 原样复制为同目录下新 uuid 文件名（两个索引都没动），`codex resume --all` picker 里出现"双胞胎"两条；`codex exec resume <新uuid> "…"` 也能成功 resume 并把新轮次**追加到复制件**。threads 行数不增（33 不变） |
| 有无官方 import / reindex 命令 | 无。子命令清单：`exec / review / login / logout / mcp / plugin / mcp-server / app-server / remote-control / app / completion / update / doctor / sandbox / debug(models, app-server, prompt-input) / apply / resume / archive / delete / unarchive / fork / cloud / exec-server / features` ——没有 import/reindex |
| 新建一次会话后 `threads` 行数变化 | `codex exec` 建会话：31→32（+1）；交互式 `codex` 建会话：32→33（+1）。即两类会话都进 sqlite；但 **picker 只显示交互式来源的会话**（exec 建的即使进了索引也不显示） |

补充：rollout 的 append-only 验证 ✅ —— 两轮观测：① 原文件与复制件的前 45541B sha256 完全一致（`2f032cc8…`），两端各自续长均为严格追加；② 用 `lifecycle-snapshot.mjs` 对该日期目录跑一轮，`codex exec resume` 后 `019fd641` 文件 70136→92503B（+22367）严格前缀追加（产物：`out/codex-rollout-lifecycle-report.md`）。两个文件末尾均以 `\n` 结尾。

复制出来的测试文件是否已删除：☑ 是（经用户逐个确认后删除：`rollout-2026-08-06T16-44-23-019fd999-0000-7000-8000-00000000aa01.jsonl` 与 `rollout-2026-08-06T17-47-19-019fd998-0000-7000-8000-00000000aa02.jsonl`，均位于 `~/.codex/sessions/2026/08/06/`，删除前 `ls -l` 核对、单文件全路径 `rm`、无通配符。另注：探测期间创建的 2 个**真实**测试会话 rollout（`019fd607-…`、`019fd641-…`）按"默认不动 CLI 存储"原则保留。）

---

## 6. OQ-6 · 其他 provider（M2/M3）

### OpenCode

| 项 | 值 |
|---|---|
| 是否安装 / 版本 | ✅ opencode 1.18.11 |
| 存储根 | `<HOME>/.local/share/opencode`（数据；另有 `<HOME>/.opencode` 是程序安装目录） |
| 一个会话由哪些文件构成 | **没有每会话独立文件**——会话存在 `opencode.db`（sqlite，含 `-wal`/`-shm`）的 `session`/`message`/`event` 等表里；另有 `snapshot/<hash>/...`（git 仓库状快照） |
| logicalId 来源 | sqlite 行主键（`session.id`），不是文件名 |
| 是否 append-only | ❌ 不是 jsonl 文件流；是 sqlite（event 表为事件溯源式追加，但对外呈现为 DB，不能按文件搬运） |
| 是否有外部索引 | DB 本身就是唯一存储；**官方提供 `opencode export [sessionID]` / `opencode import <file>`（JSON 文件或 URL）**——这是现成的导入通道 |
| 是否含绝对路径字段 | 是：`project.worktree`、`workspace.directory`、`project_directory.directory` |
| resume 命令 | TUI 里选会话；`opencode session list` 可列出；headless 用 `opencode run` |

### Grok CLI

| 项 | 值 |
|---|---|
| 是否安装 / 版本 | ✅ grok 0.2.118 (1e1687c1cf6a) [stable] |
| 存储根 | `<HOME>/.grok`；会话在 `sessions/<uuid>/` 子目录 |
| 一个会话由哪些文件构成 | **一个会话 = 一个目录**，内含 `chat_history.jsonl`（主文件）、`events.jsonl`、`updates.jsonl`、`rewind_points.jsonl`、`summary.json`、`prompt_context.json`、`system_prompt.txt` 及若干 `.lock` |
| logicalId 来源 | 目录名 `<uuid>` |
| 是否 append-only | 主文件是 jsonl（疑似追加；⚠️ 未做生命周期实验）。注意存在 `rewind_points.jsonl`——官方有 rewind/fork 概念，改写行为需另行验证 |
| 是否有外部索引 | 有 `sessions/session_search.sqlite`（搜索索引）与 `~/.grok/active_sessions.json`；不进索引是否就看不见会话 ⚠️ 未测 |
| 是否含绝对路径字段 | ⚠️ 未确认（未采样 chat_history.jsonl；日志 `logs/unified.jsonl` 的 ctx 里有路径，但那是日志不是会话） |
| resume 命令 | `grok --resume [SESSION_ID_OR_TITLE]` / `grok --continue`；另有 `--fork-session`、`--session-id <uuid>` |

### Pi agent

| 项 | 值 |
|---|---|
| 是否安装 / 版本 | ✅ pi 0.83.0 |
| 存储根 | `<HOME>/.pi/agent/sessions/<项目目录名>/` |
| 一个会话由哪些文件构成 | **一个会话 = 一个 jsonl 文件**：`<日期>T<时间>Z_<uuid>.jsonl` |
| logicalId 来源 | 文件名中的 uuid（文件内 `session` 行也有同值 `id` 字段；样本 `version: 3`） |
| 是否 append-only | jsonl，样本 5 行全部可解析、末尾有换行（疑似追加；⚠️ 未做生命周期实验） |
| 是否有外部索引 | 未见（`~/.pi/agent/` 下只有 sessions/、settings.json、models.json、auth.json）→ 推测扫目录发现，⚠️ 未实测 |
| 是否含绝对路径字段 | 是：`session` 行有 `cwd`（绝对路径） |
| resume 命令 | `pi --resume` / `pi --continue` / `pi --session <path|id>`；另有 `pi --fork <path|id>` |

补充观察（对 OQ-3 有参考价值）：Pi 的项目目录名转义规则与 Claude Code **不同**——样本为 `--Users-<USER>-Library-Mobile Documents-iCloud~md~obsidian-Documents-obsidian-vault--`：双 `-` 作边界、**空格与 `~` 原样保留**。

另：T0 还发现 `<HOME>/.gemini`（含 `antigravity*/conversations` 目录，应为 IDE 侧产物）与 `<HOME>/.cursor`（IDE 数据，含 `ai-tracking/ai-code-tracking.db`），但 `gemini` / `cursor-agent` CLI 不在 T0 的 CLI 版本表里，按"装了才测"原则不展开。

---

## 7. 文件系统事实

| 事实 | 值 | 是否符合预期 |
|---|---|---|
| mtime 粒度 | 39.917µs（300 次连续写入产生 300 个不同时间戳，最小间隔 39917ns） | ✅ 远比"秒级"细，可用于稳定性判断 |
| mtimeMs 是否有小数 | true | ✅ |
| 大小写敏感 | false（大小写不敏感；用另一种大小写可读回；两种大小写各写一个文件后只剩 1 个条目） | ✅ 符合 APFS 默认 |
| Unicode 规范化不敏感 | true（NFC/NFD 视为同一名字，collideEntryCount=1） | ✅ 符合 APFS 预期 |
| readdir 返回 NFC 还是 NFD | 两种都见到了原样返回（`café-a.txt` 为 NFC、`café-b.txt` 为 NFD），即 APFS 保留写入时的形式，但比较时不敏感 | ✅ |
| 目录 fsync 是否可用 | ok（fileFsync/dirFsync 均 ok） | ✅ |
| 能否创建 symlink | true（lstat 识别为 symlink，realpath 正常） | ✅ |
| >260 字符路径可用 | true（268/300/400 字符均创建成功） | ✅（macOS 无 260 限制） |
| rename 覆盖被自身打开的文件 | 成功（r 与 a 两种打开方式均可被 rename 覆盖） | ✅ |
| 旧句柄写入是否进入新文件 | **否**：`oldHandleWritesVisibleInTarget=false`，rename 后旧句柄的写入进旧 inode，不进新文件 | ✅ 意味着原子替换瞬间 CLI 若有在飞写入会落到旧文件 |
| rename 覆盖被他进程独占的文件 | n/a（非 Windows） | — |

---

## 8. 异常与未完成项

| 项 | 原因 | 后续怎么补 |
|---|---|---|
| ❌ **重大发现：`claude --resume` picker 不显示 headless 会话** | 2.1.223 实测：picker 只列交互式会话（`entrypoint=cli`）。headless（`-p`，`entrypoint=sdk-cli`）创建的会话存在于项目目录、可 `--resume <sid>` 正常使用，但**从不出现在 picker**。基线对照：无交互会话时 picker 全空；建了一条交互会话后它出现、headless 会话仍不出现。这曾误导我们一度怀疑 OQ-5 异物文件搞挂列表 | 同步工具的验证流程不能依赖 picker 看到同步来的会话；必须用 `--resume <sid>`。Windows 侧 Round 2 同样注意 |
| ❌ picker 全空≠目录无会话 | 同上，picker 不是"目录里有什么"的可靠视图 | 同上 |
| OQ-1 Round 2 未测 | Windows 机器的包尚未到达本机 | 包到后按 §7 Round 2 步骤做，验证用 `claude --resume <sid>` |
| 快照 03/04 时序瑕疵 | 我误在 `~/aiss-probe/lifecycle` 目录跑快照脚本（脚本在套件目录），导致 03 延迟拍摄、实际包含了 04 的两轮追加；04 显示"未变" | 不影响 append-only 总判定；数据已如实标注 |
| 06-append-after-compact 未单独执行 | compact 完成时后续步骤已排定 | 已被 12（fork）/13（resume-noop）/10（跨版本）三步的"compact 后继续追加"覆盖 |
| codex picker 的 pty 捕获失败 | `script -q … codex resume --all` 只抓到 141B 终端控制序列，TUI 未渲染列表 | 改由人工观测（已完成） |
| T7（OQ-4 占位符）、T9（OQ-9 junction/8.3） | Windows 专属 | 在 Windows 机器上执行 |
| 强杀后半截行场景未触发 | 本次 kill 前最后一行恰好完整 | 可遇不可求；如上游需要可多次强杀采样 |
| `session_index.jsonl` 的读写语义 | 0.146.0 全程未写它；它可能是旧版残留。按红线未读取其内容行 | 上游如需兼容旧版，另测旧版 codex |

---

## 9. 隐私复检

- ☑ 已 grep `out/*.md` `out/*.json`，无对话正文（T0 产物通读过一遍；lifecycle/codex 报告只有文件名/字节数/行数/sha256）
- ☑ 无 `sk-` / `ghp_` / `Bearer ` / PRIVATE KEY 样式字符串（唯一"命中"是本清单自身的字面量）
- ☑ 未打开任何凭证文件（`auth.json`、`config.toml`、`~/.claude/.credentials.json` 等全程未读；codex sqlite 只查 schema 与行数；`logs_2.sqlite` 因名字疑似含日志按红线未查）
- ☑ `oq1-package-out/` 未进入报告、未外发（它在 `~/aiss-probe/oq1-package-out/`，本来就不在 `out/` 里）
- ☑ 已删除 `out/lifecycle/.dir-raw`（含本机绝对路径）
- ☑ 所有测试会话都在 `~/aiss-probe/` 下发起（例外仅 `/tmp/aiss-probe-outside`，为指导书 §4.2 表内规定用例）
- ⚠️ **发现并处置两处脚本泄漏**（脚本 bug，告知用户）：
  - `out/oq5-planted.json` 的 `dir` 与 `files[]` 字段、`out/oq3-snapshot.json` 的 `root` 与目录名，**未做用户名脱敏**（含字面 `/Users/<真实用户名>`）。
  - 处置：已将两文件中用户名全部替换为 `<USER>`，替换前原件备份在 `~/aiss-probe/*.preredact.bak`（不属交付物），替换后 JSON 校验仍合法，复检②无命中。
  - 建议上游修复：`oq5-plant` 与 `projects-snapshot` 落盘前走一遍与其他产物相同的 redact。

## 10. 实际执行过的关键命令（便于复现）

```bash
# ---- T0 ----
node probe.mjs

# ---- T1（OQ-3，9 个标签循环，见 §1.3）----
node probe.mjs projects-snapshot
(cd "<测试路径>" && claude -p "reply with the single word ok")
node probe.mjs projects-diff --label "<标签>" --path "<测试路径>"

# ---- T2（OQ-8）----
cd ~/aiss-probe/lifecycle
claude -p "reply with the single word ok" --output-format json | tee ~/aiss-probe/oq8-first-session.json
# SID=4112acc9-1d79-48b5-854a-128e11d886c4（从 JSON 输出取出）
node lifecycle-snapshot.mjs init --dir "$HOME/.claude/projects/-Users-<USER>-aiss-probe-lifecycle"
node lifecycle-snapshot.mjs snap "00-baseline"   # …之后每步一拍
claude -p --resume "$SID" "say ok again"          # 02/03/04/05b/09
claude -p --resume "$SID" "write a very long detailed essay …" &  # 07：CLAUDE_PID=$!; sleep 4; kill -9 $CLAUDE_PID（pid=21879）
# 05（人工）：claude --resume "$SID" → /compact → /exit
# 11（人工）：claude → 直接 /exit（不落盘）
# 12（人工）：claude --resume "$SID" → Esc×2 → 回到 /compact 点分叉发 ok → /exit
# 13（人工）：claude --resume "$SID" → 直接 /exit（仍 +236B）
# 10（用户同意降级）：ln -sfn ~/.local/share/claude/versions/2.1.211 ~/.local/bin/claude
#   claude --version  # 2.1.211
#   claude -p --resume "$SID" "ok"   # exit=0，+13752B 严格追加
#   ln -sfn ~/.local/share/claude/versions/2.1.223 ~/.local/bin/claude  # 恢复并复核
node lifecycle-snapshot.mjs report

# ---- T3（OQ-5）----
node probe.mjs oq5-plant --dir "<项目目录>" --from "<会话 jsonl>"
claude -p --resume "$SID" "ok"   # 异物在场：exit=0，stderr 空
# （人工）claude --resume 观察 picker：无多余条目、无报错
node probe.mjs oq5-clean --dir "<项目目录>"   # 两轮，均 ls 复核原文件无损

# ---- T5（OQ-2）----
cd ~/aiss-probe/codex && codex exec --skip-git-repo-check "reply with ok" </dev/null
#   → session id: 019fd607-cdee-75a2-b828-09ce479fdbd0；threads 31→32
cp ~/.codex/sessions/2026/08/06/rollout-…-019fd607-….jsonl \
   ~/.codex/sessions/2026/08/06/rollout-…-019fd999-0000-7000-8000-00000000aa01.jsonl
codex exec resume --skip-git-repo-check "019fd999-…" "reply with ok"   # ✅ 成功（索引里没有）
# （人工）codex（交互式建会话 019fd641）→ 同样复制为 019fd998-…
# （人工）codex resume --all → 出现"双胞胎"两条 ✅；threads 不增（33）
node lifecycle-snapshot.mjs init --dir "$HOME/.codex/sessions/2026/08/06" --force
codex exec resume --skip-git-repo-check "019fd641-…" "reply with ok"   # +22367B 严格追加
node lifecycle-snapshot.mjs report   # → 另存为 out/codex-rollout-lifecycle-report.md

# ---- T4（OQ-1 Round 1）----
mkdir -p ~/aiss-probe/oq1 && cd ~/aiss-probe/oq1
claude -p "reply with the single word ok" --output-format json   # SID=9d47f4f2-…
claude -p --resume "$SID1" "say ok again"   # ×2（共 3 轮）
node probe.mjs pack-session --dir "$HOME/.claude/projects/-Users-<USER>-aiss-probe-oq1" --workdir "$HOME/aiss-probe/oq1"
#   → ~/aiss-probe/oq1-package-out/（不进 out/、不外发）

# ---- 隐私复检 ----
grep -rnE "sk-|ghp_|Bearer |BEGIN [A-Z ]*PRIVATE KEY" out --include=*.md --include=*.json --include=*.jsonl --include=*.txt
grep -rnF -e "$(whoami)" -e "$HOME" out --include=*.md --include=*.json
rm -f out/lifecycle/.dir-raw
```
