# AI Session Sync 架构与测试方案审核报告

> 审核对象：`CLAUDE.md`、`docs/zh-CN/architecture.md`、`docs/zh-CN/testing.md`  
> 审核日期：2026-08-06  
> 审核方式：只读设计审核；未修改被审核文档  
> 仓库阶段：pre-implementation，当前没有源码、测试脚手架、依赖清单、Obsidian manifest 或 CI workflow

## 1. 结论摘要

整体设计方向正确，尤其是以下决策值得保留：

- 使用与机器路径无关的中立同步布局。
- 将“行数多者胜”收紧为“较长文件必须严格包含较短文件前缀才允许覆盖”。
- manifest 定位为缓存而不是真相来源。
- 领域逻辑与 Obsidian、文件系统、时间来源解耦。
- Provider 按存储能力分 Tier，未验证的 Provider 保持只读。
- 把真机跨平台 resume 作为最终验收，而不是只依赖单元测试。

不过，当前文档还不适合直接作为 M1 的实现基线。主要原因不是模块拆分，而是若干设计会动摇“绝不静默丢失 session”的核心承诺：

1. manifest 的缓存策略可能让 Planner 使用过期 hash 做覆盖决定。
2. `plan -> apply` 之间存在 TOCTOU，跨机覆盖不是 compare-and-swap。
3. mtime 活跃判断不能可靠处理同步工具保留的远端时间戳。
4. `machineId` 和机器相关路径可能随 Obsidian vault 配置同步。
5. workspace 首次多机初始化可能生成两个不同 ID。
6. sync-dir 作为外部输入，尚无路径穿越、symlink/junction 和目录重叠防护。
7. Claude Code 的 append-only 核心假设尚未经过完整生命周期验证。
8. 测试中的 I1/I2 形式化以及 L2 双机模型目前不能正确表达冲突终态和真实传输过程。

建议先完成一次“文档语义冻结”，解决本报告列出的 M1 blocker，再建立项目脚手架。

## 2. 项目目标理解

根据 [`CLAUDE.md`](../CLAUDE.md) L3–24，本项目是一个 desktop-only Obsidian 插件，通过用户指定的本地同步目录，在 macOS、Windows 等多台机器之间同步 AI agent CLI 的原始 session 文件，使用户能在另一台机器上 resume 同一会话。

明确边界包括：

- 不把 session 转成 Markdown，不向 vault 写会话笔记。
- 不直连 Google Drive、Dropbox 等网盘 API。
- 不同步 CLI 凭证和配置。
- 不自动合并两台机器同时写出的发散分支，只检测、隔离和告警。
- M1 聚焦 Claude Code；M2 扩展 Provider 抽象并验证 Codex/OpenCode。
- M1–M2 不传播删除。

本次审核认为上述产品边界合理且清晰。

## 3. 仓库现实状态

[`architecture.md`](../docs/zh-CN/architecture.md) L3 和 [`testing.md`](../docs/zh-CN/testing.md) L3 均准确标明当前是设计稿。仓库检查结果如下：

- 当前分支尚无提交。
- 没有 `src/`、`tests/`、`package.json`、lockfile、`tsconfig`、Vitest/ESLint/esbuild 配置。
- 没有 Obsidian `manifest.json`、README 或 `.github/workflows/ci.yml`。
- 当前无法执行文档中描述的 typecheck、build、L0/L1/L2 测试或 CI。
- `CLAUDE.md` 被 [`.gitignore`](../.gitignore) L3 忽略，因此它不适合作为唯一且长期有效的产品规范。

这些不是“实现缺陷”，而是项目尚未进入实现阶段。建议将稳定产品要求迁入可提交、可评审的 PRD 或 architecture 文档。

## 4. M1 实现前必须修正的问题

### 4.1 统一规范来源和 Provider 当前状态

严重程度：**Blocker**

[`CLAUDE.md`](../CLAUDE.md) L57–62 仍规定“行数多的赢”；[`architecture.md`](../docs/zh-CN/architecture.md) L418–436 已正确改为“较长且包含较短文件完整前缀才允许覆盖”。前者会在分叉场景中静默删除较短分支，应视为已经废弃的规则。

