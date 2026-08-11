# 2026-08-12 · Claudian 源码调查（M2 前置）

> **证据等级：源码阅读，不是真机实测。** 对象是本机 clone `~/projects/claudian`
> （fork: powoct/claudian，HEAD `033eed12` = 2.1.3）。本文所有结论描述的是
> **Claudian 怎么读/写这些存储**，不是 **CLI 自己在生命周期中怎么改文件**——
> 后者只能靠真机 lifecycle 探测（OQ-6/OQ-8 那套）回答。Tier 归属仍以实测为准
> （§6.1 第一条规则不因本文放宽）。
>
> 引用格式 `文件:行` 均相对 `~/projects/claudian/`。

## 0. 一句话结论

| provider | 存储形态 | 对本插件的意义 |
|---|---|---|
| **Claude Code** | 见 §6.3（M1 主线） | 不变 |
| **Codex** | `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`，纯扫目录 | **可同步**，M2 主目标；但有 workspace 归属未决（OQ-11） |
| **OpenCode** | **单个 SQLite `opencode.db`，没有任何 per-session 文件** | **不可同步**。Tier C 只读且**没有升级路径**，除非上游给出官方 export/import |
| **Grok** | 每 session 一个**目录** `~/.grok/sessions/<urlencode(cwd)>/<sessionId>/updates.jsonl` | 候选；父目录名是**本机绝对路径**编码，跨机是硬伤（见 §3） |
| **Pi** | 每 session 一个文件 `<root>/<ISO>_<uuid>.jsonl` | 候选；文件内嵌绝对路径，fork 头部指向**源文件绝对路径** |

## 1. R-1 更正：`ai-title` 不是 Claudian 写的

2026-08-10 验收记录把 session 文件里的 `{"type":"ai-title",…}` 追加**归因给
Claudian 的 ai-title 功能**。该归因**错误**，现更正：

| 证据 | 结果 |
|---|---|
| `grep -rn "ai-title\|aiTitle" src tests` | **零命中** |
| `git log --all -S"ai-title"` | **零命中**（该字符串从未在 Claudian 历史中出现） |
| 本开发机（Linux，**未安装 Obsidian/Claudian**）的 `~/.claude/projects/*/*.jsonl` | 17 个 session 文件中 **6 个**含 `"type":"ai-title"` 记录 |

**写入方是 Claude Code CLI 自身。** Claudian 的自动标题功能走的是一个
`nativePersistence: 'disabled-if-supported'` 的临时辅助会话（对 Claude 即
`persistSession = false` 且不传 resume id），标题只落在 vault 内 `.meta.json`；
Claudian 唯一会在 CLI 存储里**创建**文件的地方是 Pi 的 fork，且用 `flag:'wx'`
（独占创建，绝不覆盖，`PiHistoryStore.ts:337`）。

**对项目的影响**（三条，都是往好的方向）：

1. R-1 不再是「第三方写入者」风险。追加发生在 **OQ-8 已实测的 append-only 模型
   之内**，前缀合并天然吸收。
2. README 不需要写「Claudian 会改你的 session 文件」这类警告；需要写的是**另一件
   事实**：*CLI 自己在你只是打开/查看会话时也可能追加元数据*（F-2 已测 +530B、
   ai-title +236B），所以「没说话也会产生差异」是正常现象。
3. ADR-40 的动机不受影响：即使写入方是 CLI，「冲突中的非活动会话仍会被追加」这个
   观测事实成立，冻结式快照仍然会过期。

> 仍未定的细节：**触发者**是谁。CLI 是写入方已确证；是不是「Claudian 打开会话
> 导致 CLI 追加」这条链路，源码层面看不出来（Claudian 只读 CLI 存储）。留给真机
> 探测，属低优先级。

## 2. Codex（M2 主目标）

### 2.1 路径与发现

