# HANDOFF — 交接说明

> 更新时间：2026-08-07。本文描述**当前进度快照**，供下一个会话（或下一个人）接手。
> 读本文前先读 [CLAUDE.md](CLAUDE.md)（产品边界）→ [docs/zh-CN/architecture.md](docs/zh-CN/architecture.md)（实现规范）→ [docs/zh-CN/testing.md](docs/zh-CN/testing.md)（测试与验收）。

## 当前状态：M0 完成，M1 批 1（领域层纯函数）完成并通过审核

门禁齐备且每条都被自检过；领域层五个纯函数模块落地，[review/2](review/2_m1-batch1-domain-review.md) 判定"达到设计基线，可以进入批 2"（0 个 Blocker）。下一步是批 2 的 infra 层。

| 阶段 | 状态 | 产物 |
|---|---|---|
| 架构与测试设计（第 1 版） | ✅ | architecture.md / testing.md 初稿 |
| 第三方设计审核 | ✅ | [review/1_architecture-and-testing-review.md](review/1_architecture-and-testing-review.md)（28 项 finding） |
| 按审核意见改版（第 2 版） | ✅ | 全部 finding 已落实或显式拒绝（拒绝理由见 testing.md 附录 A）；两轮独立核查（覆盖率 + 一致性）报出的 31 处问题已修完 |
| 真机探测套件 | ✅ | `tmp/probe/`（不入库）；经安全审查修掉 3 个泄漏级 bug 后交付 |
| **macOS + Windows 真机探测** | ✅ | 原始报告与逐条判定归档在 [docs/zh-CN/findings/](docs/zh-CN/findings/)；结论已回填两份文档 |
| **M0 脚手架** | ✅ **完成** | G-01…G-11 全部交付并自检；`npm run verify` 本地全绿（`npm test` 102 条 + `check:bundle` 20 条）。落地清单见 [testing.md §12.7](docs/zh-CN/testing.md) |
| **M1 批 1 · 领域层** | ✅ **完成** | 5 个模块，230 条 m1 用例，domain 覆盖率 98%；[review/2](review/2_m1-batch1-domain-review.md) 的建议已处理（见下） |
| M1 批 2–4 | ⬜ 未开始 | — |

### M0 交付了什么

工具链 exact pin（Node 20.20.2 / TS 5.9.3 / vitest 4.1.10 / esbuild 0.28.1 / ESLint 10.8.0 / fast-check 4.9.0），三平台 CI，六个 `check:*` 门禁（五个是 `scripts/check-*.mjs`，`check:bundle` 是一份独立 vitest 配置），bundle 三层合同测试，覆盖率强制，`.gitattributes` 行尾锁定。

**M0 的核心不是"配置文件写好了"，而是每条门禁都被喂过应当拦下的输入**——lint 规则、门禁脚本、覆盖率门槛、反例产物各有一组自检（[tests/README.md](tests/README.md)）。一条从未见过它报错的门禁，和一条条件写反了的门禁，长得一模一样。

本地一条命令跑完 CI 的全部步骤：

```bash
npm run verify      # check:pinned-deps → typecheck → lint → check:secrets → check:docs
                    # → test → build → check:bundle → check:manifest → check:no-skip
```

> ⚠️ 开发机（Linux remote-ssh）自带 Node 18，跑不动 vitest 4 与 ESLint 10。**需要 Node ≥ 20.19**（`.nvmrc` 写的是 20.20.2）。

## 关键事实（已实测，写代码前必须知道）

1. **OQ-8 PASS，无需降级**：Claude Code 的 session jsonl 在 compact / fork / retry / 强杀 / 跨版本（2.1.211–2.1.223）下全部**严格追加**。前缀安全合并的地基成立。compact 和 fork 都不产生新文件、不换 sessionId。
2. **转义规则 = `realpath(p)` 逐字符映射**：保留 `[A-Za-z0-9-]`，其余任何字符各变一个 `-`。**输入是 realpath 不是 cwd 字符串**——adapter 落位前必须 `fs.realpathSync.native`。规则不可逆（反转义只做诊断）。
3. **OQ-1 通过**：跨平台 resume 不受 `cwd` 影响，`toNeutral`/`fromNeutral` 保持 **identity**。
4. **Codex 是 Tier A 候选**（不是原设想的 Tier B）：0.146.0 靠扫目录发现会话，只拷 rollout 文件即可见；sqlite 索引不用碰。M2 接入。
5. **picker 陷阱（F-1）**：`claude --resume` 列表只显示交互式来源的会话；同步验证一律**按 ID resume**。
6. 空会话不落盘（CLI 永不产生 0 字节 jsonl）；末尾恒 LF；Windows 目录 fsync 返回 EPERM（FsGateway 需跳过）。
7. 其余计划外发现 F-1…F-9 见 [findings/2026-08-06-spike-conclusions.md](docs/zh-CN/findings/2026-08-06-spike-conclusions.md)。

