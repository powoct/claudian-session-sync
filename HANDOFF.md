# HANDOFF — 交接说明

> 更新时间：2026-08-06。本文描述**当前进度快照**，供下一个会话（或下一个人）接手。
> 读本文前先读 [CLAUDE.md](CLAUDE.md)（产品边界）→ [docs/zh-CN/architecture.md](docs/zh-CN/architecture.md)（实现规范）→ [docs/zh-CN/testing.md](docs/zh-CN/testing.md)（测试与验收）。

## 当前状态：设计冻结完毕，真机事实闭环，M0 未开始

仓库处于 **pre-code** 阶段：没有 `src/`、没有 `package.json`、没有 CI。已完成的是全部前置工作：

| 阶段 | 状态 | 产物 |
|---|---|---|
| 架构与测试设计（第 1 版） | ✅ | architecture.md / testing.md 初稿 |
| 第三方设计审核 | ✅ | [review/1_architecture-and-testing-review.md](review/1_architecture-and-testing-review.md)（28 项 finding） |
| 按审核意见改版（第 2 版） | ✅ | 全部 finding 已落实或显式拒绝（拒绝理由见 testing.md 附录 A）；两轮独立核查（覆盖率 + 一致性）报出的 31 处问题已修完 |
| 真机探测套件 | ✅ | `tmp/probe/`（不入库）；经安全审查修掉 3 个泄漏级 bug 后交付 |
| **macOS + Windows 真机探测** | ✅ | 原始报告与逐条判定归档在 [docs/zh-CN/findings/](docs/zh-CN/findings/)；结论已回填两份文档 |
| M0 脚手架 | ❌ **未开始**（等用户确认后启动） | — |

## 关键事实（已实测，写代码前必须知道）

1. **OQ-8 PASS，无需降级**：Claude Code 的 session jsonl 在 compact / fork / retry / 强杀 / 跨版本（2.1.211–2.1.223）下全部**严格追加**。前缀安全合并的地基成立。compact 和 fork 都不产生新文件、不换 sessionId。
2. **转义规则 = `realpath(p)` 逐字符映射**：保留 `[A-Za-z0-9-]`，其余任何字符各变一个 `-`。**输入是 realpath 不是 cwd 字符串**——adapter 落位前必须 `fs.realpathSync.native`。规则不可逆（反转义只做诊断）。
3. **OQ-1 通过**：跨平台 resume 不受 `cwd` 影响，`toNeutral`/`fromNeutral` 保持 **identity**。
4. **Codex 是 Tier A 候选**（不是原设想的 Tier B）：0.146.0 靠扫目录发现会话，只拷 rollout 文件即可见；sqlite 索引不用碰。M2 接入。
5. **picker 陷阱（F-1）**：`claude --resume` 列表只显示交互式来源的会话；同步验证一律**按 ID resume**。
6. 空会话不落盘（CLI 永不产生 0 字节 jsonl）；末尾恒 LF；Windows 目录 fsync 返回 EPERM（FsGateway 需跳过）。
7. 其余计划外发现 F-1…F-9 见 [findings/2026-08-06-spike-conclusions.md](docs/zh-CN/findings/2026-08-06-spike-conclusions.md)。

## 下一步：M0 脚手架（约半天）

按 [testing.md §12](docs/zh-CN/testing.md) 的 G-01…G-11 逐条交付，**M0 完成前不写第一行 `src/`**：

1. `package.json` + lockfile；`.nvmrc`（Node 20.x）；devDependencies 全部 exact pin
2. `tsconfig` / ESLint（`domain/` 禁 import `obsidian`/`fs`/`path`/`os`、禁出现 `RuntimeEnv` 标识符）
3. vitest 配置（coverage `all: true` + `autoUpdate: false`，分层门槛）
4. esbuild（`--metafile`）+ Obsidian `manifest.json` + `versions.json`
5. 七个门禁脚本：`check:pinned-deps` / `check:secrets` / `check:bundle` / `check:manifest` / `check:no-skip` / `check:docs` / `test:nightly`
6. 三平台 CI workflow（ubuntu / macos / **windows 必跑**）+ nightly property job