| 事实 | 证据 |
|---|---|
| 根 = `<CODEX_HOME>/sessions`；`CODEX_HOME` 取值优先级：app-server `initialize` 响应的 `codexHome` → 环境变量 `CODEX_HOME`（须绝对路径）→ `HOME \|\| USERPROFILE \|\| os.homedir()` + `.codex` | `src/providers/codex/runtime/CodexRuntimeContext.ts:61-98`、`history/CodexHistoryPathResolver.ts:80-109`、`history/CodexHistoryStore.ts:1490` |
| **Windows 无特殊目录**（无 APPDATA/LOCALAPPDATA 分支），就是 `%USERPROFILE%\.codex` | 全 `src/providers/codex/` 无 APPDATA 命中；被删的那个 AppData 分支是 OpenCode 的（`git show ddb3f579`） |
| **`HOME` 先于 `USERPROFILE`** 被检查 | `CodexHistoryPathResolver.ts:103-109` —— Windows 上装了 Git Bash/MSYS 时 `HOME` 存在，两边解析结果会不一致，本插件**必须用同一套顺序**，否则监视的目录和 Claudian 读的不是一个 |
| 归档目录 `<CODEX_HOME>/archived_sessions` 是**兄弟目录**，Codex 会把 rollout 移过去 | `CodexHistoryPathResolver.ts:127-130`、`AGENTS.md:40` |
| 发现机制 = **纯扫目录**：先试 `<root>/<threadId>.jsonl`，再对整棵树做 DFS 匹配 `endsWith("-<threadId>.jsonl")`。无 `session_index.jsonl`、无 sqlite 参与 | `CodexHistoryStore.ts:1496-1526`（同步）/`:1549-1578`（异步）；仓库内 `session_index` 零命中 |
| **文件名匹配锚定尾部**，Claudian 从不从文件名里 parse uuid | `CodexHistoryStore.ts:1522,1575` |
| resume 只传 `threadId`（`thread/resume`），**从不传路径**；路径是服务端**返回**的 | `execution/CodexExecutionSession.ts:1105-1130`；`runtime/codexAppServerTypes.ts:460-471` |
| CLI 调用形态恒为 `codex app-server --listen stdio://` | `runtime/CodexLaunchSpecBuilder.ts:18` |
| Claudian **从不写** `~/.codex`（全是 existsSync/readdir/readFile） | 全目录 write/mkdir/rename/unlink 仅两处，均在 `os.tmpdir()`：`CodexExecutionSession.ts:1957,1966` |
| 但 Claudian 会把 `<codexHome>/memories` 列为 CLI 的**可写沙箱根** | `CodexExecutionSession.ts:1857-1878` |

### 2.2 对 adapter 的直接结论

1. `logicalIdPattern` 应**锚定尾部** `-<uuid>.jsonl`，而不是写死 `rollout-<ts>-<uuid>`
   ——Claudian 自己就是这么做的，能扛住前缀变化。§6.4 原文的正则形态据此收紧。
2. 日期层 `YYYY/MM/DD/` 必须**原样保留**（neutralRel 带层级），落位不能拍平。
3. `archived_sessions` 属于 Codex 存储的一部分：**文件从 `sessions/` 消失不等于删除，
   而是被移动**。删除传播（M1–M2 不做）将来若做，必须先认识这个搬运。
4. `~/.codex/memories` 是 CLI 的可写目标，**语义未知，一律排除**（不同步、不读）。
5. `*.sqlite` / `-wal` / `-shm` 红线不变。

### 2.3 新增未决问题

- **OQ-11（M2 阻塞级）：Codex 会话如何归属到"本 vault 的 workspace"？**
  `~/.codex/sessions/` 是**全局**的，没有 Claude Code 那种按项目路径转义的分区。
  启用 Codex 若不加限定，就会把这台机器上**所有** Codex 对话（含与本 vault 无关的
  项目）推进本 workspace 子树——这既违反 §5.2 的 workspace 模型，也是隐私问题。
  唯一的候选判据是 rollout 首行 `session_meta.payload.cwd`，但那意味着 adapter
  **必须读文件内容才能完成发现**，现有 `listSessions` 没有这个形状。
  → 需要一条 ADR + 真机验证 `payload.cwd` 是否稳定可用。