Codex 状态也不一致：

- `CLAUDE.md` L19 仍以 `~/.codex/sessions/` 为默认假设。
- `architecture.md` L281–285 把 Codex 标为 Tier B ✅。
- `architecture.md` L378–382 又要求 OQ-2 完成前保持 Tier C。

指导意见：

- 更新 `CLAUDE.md`，采用前缀安全语义。
- 明确 `architecture.md` 是当前实现规范。
- Codex 当前状态统一写成“Tier C，只读；Tier B 候选”。
- OQ-2 有实测结论后再修改 Tier 标识。

### 4.2 manifest 缓存违反“真实文件为准”原则

严重程度：**Blocker / 数据正确性**

[`architecture.md`](../docs/zh-CN/architecture.md) L266–270 规定 manifest 不是事实来源，任何破坏性决定必须基于当次真实文件内容；但 L409、L618 又允许 `size + mtime` 命中时直接复用旧 hash。[`testing.md`](../docs/zh-CN/testing.md) L133 还准备把该行为固化为测试。

反例：

1. manifest 已缓存远端版本 `R0` 的 hash。
2. 同步工具以相同 size、相同 mtime 的发散内容 `R1` 替换文件。
3. 本机文件 `L` 是 `R0` 的延长版本。
4. Planner 复用旧 hash，误以为实际的 `R1` 仍是 `L` 的前缀。
5. `PUSH_OVERWRITE` 静默覆盖 `R1`。

指导意见：

- manifest hash 只能用来筛选候选，不能直接授权 `PUSH_OVERWRITE`、`PULL_OVERWRITE` 或 `CONFLICT`。
- 任何覆盖前，都必须从本次打开的文件句柄验证真实 hash/前缀。
- 读取前后和 rename 前重新 `stat`；快照变化就取消 action 并重规划。
- 对长期 `NOOP` 做周期性 scrub，避免同 size/mtime 的变化永久不可见。
- 增加“同 size、同 mtime、内容不同”的固定回归测试。

### 4.3 冲突状态不能依赖可丢失的 manifest

严重程度：**Blocker / 幂等性**

[`architecture.md`](../docs/zh-CN/architecture.md) L499–505 把 `conflict:true` 存入 manifest，并据此让后续 pass 永久 `NOOP`。这与 manifest 可删除、可重建、非权威的定义冲突。

可能结果：

- manifest 丢失后，每轮 pass 重复生成 quarantine 副本。
- manifest 状态陈旧时，即使用户已手工恢复成相同或严格前缀，session 仍被永久冻结。

指导意见：

- 用 `(logicalId, hashL, hashR)` 构造确定性的冲突 ID 和隔离路径。
- 每次 pass 仍根据真实文件重新判断状态。
- 两侧恢复为相同或严格前缀时自动解除陈旧冲突状态。
- M1 至少提供 `Keep local`、`Keep sync-dir`、`Reveal conflict copies` 三个命令；完整 UI 可留到 M3。
- 外部同步工具生成的冲突文件应复制或记录后忽略，不宜直接移动并传播删除。

### 4.4 双机并发下“最坏只冲突、不丢数据”的承诺不成立

严重程度：**Blocker / 数据正确性**

[`architecture.md`](../docs/zh-CN/architecture.md) L548–554 声称两台机器同时 pass 时最坏只产生冲突。然而两台机器可以都基于旧远端版本完成 plan，然后依次 rename；后写者不会自动看到先写者的新内容。这不是 compare-and-swap。

原子 rename 只能保证一次替换不出现半文件，不能保证“检查时看到的目标仍是当前目标”。

指导意见有两个可选层级：

1. **M1 保留当前 canonical 文件布局**：降低保证为 best-effort；apply 前重新读取并验证目标；覆盖 sync-dir 前保存旧远端版本；明确仍存在最终竞争窗口。
2. **需要严格无损保证**：改用按 `logicalId/machineId/generation-hash` 保存的不可变 head/candidate，永不让两台机器覆盖同一路径；收敛和 GC 后置。