M0 之后的 M1 实现顺序（依据 review §9 与两份文档）：

- **批 1 · 领域层纯函数**：`path-escape`（实测样本表驱动，`EXPECTED_UNVERIFIED = 0`）→ `path-safety` → `merge-policy`（isPrefix / tailState）→ `stability` → `planner`（决策表全组合穷举；U-07 与 U-18 是全项目最重要的两条测试）
- **批 2 · infra**：`FsGateway`（原子写、win32 跳过目录 fsync）、三处状态 store、备份（含 `backups/remote/`）、`PathGuard`
- **批 3 · SyncEngine + L2**：九阶段 pass、VO 协议、双 replica world、S-01…S-20、崩溃点矩阵 R-01…R-13、I1/I2 属性测试
- **批 4 · Obsidian UI** → 真机十步验收（[testing.md §9.4](docs/zh-CN/testing.md)；两台机器的 `~/aiss-probe` 都还留着可复用）

## 阻塞项

| 项 | 性质 | 说明 |
|---|---|---|
| **用户确认启动 M0** | ⛔ 当前唯一阻塞 | 本 commit 即"M0 前状态"，等确认 |
| OQ-7 规模性能基准 | 非阻塞（M2） | 1000 session 的 pass 耗时与备份膨胀 |
| OQ-10 漫游 profile | 非阻塞（M2） | `%USERPROFILE%\.ai-session-sync` 是否被漫游同步 |
| OQ-6 生命周期 | 非阻塞（M2/M3） | OpenCode/Grok/Pi 结构已摸清，append-only 未验证 |
| UNC 路径 | 非阻塞 | 未测（无权限），实测前按不支持处理 |
| `memory/` 子目录归属 | 非阻塞 | M1 白名单不同步它，记为已知限制（F-7） |

## 交接说明

### 文件地图

```
CLAUDE.md                        产品边界与协作约定（会被 agent 自动注入；不含技术决策——刻意的，见其"文档去处"）
docs/zh-CN/architecture.md       唯一实现规范（normative）。§7.2 决策表、§9 写入安全、ADR 1–34 是核心
docs/zh-CN/testing.md            测试与验收。I1–I4 不变量、U/S/R/SEC 用例表、M0 门禁 §12、真机剧本 §9.4
docs/zh-CN/findings/             真机探测归档：两份原始报告 + spike-conclusions（逐条判定与回填映射）
review/                          第三方审核报告（设计决策的原始依据，已入库）
tmp/probe/                       探测套件（gitignore，一次性交付物；留作 CLI 大版本升级后的回归复测工具）
tmp/probe-results/               两台真机的原始产物（gitignore；报告已归档进 findings，原始 JSON 快照只在本地）
```

### 必须遵守的约定（写代码时最容易违反的几条）

- **文档去处**：技术决策只写 architecture.md（改动要同步 ADR 表）；CLAUDE.md 不复述技术决策（CI 的 `check:docs` 会挡）
- **⚠️ 的效力**：仍标 ⚠️ 的假设不得作为破坏性写入的依据，依赖它的代码路径保持只读或 dry-run
- **manifest 只能授权 NOOP**（架构 §5.3.2 授权矩阵）；`PlanInput` 类型上不得出现 manifest 派生的 hash 字段
- **备份不可关闭**；任何覆盖前必有备份（含 `PUSH_OVERWRITE` 前把远端旧版本存进本机 `backups/remote/`）
- 决策方向只由字节决定，**不读任何时间戳**；时钟只用于本机稳定性观察
- 代码 / 注释 / commit message 用英文；文档与沟通用中文

### 本 commit 之后待做的杂项（非阻塞，顺手时处理）

- macOS 侧 OQ-1 Round 2（Windows 包落到 mac 再验一次反方向）——Windows→mac 方向已验过，此项只是对称补全，优先级低
- 探测套件的三个 F-8 修复（脱敏）已完成并验证；套件如再派发，直接用当前版本