## 下一步：M1（依据 review §9 与两份文档）

- ✅ **批 1 · 领域层纯函数（已完成）**：`path-escape` / `path-safety` / `merge-policy` / `stability` / `planner`，230 条 m1 用例，domain 覆盖率 98%
  - **U-07**（分叉 → CONFLICT，不是覆盖）在 `planner.test.ts` 与 `merge-policy.test.ts` 各有一条
  - **U-18** 三层俱全：类型级（`PlanInput` 上不存在任何 hash 缓存字段，`expectTypeOf` 断言）、等长不同内容 → CONFLICT、`observedHash` 命名本身表明只接受本次观察
  - §5.2.7 笛卡尔积穷举 1000+ 组合，四条与优先级无关的纯安全断言（发散不覆盖 / NOT_READY 不写 / 未读全不判发散 / 0 字节不冲突）
- ⬜ **批 2 · infra（下一步）**：`FsGateway`（原子写、win32 跳过目录 fsync）、三处状态 store、备份（含 `backups/remote/`）、`PathGuard`
  - 批 1 已经把接口形状定下来了：`FsGateway` 的写方法只收 `SafeAbsolutePath`（`src/domain/types.ts`），`PathGuard` 是**唯一**能铸造它的地方（lint 已强制，见 `eslint-rules.test.ts` 的 branded-path 组）
  - E0 签名按**分量**存进 ledger，不要只存 sha256——未来 mtime 的降级路径需要"剔除 mtime 后重算"，只有摘要就做不到（`src/domain/stability.ts` 顶部有说明）
- ⬜ **批 3 · SyncEngine + L2**：九阶段 pass、VO 协议、双 replica world、S-01…S-20、崩溃点矩阵 R-01…R-13、I1/I2 属性测试

  **批 3 首批用例认领表**（来自 [review/2](review/2_m1-batch1-domain-review.md) §4，批 1 因分层归属写不了的那些，别漏）：

  | 用例 | 内容 | 为什么现在写不了 |
  |---|---|---|
  | **U-18b 集成形态** | 真实 tmpdir：写 `R0` → 等长 `R1` + `utimes` 还原 mtime → 跑 pass → 必须 `CONFLICT` | 需要 FsGateway（批 2）+ SyncEngine。**U-18 的"最重要测试"地位要求它进批 3 首批**，批 1 只有领域层那一半 |
  | U-12b 备份断言 | 0 字节被 `PULL_OVERWRITE` 覆盖时，备份区确实有那份 0 字节备份 | 需要备份模块（批 2） |
  | `malformedTail` → Notice | planner 打 flag，报告层要真的渲染成 `MALFORMED_TAIL` + Notice | U-11d 要求"让用户看见"，planner 不产 Notice；这一半悬在批 3/4 |
  | U-14 | 空目录 → 空 Action 列表，不报错 | work-list 层 |
  | U-16 / U-17 | `AWAIT_INIT` 零写入；文件数骤降 → `NOT_READY` 且不解释成"远端删了" | 就绪状态机（§9.6） |
- **批 4 · Obsidian UI** → 真机十步验收（[testing.md §9.4](docs/zh-CN/testing.md)；两台机器的 `~/aiss-probe` 都还留着可复用）

批 1 从 `path-escape` 起步的具体理由：样本表已经全部实测（[testing.md §5.1](docs/zh-CN/testing.md) 12 条 `verified: true`），是唯一一个"输入输出都已知、可以纯表驱动写完"的模块，能顺带把 `tests/m1/` 建起来让 `check:no-skip` 从"M0 空跑"转成真门禁。

`src/main.ts` 目前是**纯装配骨架**：注册状态栏 / ribbon / 三个命令（`sync-now`、`dry-run`、`show-last-report`，都只弹 "not implemented"）/ 设置页，并把首次 pass 挂到 `onLayoutReady` 上排队。改动它时注意 `tests/build/artifact-smoke.test.ts` 里的 `EXPECTED_COMMAND_IDS` 是**故意写死的字面量**——增删命令必须同步改，这是让 UI 面变化被人过一遍眼的设计。

## 阻塞项

无阻塞，可直接开工 M1。以下是已知的非阻塞欠账：

| 项 | 性质 | 说明 |
|---|---|---|
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
docs/zh-CN/testing.md            测试与验收。I1–I4 不变量、U/S/R/SEC 用例表、M0 门禁 §12（§12.7 是落地清单）、真机剧本 §9.4
docs/zh-CN/findings/             真机探测归档：两份原始报告 + spike-conclusions（逐条判定与回填映射）
review/                          第三方审核报告（设计决策的原始依据，已入库）