如果继续采用当前布局，文档必须撤掉绝对的“不会丢数据”承诺，并明确它只适用于没有同时写同一 session 的受支持流程。

### 4.5 mtime 活跃判断和 apply 之间存在 TOCTOU

严重程度：**Blocker / 数据正确性**

[`architecture.md`](../docs/zh-CN/architecture.md) L517–521 使用 `now - mtime < 30s` 判断活跃文件，并在 L564 声称跨机时钟差不影响正确性。这两者不能同时成立：同步工具可能保留来源机器时间戳，未来 mtime 会长期 DEFER，过旧 mtime 又可能让传输中的文件被当作稳定文件。

此外，CLI 可以在 guard 后重新开始追加。POSIX 上 rename 一个已打开文件后，CLI 可能继续写旧 inode，新追加内容不在备份或替换后的路径中。

指导意见：

- 将轻量 active/size guard 放到 hash 之前。
- 本机文件必须在两个观察点之间保持 `size + mtime + tail` 稳定。
- hash/copy 后及 rename 前再次检查快照。
- sync-dir 侧使用“本机首次观察到该签名后稳定了多久”，不要使用来源 mtime 年龄。
- 明确 30 秒只是启发式保护，不是进程互斥。
- 增加 barrier 控制的测试：hash 中途追加、备份后追加、rename 前追加、目标文件已打开时替换。

### 4.6 machineId 与机器相关设置不能放在可能同步的 data.json

严重程度：**High / 身份与配置**

[`architecture.md`](../docs/zh-CN/architecture.md) L102 将 `machineId` 定义为不同步的本机标识，但 L595 又计划将它放入插件 `data.json`。配置模型 L570–590 还包括 `syncDir`、`localDirOverride`、`machineLabel` 等机器相关数据。

Obsidian vault 配置可能随用户的同步工具一起传输，因此两台机器可能获得相同 machineId，或者 Mac/Windows 的绝对路径互相覆盖。

指导意见：

- `<homedir>/.ai-session-sync/machine.json`：保存 machineId，排他创建并限制权限。
- `<homedir>/.ai-session-sync/workspaces/<workspaceId>.json`：保存 syncDir、本机 provider 路径和 machine label。
- vault/plugin data 中只存允许跨机同步的可移植设置。
- 检测到同一 machineId 对应不同 hostname/platform 时停止依赖该 ID，并提示重新生成。

### 4.7 workspaceId 初始化存在双机分裂风险

严重程度：**High / 身份初始化**

[`architecture.md`](../docs/zh-CN/architecture.md) L229–240 规定首次运行自动生成 workspaceId，并期待它随 vault 同步。若两台新机器在该文件到达前同时启动，会各生成一个 UUID。

此外，L634 又建议把整个 `.ai-session-sync/` 加入 `.gitignore`，这会阻断使用 Git 同步 vault 的用户传递 `workspace.json`。

指导意见：

- 首台机器执行“创建 workspace”，其他机器执行“加入已有 workspace”；或者明确要求首机同步完成后才能启用次机。
- workspace 文件使用原子排他创建。
- 发现 workspace 文件 ID 改变、冲突副本或同一 vault 对应多个 ID 时，停止写入并进入恢复流程。
- `workspace.json` 必须被同步。若目录中以后包含本机缓存，应只忽略其他内容并显式保留该文件。

### 4.8 缺少不可信路径边界

严重程度：**High / 安全与数据完整性**

[`architecture.md`](../docs/zh-CN/architecture.md) L295–299 允许 adapter 返回 `neutralRel`，L327–328 再把它映射为目标绝对路径。sync-dir 内容来自外部同步系统，应按不可信输入处理。

当前没有明确处理：

- `..`、绝对路径、盘符或 UNC 注入。
- symlink、hardlink、Windows junction/reparse point。
- `workspaceIdOverride`、logicalId、customDirName 的非法字符。
- sync-dir、provider root、backup、vault 互相嵌套。
- session symlink 指向凭证文件并被同步出去。
- 临时文件、备份和日志权限比原 session 更宽松。

指导意见：