- **OQ-12：只同步 rollout，Claudian UI 里会不会出现这个会话？**
  不会。Claudian 从不扫盘枚举 Codex 会话，它按自己 vault 内
  `.claudian/sessions/<id>.json` 里存的 `threadId` 去找文件
  （`CodexHistoryStore.ts:1510,1544` 是全 provider 仅有的两处 readdir，且都在
  `findCodexSessionFile(threadId)` 内部；无 `thread/list` RPC）。
  **所以：同步 rollout ⇒ `codex` CLI 侧可 resume；Claudian UI 侧仍无入口**，
  除非 vault 内那半份元数据也过去（它随 vault 同步走，见 §4）。
  这条直接决定 M2 里 Codex 的**用户可见价值**，必须在动手前定调。

## 3. OpenCode：不可同步（结论级）

| 事实 | 证据 |
|---|---|
| 会话历史全在**单个 SQLite** `opencode.db`；路径 = `XDG_DATA_HOME/opencode/opencode.db`，否则 `$HOME/.local/share/opencode/opencode.db`，**三平台同构**；`OPENCODE_DB` 可覆盖 | `src/providers/opencode/runtime/OpencodePaths.ts:6,12,24` |
| commit `ddb3f579` 正是**删掉** Windows `%APPDATA%\opencode` 分支 | `git show ddb3f579` |
| Claudian 直连读库（`node:sqlite` readonly → 子进程 `node -e` → `sqlite3 -json`），查 `message` / `part` 两表，payload 是 `data` 列里的 JSON 字符串 | `history/OpencodeSqliteReader.ts` |
| **provider 目录内 `jsonl` 字样零命中**——没有任何 per-session 文件 | `grep -rln jsonl src/providers/opencode/` 为空 |
| **无官方 export/import 子命令**被使用或提及；唯一 CLI 形态是 `opencode acp` | provider 目录内无 export/import argv |
| Claudian 不写库，只 mkdir 父目录并给子进程设 `OPENCODE_DB` | `runtime/OpencodeRuntimeEnvironment.ts:15` |

**结论：OpenCode 在本插件的模型下没有可搬运的对象。** 单文件 SQLite（+ WAL）
既不满足 append-only，也不能按前缀合并；里面存的是绝对路径与全局 id，跨机搬运
= 覆盖对方全部会话。它**不是"未验证所以只读"，而是"结构上不适用"**：
即使做完 lifecycle 探测也不会升 Tier。

> **因此 §15 里 "M2 = Codex + OpenCode 接入" 这条需要改。** OpenCode 能做的上限是
> 「检测到并在设置里说明本插件不同步它、以及为什么」——是否值得为此写一个 adapter，
> 是产品判断，记在 §6.1.1 待定。

## 4. vault 内 `.claudian/sessions`：可行性评估（回答 CLAUDE.md 的 M2 候选项）

| 事实 | 证据 |
|---|---|
| 路径 `.claudian/sessions/`，旧版 `.claude/sessions/` 会被读取并迁移 | `src/core/bootstrap/storagePaths.ts` |
| 每会话**三个文件**、无索引：`<id>.meta.json`、`<id>.inputs.json`、`<id>.deleted.json` | 同上 |
| `<id>` = `conv-<Date.now()>-<random>`，**本机生成** | `ConversationRepository.ts:1817-1819` |
| **写入方式 = 整份 JSON 读-改-全量重写**，走 Obsidian `vault.adapter.write`，**就地写、无 tmp+rename、无 fsync**；连 `VaultFileAdapter.append()` 也是 read+concat+write | `ConversationPersistenceStore.ts:66-71`、`core/storage/VaultFileAdapter.ts` |
| 写入频率：每轮执行快照 revision 变化、每条 staged/accepted 输入、重命名/置顶/归档/换模型、迁移；每会话串行队列，**无 debounce** | 同上 |
| 内容含 provider 的 CLI session id、`providerState`（Pi 存绝对 `sessionFile`/`parentSession`，OpenCode 存绝对 `databasePath`）、`externalContextPaths`（绝对路径）、vault 相对 `currentNote`、时间戳、用量、标题；**不含消息正文**（正文从 CLI 原生历史 hydrate） | 同上 |
| **无任何合并/冲突处理**：单写者假设、last-writer-wins；JSON 解析失败 → `readMetadata` 返回 null → **该会话从列表里静默消失**（不报错） | 同上 |