src/main.ts                      Obsidian 入口，纯装配骨架
scripts/                         构建脚本与五个门禁脚本；门禁都吃 --root 参数，好让自检指向临时目录
  build.mjs                        esbuild → main.js + dist/meta.json（--dev 进 watch）
  lib/gate.mjs                     门禁公共约定：退出码、违规汇总输出、--root/--report 解析
tests/README.md                  哪个目录受哪条门禁约束——加测试前先看这张表
tests/helpers/                   obsidian-stub.ts（记录型 stub）、fast-check.ts（fcAssert + 反例产物）
tests/build/                     脚手架自检：bundle 合同、门禁脚本、lint 规则、覆盖率强制
.github/workflows/ci.yml         三平台 job + nightly property job
.gitattributes                   eol=lf；fixtures 与 *.jsonl 完全不转换

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

M0 新增的几条（违反了会在 CI 上以很难懂的方式炸掉）：

- **`package.json` 不写 `"type": "module"`**——Obsidian 按 CJS 加载 `main.js`。仓库工具链靠 `.mjs` / `.mts` 扩展名走 ESM
- **属性测试用 `fcAssert` 而不是 `fc.assert`**（lint 会挡），否则 nightly 失败不留反例产物
- **`domain/` 里不许出现 `RuntimeEnv` 这个标识符**（连类型位置都不行）、不许 `../` 任何路径、不许 `Date.now()` / `Math.random()`；领域层只收 `SystemInfo` 纯数据与 `nowMs`
- **不许 `as SafeAbsolutePath`**——只有 `infra/path-guard.*` 与 `domain/path-safety.*` 能铸造 branded 路径
- **改 `eslint.config.mjs` 时注意 flat config 的规则选项是替换不是合并**：同一个 rule id 在后面的 config 对象里再声明一次，前面的选项整个失效。加规则时把上一档的常量一起带上（`NETWORK_MODULES` / `REQUIRE_NODE_FS_BAN` / `DOMAIN_SYNTAX_RULES`），并让 `eslint-rules.test.ts` 跑一遍
- **tsconfig 的 `include` 不支持花括号展开**（ESLint 的 `files` 支持）。写成 `src/**/*.{ts,mts}` 会让 typecheck 检查空集合并"通过"；`toolchain.test.ts` 就是为此存在的
- **升 TypeScript 前先确认 typescript-eslint 的 peer 范围**（当前 `>=4.8.4 <6.1.0`，所以 TS 停在 5.9.3，不能跳 7.x）
- 加/删命令要同步改 `tests/build/artifact-smoke.test.ts` 的 `EXPECTED_COMMAND_IDS`

### 待做的杂项（非阻塞，顺手时处理）

- macOS 侧 OQ-1 Round 2（Windows 包落到 mac 再验一次反方向）——Windows→mac 方向已验过，此项只是对称补全，优先级低
- 探测套件的三个 F-8 修复（脱敏）已完成并验证；套件如再派发，直接用当前版本
- **三平台 CI 只在 Linux 上实跑过**：GitHub Actions 的 macOS / Windows job 还没有第一次绿灯记录（本机没有这两个平台）。首次 push 后确认，尤其是 `eslint-rules` 与 `gate-scripts` 两组涉及路径分隔符的测试
- branch protection 的 required checks 还没配（Q-30 要求三平台 job 名进去），否则门禁不生效

### M1 期间必须补上的门禁欠账

M0 的自检把"门禁本身能不能拦住东西"验完了，但下面几项**要等 M1 有代码/测试之后才能装**，别忘了：

| 项 | 什么时候装 | 说明 |
|---|---|---|
| ~~`check:no-skip --min`~~ | ✅ 已装（`--min 100`，当前 162 条） | 加测试时不必调它；只有**大幅**扩容后才值得提高下限 |
| Q-32 Windows 执行数 ≥ ubuntu 的 95% | M1 收尾 | 目前无任何实现；需要跨 job 比对 `reports/vitest.json` |
| type-aware lint | 批 2 起 | `@typescript-eslint/no-floating-promises` 才能挡住漏写 `await this.barrier(...)`；需要开 `projectService`，会拖慢 lint，值得 |
| §11.2 `PassReport` 字段禁令 | 批 3 | 类型层禁止 `content` / `buffer` / `bytes` / `lines: string[]` / `sample` / `head` / `tail`，配 `expectTypeOf` 断言 |
| `src/ui/**` 覆盖率归属 | 批 4 | 现在 UI 落在全局 80% 门槛下，表现层按 §4 是靠 stub smoke + 人工验收的，落地时要么显式 exclude（照 `main.ts` 的先例）要么补测试——**别顺手调低全局门槛** |