- 引入 `SafeRelativePath` 类型，禁止未经验证的字符串进入写路径。
- 使用 `resolve + relative` 和逐级 `lstat/realpath` 做 containment 校验。
- 拒绝 symlink/junction 越界以及各 root 的祖先/后代重叠。
- workspaceId 必须是小写 UUID；customDirName 必须是单目录段。
- 临时文件排他创建；目录默认最小权限，文件保持或收紧原权限。
- 增加 Windows 保留名、尾随点/空格、路径长度和大小写碰撞测试。

### 4.9 Claude Code 的 Tier A 核心假设尚未验证

严重程度：**High / M1 Spike**

[`architecture.md`](../docs/zh-CN/architecture.md) L281–285 已把 Claude Code 标成 Tier A，但 L344–357 的实测只证明目录和字段形态，没有证明整个 session 生命周期严格 append-only。

建议新增一个 M1 阻塞 Spike，覆盖：

- 新建、连续 resume。
- compact、fork/branch、retry。
- 异常中止后再次 resume。
- CLI 版本变化。
- 每一步旧文件是否都是新文件的精确字节前缀。
- 文件名是否稳定等于 logicalId。
- 末行是否始终有换行、0 字节文件的含义、未知扩展名是否被扫描。

Spike 通过后才能标 Tier A ✅；否则应保持只读或按 opaque divergent 文件处理。

### 4.10 远端未就绪与远端为空无法区分

严重程度：**High / 启动安全**

架构允许同步工具延迟到达，但 preflight 只检查目录是否存在、可写；`L 存在、R 不存在` 会立即 `PUSH_NEW`。云盘目录已创建但尚未水合时，插件可能把“尚未到达”误判为“远端不存在”。参见 [`architecture.md`](../docs/zh-CN/architecture.md) L90、L407、L424。

指导意见：

- 增加 `.aiss/root.json` 或等价初始化标记。
- 本机记录 remote 已经成功初始化过的状态。
- 根标记消失、workspace 子树突然清空或文件数异常下降时进入 `REMOTE_NOT_READY`，禁止 push。
- 首次连接默认 dry-run/只读，待目录快照连续稳定后再允许 push。

### 4.11 备份开关与安全不变量冲突

严重程度：**High / 恢复能力**

[`testing.md`](../docs/zh-CN/testing.md) L17、L212 要求任何覆盖前必有备份，但 [`architecture.md`](../docs/zh-CN/architecture.md) L586 暴露了 `backup.enabled`。

指导意见：

- M1 不允许关闭覆盖前备份，只允许设置保留份数。
- 如果未来允许关闭，必须明确这是用户主动放弃哪条安全保证，并修改测试不变量。
- `<ISO时间戳>` 含 Windows 禁止的 `:`，文件名应改为 `20260806T110000.123Z`、epoch milliseconds 或其他文件系统安全格式。
- 同一毫秒内增加随机值或单调序号，避免备份名碰撞。

## 5. 测试方案审核

### 5.1 I1 的“行集合不缩小”不是可用的不变量

严重程度：**Blocker**

[`testing.md`](../docs/zh-CN/testing.md) L17、L210–214 使用“行集合不缩小”表达无数据丢失。集合忽略顺序和重复次数，因此重排行或删除重复行仍可能通过测试，但 session 已经损坏。

建议改为有序字节流可恢复性：

> 对 pass 前存在的每个不同文件版本 `v`，pass 后必须满足下列条件之一：
>
> 1. 某个 live 文件以 `v` 的完整字节作为严格前缀；或
> 2. `v` 的完整字节仍存在于 backup 或 quarantine，且 hash 完全一致。

附加规则：

- `CONFLICT` 时两个 primary 均不得改变。
- 冲突隔离不能作为宽泛例外；隔离前后的版本 hash inventory 必须一致。
- 所有 mutation 前后的不同分支都必须可恢复。

### 5.2 I2 对合法冲突历史不可能成立

严重程度：**Blocker**

属性测试允许 `A.append`、`B.append` 从共同基线产生发散，但 [`testing.md`](../docs/zh-CN/testing.md) L213 又要求静默期后“三处一致并全 NOOP”。这与 S-03 的 `CONFLICT` 预期以及 U-13 的冲突冻结语义直接矛盾。