**评估（与 2026-08-11 给出的口径一致，现在有源码证据）：**

| 维度 | 判定 |
|---|---|
| 合并语义 | ❌ 与 append-only 前提**根本冲突**（全量重写）。要支持必须新增一档 `rewrite-lww` 合并模式 + opaque 冲突人工决断（§7.2b 已有形状，但未实现） |
| 内容可移植性 | ❌ 内含**本机绝对路径**。跨机原样落地会让 Pi/OpenCode 的 providerState 指向不存在的路径 |
| 传输路径 | ⚠️ 它在 **vault 内**，用户的 vault 已由另一套工具同步。本插件再同步一遍 = **双传输**，两条链路对同一文件竞争写入，冲突副本与撕裂读（→ 会话静默消失）概率显著上升 |
| 收益 | ✅ 真实：它是 Claudian UI 侧的会话入口（OQ-12），没有它，跨机同步的 Codex/Claude 会话在 Claudian 里看不到 |

**建议（待用户拍板）**：不做「同步 `.claudian/sessions` 的开关」，改为 README 明确
写「**这个目录必须跟着你的 vault 一起同步，别把它排除**」——收益等价，风险为零。
只有当用户的 vault **不**整体同步时才需要插件介入，那属于 M3 再议。

## 5. Grok / Pi（M3 备料）

**Grok**：每 session 一个**目录** `~/.grok/sessions/<encodeURIComponent(realpath(cwd))>/<sessionId>/`，
Claudian 只读其中 `updates.jsonl`（`GrokHistoryStore.ts:265`）；每行是 JSON-RPC 通知
封套；**rewind 表示为追加一条 `rewind_marker`**、读取端回放时丢弃其后回合
（`:122-133`）——这是**源码层面的 append-only 迹象**，不是证明。fork 返回全新
`newSessionId`（新目录，不改父）。根可用 `GROK_HOME` 覆盖（`GrokHistoryPathResolver.ts:83-90`）。
**跨机硬伤**：父目录名是本机绝对路径的 urlencode，且 resume 时 CLI 自己按 cwd 找目录
——两台机器 vault 路径不同 ⇒ 目录名不同，落位规则必须像 Claude Code 那样重算，
且 `.cwd` sidecar 的语义要实测。

**Pi**：每 session 一个文件 `<root>/<ISO时间戳>_<uuid>.jsonl`，root 依次取
`$PI_CODING_AGENT_SESSION_DIR` / `$PI_CODING_AGENT_DIR/sessions` / `<vault>/.pi/agent/sessions` /
`~/.pi/agent/sessions`（`PiHistoryPathResolver.ts:9-39`）。首行是
`{"type":"session","version":3,"id",…,"cwd","parentSession"}`，其后每行带 `id`/`parentId`
构成**分支图**，重试/编辑产生兄弟分支而非截断（`PiHistoryStore.ts:177-205`）——同样是
append-only 迹象。**头部内嵌绝对 `cwd`，fork 的 `parentSession` 是源文件的绝对路径**
（`:322-331`）。注意 Pi 的 root 之一在 **vault 内**（`.pi/agent/sessions`），若用户用
那个位置，则它随 vault 同步，本插件不应重复搬运。**Claudian 会写 Pi 存储**（fork 时
`wx` 创建新文件，`:336-337`，失败可 `unlink` 回滚）——是本次调查中**唯一**发现的
「Claudian 写 CLI 存储」的点。

## 6. 本次调查同时暴露的本仓缺陷

见 `docs/zh-CN/architecture.md` ADR-45 与 commit `78e4c79`：§8.2 白名单在**远端侧
从未被调用**，Syncthing/Dropbox/OneDrive 的成品冲突副本会被当作 session 拉进 CLI
目录（已复现、已修、已加回归与注入验证）。同一函数里还有两个多 provider 才会发作
的错误（远端文件一律归给 `adapters[0]`；远端目录只列一层）。