应拆成两组 property：

1. **无分叉、因果有序历史**：最终 canonical 字节级一致，之后全 `NOOP`。
2. **任意历史**：最终进入“完全收敛”或“稳定冲突”；稳定冲突必须保存所有分支 hash，重复 pass 不产生新隔离文件。

增加显式解决操作后，再验证 `resolve -> flush -> pass` 能恢复收敛。

### 5.3 L2 只有一个 syncDir，不能模拟真实传输

严重程度：**Blocker**

[`testing.md`](../docs/zh-CN/testing.md) L162–180 的 world 只创建一个 `syncDir + 两个 fakeHome`，却又调用 `transport.flush()` 模拟延迟、乱序和截断。双方共享同一目录时，flush 没有真实语义。

应改成：

```text
localA <-> syncReplicaA <-> transport/event queue <-> syncReplicaB <-> localB
```

transport 至少需要独立控制：

- A 到 B、B 到 A 两个方向。
- session 与 manifest 独立、乱序到达。
- mtime 保留或重写。
- 临时文件、截断文件、冲突副本、占位文件。
- 延迟、重复、删除和 last-writer-wins。

无冲突时比较四个位置的 canonical 内容；发生冲突时比较分支 hash inventory，而不是强制全部一致。

### 5.4 需要加入精确的竞态和崩溃点测试

严重程度：**Blocker**

当前 S-05 只测试扫描前已经活跃的文件，随机操作也是完全串行的。应通过 barrier/hook 在以下位置注入变化：

- stat 后、hash 前。
- hash/copy 过程中。
- backup 后、rename 前。
- rename 后、manifest commit 前。
- 文件落地后、Provider index reconcile 前。
- 两个 `runPass()` 真正重叠。
- 两个 engine 实例争用锁。

[`testing.md`](../docs/zh-CN/testing.md) L195 的 S-09 还应拆成两类：

- 可捕获的单 action 失败：继续其他文件，并 commit 成功项。
- 真正的进程崩溃：commit 阶段不会执行，重启时从真实文件重建。

### 5.5 缺少不可信目录的安全测试

严重程度：**Blocker**

至少加入：

- `../`、绝对路径、盘符/UNC、NUL、Windows 保留名。
- 恶意 workspaceId、logicalId、neutralRel、manifest key。
- symlink、hardlink、junction、reparse point。
- sync-dir/provider/backup/vault 路径重叠。
- symlink session 指向凭证文件。
- `.credentials.json`、`auth.json` 永不被扫描或复制。
- temp、backup、session 的权限不被放宽。

所有异常均应 fail closed，且不得发生范围外读写。

### 5.6 三处策略需要统一

严重程度：**High**

1. **0 字节文件**：`testing.md` L114 把它视为不存在并 `PULL_NEW`；`architecture.md` L560 则要求一律跳过。应分别定义 `L=0/R=good`、`L=good/R=0`、稳定/不稳定等组合，默认保守 `DEFER` 或隔离。
2. **更高 schemaVersion**：`testing.md` L131 要求“需要重建”，而 `architecture.md` L407 要求先校验兼容性。旧客户端遇到更高版本应只读或中止，绝不能重建并覆盖新格式。
3. **时钟差**：S-14 要求两小时差时“决策完全一致”，但 active 判定依赖 `now - mtime`。应改为“文件经本机稳定性判断后，内容方向不依赖绝对时钟”，并单测未来 mtime、负 age 和粗粒度时间戳。

### 5.7 CI 片段尚不能作为执行规范

严重程度：**High**

[`testing.md`](../docs/zh-CN/testing.md) L328–340 的 CI 只是片段，且当前仓库没有对应脚本。`node -e "require('./main.js')"` 也不能可靠证明 Obsidian bundle 可加载，因为生产 bundle 通常依赖 Obsidian runtime。

建议 M0 明确建立：

- `package.json` 与 lockfile。
- 固定 Node、TypeScript、Vitest、esbuild、ESLint 版本。
- `typecheck`、`lint`、`test`、`build` 的本地 package scripts。
- Ubuntu/macOS/Windows 三平台 workflow。
- Obsidian stub/module hook smoke test，或 bundle/export/manifest 合同测试。
- `manifest.json` 的 `isDesktopOnly`、id、version、minAppVersion 校验。
- M1 blocker 测试不得出现 `.skip`、`.only` 或未处理的 `.todo`。
- nightly 保存 fast-check seed、path 和最小反例 artifact。

### 5.8 真机验收证据不足

严重程度：**High**

[`testing.md`](../docs/zh-CN/testing.md) L250 只强制步骤 4、6、8、9，但 L256 又要求整个剧本通过。建议统一为 M1 的十个步骤全部通过。

`wc -l` 不能证明 I3。验收记录至少应包含：

- SHA-256。
- 字节数和行记录数。
- 末尾换行状态。
- JSONL 全量解析结果。
- macOS/Windows、Claude Code、Obsidian、Claudian、插件 commit、同步工具及配置版本。
- 分叉前后两个分支的 hash inventory。

## 6. M2 前必须补完的设计

### 6.1 Tier B 的 afterPull 不是可恢复操作

[`architecture.md`](../docs/zh-CN/architecture.md) L334–335 只在 pull 落地后调用 `afterPull(applied)`。如果文件已经落地、SQLite 索引尚未更新时崩溃，下次文件会变成 `NOOP`，hook 可能不再触发，session 将永久不可见。

建议：

- 改为幂等的 `reconcileLocalIndex(desiredSessions, ctx)`，每次启动/pass 都可以调用。
- 本机保存 pending journal，文件组和索引事务完成后再清除。
- 优先使用官方 import/reindex 命令，不直接写第三方 SQLite。

### 6.2 多文件 session 不能逐文件独立提交

session 被定义为一个 primary 加多个 aux，但 [`architecture.md`](../docs/zh-CN/architecture.md) L410–413 规定每个文件独立执行和失败。这可能生成只有 rollout、没有必要元数据或索引的撕裂 session。

建议：

- apply 单元提升为 session group。
- 明确 required aux 与 optional aux。
- 所有 required 文件成功后才能提交本机可见状态和索引。

### 6.3 opaque-file 缺少决策表

接口定义了 `append-jsonl`、`opaque-file`、`index-backed`，但唯一决策表只覆盖 append-jsonl。不能沿用 `CLAUDE.md` 中“非 jsonl 按 mtime”的旧规则，因为跨机 mtime 不可信。

建议 opaque-file 使用：

- hash 相同：`NOOP`。
- 仅一侧存在：复制。
- 双方存在且 hash 不同：`CONFLICT`。
- Provider 明确声明可重建的元数据：由 adapter 重建，不参与通用覆盖竞争。

### 6.4 增加中立布局版本与升级策略

manifest 有 `schemaVersion`，但 sync-dir 根布局没有独立的 `formatVersion`。

建议：

- 在 `.aiss/root.json` 中加入中立布局版本。
- 遇到高于当前插件支持的版本时只读并提示升级。
- 旧格式迁移必须幂等，迁移前保存恢复点。
- M2 发布前增加“一台旧版、一台新版”的兼容测试。

## 7. 其他文档一致性问题

以下问题不会单独阻断 M1，但应在语义冻结时一并修正：

- `architecture.md` L388 称“一次 pass 的七个阶段”，实际 P0–P7 共八个阶段。
- `testing.md` L92 同时要求 `escape(escape(p))` 幂等，又规定第二次输入不是绝对路径时应抛错；应统一为“第二次调用必须拒绝”。
- `architecture.md` L521 把“无末尾换行”直接等同于“不完整 JSON”。合法 JSON 文本可以没有末尾 LF；应结合 JSON 解析和稳定性观察，或由 Spike 证明 Provider 始终写 LF。
- `architecture.md` L441 的累计 SHA checkpoint 本身不足以跳过前面字节；若要随机定位，还需要 byte offset 和分块 hash，或 M1 先采用完整流式比较。
- `architecture.md` L541 的 ISO 时间戳在 Windows 文件名中非法。
- `architecture.md` L509 的 OneDrive `*-<机器名>.jsonl` 模式过宽，可能误隔离合法 session；应先按 Provider 的 logicalId 和内容结构验证。
- `AdapterCtx` 缺少测试文档要求注入的 `platform`、`homedir`、`machineId`、`IdGen`；建议增加统一的 `RuntimeEnv/SystemInfo`。
- dry-run 应明确是否允许 preflight 清理 tmp。若承诺“无写入”，应断言 session、manifest、backup、quarantine 和 tmp 树前后完全一致。
- `maxFilesPerPass` 需要公平性测试，防止排序靠后的 session 永久饥饿。
- 日志和 PassReport 应使用含密钥 sentinel 的测试，证明不会输出 session 内容。

## 8. 建议的 M1 质量门禁

### 8.1 文档语义冻结

- [ ] `CLAUDE.md` 与 architecture 的前缀语义一致。
- [ ] Codex 当前统一为 Tier C，只读。
- [ ] I1 改为有序字节流可恢复性。
- [ ] I2 拆成无分叉收敛和稳定冲突两类。
- [ ] 统一 0 字节、高 schema、mtime、备份开关的语义。
- [ ] 明确当前并发保证是 best-effort，或采用不可变 heads。
- [ ] 明确本机状态、vault 状态、sync-dir 状态的存储边界。

### 8.2 M1 阻塞 Spike

- [ ] OQ-1：`cwd` 是否影响跨平台 resume。
- [ ] OQ-3：Windows 路径转义。
- [ ] OQ-5：CLI 对未知扩展名的行为。
- [ ] Claude Code 完整生命周期是否严格 append-only。
- [ ] 末行换行、0 字节、文件名和 logicalId 规则。

### 8.3 自动化安全门禁

- [ ] 决策表全部组合及优先级测试通过。
- [ ] 同 size/mtime、内容不同的回归测试通过。
- [ ] 两个 sync replica 的 L2 模型完成。
- [ ] 无分叉收敛 property 和稳定冲突 property 分开通过。
- [ ] TOCTOU、重叠 pass、锁和 crash-point matrix 通过。
- [ ] traversal、symlink/junction、目录重叠、凭证排除测试通过。
- [ ] 所有 M1 blocker 测试无 skip。

### 8.4 三平台 CI

- [ ] `npm ci`、typecheck、lint、L0/L1/L2、build 全绿。
- [ ] Obsidian stub smoke 和 manifest contract 通过。
- [ ] Windows 原生 rename、路径及安全文件名测试实际执行。
- [ ] coverage 门槛由配置真正强制。

### 8.5 真机验收

- [ ] M1 十步剧本全部通过。
- [ ] Mac -> Windows -> Mac 双向均有字节 hash 证据。
- [ ] 分叉后所有分支可恢复，连续 pass 不新增重复隔离副本。
- [ ] 备份恢复与启动同步通过。
- [ ] 验收记录包含完整版本和同步工具配置。

## 9. 推荐实施顺序

1. 修订 `CLAUDE.md`、architecture 和 testing，冻结正确性语义。
2. 完成 workspace/machine 状态拆分、路径安全和远端 readiness 设计。
3. 完成 Claude Code append-only、Windows 路径及跨平台 resume Spike。
4. 建立 M0 脚手架：package、TypeScript、Vitest、esbuild、Obsidian manifest、CI。
5. 先实现纯领域层与新的 I1/I2 property。
6. 实现文件系统安全写入、备份、快照复查和错误注入测试。
7. 建立双 replica L2 world，完成延迟、乱序、截断、冲突和崩溃恢复测试。
8. 最后接入 Obsidian UI，并执行 Mac/Windows 真机验收。

## 10. 总体评价

这两份设计文档已经具备较好的工程思维：核心边界清楚，风险意识强，测试优先级也以数据安全而非覆盖率为中心。最值得肯定的改进，是将原始的“行数多者胜”升级为严格前缀判断。

当前主要问题是若干强承诺尚未被数据模型真正支撑，测试中的不变量也没有完全形式化。先解决 manifest 权威边界、并发竞态、身份状态、路径安全和冲突终态，再进入实现，可以显著减少后续推翻核心架构的风险。
