# HANDOFF — 交接说明

> 更新时间：2026-08-09（批 4 完成 + review/4 整改，验收套件已备好）。本文描述**当前进度快照**，供下一个会话（或下一个人）接手。
> 读本文前先读 [CLAUDE.md](CLAUDE.md)（产品边界）→ [docs/zh-CN/architecture.md](docs/zh-CN/architecture.md)（实现规范）→ [docs/zh-CN/testing.md](docs/zh-CN/testing.md)（测试与验收）。

## 当前状态：M1 代码完成，剩真机十步验收

批 1–4 全部落地并通过 [review/4](review/4_m1-batch4-review.md)（0 Blocker / 0 高危）：**759 条测试、632 条 m1 阻塞用例**。插件现在能在真机上跑——设置面板、状态栏、报告视图、三条冲突命令、定时 pass 都接好了，状态全部落盘。

**下一步是真机十步验收**（Mac ↔ Windows）。执行套件已备好：**`tmp/acceptance/`**（见下方「真机验收怎么跑」）。

| 阶段 | 状态 | 产物 |
|---|---|---|
| 架构与测试设计（第 1 版） | ✅ | architecture.md / testing.md 初稿 |
| 第三方设计审核 | ✅ | [review/1_architecture-and-testing-review.md](review/1_architecture-and-testing-review.md)（28 项 finding） |
| 按审核意见改版（第 2 版） | ✅ | 全部 finding 已落实或显式拒绝（拒绝理由见 testing.md 附录 A）；两轮独立核查（覆盖率 + 一致性）报出的 31 处问题已修完 |
| 真机探测套件 | ✅ | `tmp/probe/`（不入库）；经安全审查修掉 3 个泄漏级 bug 后交付 |
| **macOS + Windows 真机探测** | ✅ | 原始报告与逐条判定归档在 [docs/zh-CN/findings/](docs/zh-CN/findings/)；结论已回填两份文档 |
| **M0 脚手架** | ✅ **完成** | G-01…G-11 全部交付并自检；`npm run verify` 本地全绿（`npm test` 102 条 + `check:bundle` 20 条）。落地清单见 [testing.md §12.7](docs/zh-CN/testing.md) |
| **M1 批 1 · 领域层** | ✅ **完成** | 5 个模块，230 条 m1 用例，domain 覆盖率 98%；[review/2](review/2_m1-batch1-domain-review.md) 的建议已处理（见下） |
| **M1 批 2 · infra** | ✅ **完成** | FsGateway / PathGuard / Clock / 三处 store / 备份 |
| **M1 批 3 · SyncEngine + L2** | ✅ **完成** | 九阶段 pass、双 replica world、冲突隔离、就绪状态机、崩溃矩阵、manifest、锁；541 条 m1 用例 |
| **[review/3](review/3_m1-batch2-batch3-review.md) 整改** | ✅ **完成** | §3.1/§3.2/§3.3 三个正确性问题 + §4.1/§4.2/§4.4/§4.5 的覆盖与门禁欠账（见下） |
| **M1 批 4a · 状态落盘门面** | ✅ **完成** | json-file / home-store / sync-dir-store / backup-writer / lock-file / state-adapters / pass-runner；S-08、S-16…S-20 首次有端到端证据 |
| **M1 批 4b · Obsidian UI** | ✅ **完成** | plugin-runtime（无 Obsidian 类型）+ 设置面板 / 报告 / 冲突面板 / 8 条命令；S-04c 三种解决方式全绿 |
| **[review/4](review/4_m1-batch4-review.md) 整改** | ✅ **完成** | 2 条中低危讨论点已处理；写验收脚本时另抓到一个 dry-run 违反 ADR-27 的真 bug |
| M1 真机十步验收 | ⬜ **待执行**，套件已备好 | [testing.md §9.4](docs/zh-CN/testing.md) + `tmp/acceptance/` |

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
- 🔄 **批 2 · infra（进行中）**：
  - ✅ `infra/clock.ts`——`Clock` / `IdGen` 接口 + 系统实现 + 可钉死的测试替身
  - ✅ `infra/fs-gateway.ts` + `node-fs-gateway.ts`——原子写（同目录 tmp → fsync → rename）、win32 跳过目录 fsync、`retryOnTransient` 退避、`renameNoReplace`（link+unlink 拿到"目标已存在则失败"的原子语义）
  - ✅ `infra/path-guard.ts`——逐级 lstat containment、四 root 重叠、凭证名单、大小写敏感性运行时探测；**唯一铸造 `SafeAbsolutePath` 的地方**
  - ✅ `infra/state-store.ts`——observations ledger 解析（丢失/指纹不符/更高 schema 一律 fail-safe 归零）、machineId 漂移检测与轮换、workspace 身份 preflight（W-1/2/4/5）、可移植设置的机器相关值检测
  - ✅ `infra/backup-store.ts`——命名（去掉 Windows 非法字符且字典序 == 时间序）、同毫秒碰撞降级、**I1 管辖的轮转**（不可由幸存者复原的版本一律不删）
  - ⬜ 把这些接起来的 store I/O 门面（读写 machine.json / workspaces/*.json / observations.json 的实际落盘路径）——纯逻辑与格式已就绪，剩下的是 FsGateway 调用编排，可与批 3 的 SyncEngine 一起做
  - 批 1 已经把接口形状定下来了：`FsGateway` 的写方法只收 `SafeAbsolutePath`（`src/domain/types.ts`），`PathGuard` 是**唯一**能铸造它的地方（lint 已强制，见 `eslint-rules.test.ts` 的 branded-path 组）
  - E0 签名按**分量**存进 ledger，不要只存 sha256——未来 mtime 的降级路径需要"剔除 mtime 后重算"，只有摘要就做不到（`src/domain/stability.ts` 顶部有说明）
- 🔄 **批 3 · SyncEngine + L2（进行中）**：
  - ✅ `orchestration/pass-report.ts`——报告类型（**类型上没有任何能装文件内容的字段**）、`HookPoint` 屏障点、`CrashSignal`（刻意不继承 Error）
  - ✅ `orchestration/sync-engine.ts`——P0–P8 九阶段、稳定性闸门前置于读字节、A6 备份 / A8 最后一眼 / A10 写回快照、`mintWritePath` 强制 adapter 输出过 PathGuard
  - ✅ `providers/provider-adapter.ts` + `claude-code/adapter.ts`——白名单分类（安全边界）、Tier A 扫目录发现
  - ✅ `tests/helpers/world.ts`——双 replica L2 world + 可编程 transport（truncate / zero-byte / mtime 策略 / drop）
  - ✅ `tests/helpers/invariants.ts`——`assertRecoverable`（I1，字节前缀语义）、I1-a/b/c
  - ✅ **U-18b 集成形态已落地**（等长 + 还原 mtime + 发散 → CONFLICT，两侧冻结）、U-07 引擎级、S-01/02/03/08/10、I2a 收敛
  - ✅ `domain/conflict.ts` + 引擎落盘——内容派生的 `conflictId`、`.quarantine/<ws>/<provider>/<id>/`、meta.json；U-13/U-20/U-21 全绿
  - ✅ `domain/readiness.ts`——NR-1…NR-9 全表 + `AWAIT_INIT` 歧义处理；U-15/16/17 全绿
  - ✅ 崩溃点矩阵——`crashDuringPass` 注入 `CrashSignal`（不可捕获），六个注入点各断言"重启后与从未崩溃的对照组逐字节一致"
  - ✅ I1/I2a/I2b 属性测试（`tests/m1/property/`，nightly job 已能挑到）
  - ✅ `domain/manifest.ts`——M-01…M-08 全覆盖；E0/E1/E2 证据分级 + `mayAuthoriseWrite` 类型收窄（E2 才能授权写）；更高 schemaVersion 绝不重写；未知字段读改写后仍在；坏 entry 只丢那一条
  - ✅ `orchestration/lock.ts` + 引擎接线——R-09（同实例重叠 pass 立即 `ALREADY_RUNNING`，零写入）、R-10（陈旧锁可抢占 + **epoch 让被抢者的写入失效**）
  - ✅ 三条冲突命令与锁的落盘实现——都在批 4 里补齐了

### 批 4（2026-08-08）

**4a 落盘门面**：`json-file` / `home-store` / `sync-dir-store` / `backup-writer`（infra）+ `lock-file` / `state-adapters` / `pass-runner`（orchestration）。写这批的测试抓到两个真 bug：

- **坏锁文件是永久的**。"没有文件"和"文件读不懂"都归 null，于是获取锁时对着那个刚被判定忽略的文件做独占创建、失败、报 `LOCK_HELD`——插件从此再也不同步。这正是 `parseLockFile` 把垃圾当"无人持有"要避免的结果。两种情形现已分开。
- **NR-5 在每次 push 之后有一轮盲区**。就绪扫描在 pass 之前跑，所以记下的计数从不包含我们刚写进去的东西；那一轮里被清空的 sync 目录读起来就是"这里从来什么都没有"。写过的 pass 在 commit 时补一次扫描。

**4b UI**：`plugin-runtime`（**不含任何 Obsidian 类型**，lint 强制）承载全部行为，`src/ui/**` 只做渲染。测试经 vitest alias 把 `obsidian` 指到 stub，因此表现层能在纯 Node 下跑。接 UI 时又抓到一个：

- **原子写从不建目标目录**。world 的 `mintWritePath` 替身顺手 `mkdir` 了，把它盖了一路；换成真 PathGuard 后每次 `PUSH_NEW` 都 `FAILED_IO`。现在归 `stageTemp`（ADR-37）。

三处刻意的偏差都记在了架构文档里：ledger 多存 `verifiedSig` 与 `remoteHadNonZeroSize`（§5.5 表格）、`local` 用 neutralRel 做 key（同处）、设置分两处（ADR-38）。

### review/4 整改（2026-08-09）

[review/4](review/4_m1-batch4-review.md) 报了 **0 Blocker、0 高危**，两条中低危讨论点都已处理：

| 项 | 处理 |
|---|---|
| §3.1 E1 分支跳过 `conflictKnown` | 在 `sync-engine.ts` 的分支上方与 ADR-35 各补了推论：**这条分支只在两侧 hash 相等时可达，内容相同就没有需要"已知"的分歧**；曾冲突过的一对在内容一致后旧 conflictId 自然不再被算出（U-21） |
| §3.2 `remote-not-ready` 文案 | `describeOutcome` 补一句"只有保留本机版本才写 sync 目录，保留对方版本写本机、仍然可用"——两个按钮在用户眼里对称，只说一个不能用会读成"冲突没法解决" |

**写真机验收脚本时抓到的 bug（review/4 未发现）**：**dry-run 违反 ADR-27**。写到步骤 1 的「五棵树字节零变化」时去核对代码，发现两处：

1. 就绪的**可写探测**会建一个 `.aiss/.probe-<id>` 再删掉——没有净变化，但仍然是一次写；
2. **`remote.json` 无条件写回**——文件内容确实变了，而且它改变的是*下一次* pass 的判断。

ADR-27 说"dry-run 绝对只读"的价值就在于这句话**没有需要记住的例外**。现在 dry-run 不探测（改用上一次真实 pass 证明过的可写性）、不写 remote.json，并有用例 `plugin-runtime.test.ts` 的「leaves all five trees byte-identical」把五棵树逐字节钉死——去掉修复它就红。

顺带把 `conflict-commands.test.ts` 与 `ui.test.ts` 里跑双机多轮 pass 的用例标了显式 `SLOW = 30_000`：它们在覆盖率插桩下会超过 vitest 5 秒默认值，而那个默认值本身值得保留在全局。

## 真机验收怎么跑

套件在 **`tmp/acceptance/`**（`tmp/` 在 gitignore 里，所以它不入库，**要手工拷到两台机器**，和当年的探测套件一样）。

| 文件 | 干什么 |
|---|---|
| `README.md` | 给人看：先决条件、打包分发、跑不过时先看哪几条 |
| `AGENTS.md` | 给目标机器上的 agent 看：§0 安全红线 + 十步逐条的做法、期望、证据 |
| `evidence.mjs` | 证据工具（零依赖）：给「五棵树」拍快照、出 [testing.md §9.3](docs/zh-CN/testing.md) 的表格、`diff`、**`check`（验 I1，退出码非 0 就是最严重那类失败）** |
| `scripts/install-plugin.{sh,ps1}` | 把 `main.js` + `manifest.json` 装进 vault 的插件目录 |
| `templates/record.md` | §9.3 的验收记录模板 |

最短路径：

```bash
npm run verify && npm run build          # 开发机；记下 git rev-parse --short HEAD
tar czf aiss-acceptance.tgz -C tmp acceptance
mkdir -p ~/aiss-handoff && cp main.js manifest.json ~/aiss-handoff/
# 把这两样拷到 Mac 与 Windows，在目标机器上：
#   ./scripts/install-plugin.sh "<vault 绝对路径>" "<产物中转目录>"
#   node evidence.mjs config --vault "<vault 绝对路径>"
# 然后让 agent 读 AGENTS.md 往下走
```

**三个位置别搞混**（README §2.2 有表）：验收套件放 `~/aiss-acceptance/`（别放同步目录里）；
`main.js` + `manifest.json` 先放任意中转目录；**插件的最终位置是
`<vault>/.obsidian/plugins/ai-session-sync/`，由 `install-plugin` 脚本搬进去，不用手动拷**。

**三个最容易浪费时间的点**（README 里都写了，这里再点一次）：

1. **workspace identity 只在机器 A 创建一次**，B 上手工拷 `<vault>/.ai-session-sync/workspace.json` 过去。两边各点一次 Create 会生成两个 id、两棵互不可见的子树，而且**不报错**——ADR-20 要防的正是这个。
2. **就绪要等**：READY 需要连续 2 次 pass 且首末跨度 ≥ 90 秒。状态栏停在 `checking folder` 不是错误。
3. **B 上按 ID resume**，不要用 picker（F-1：picker 只列交互式来源的会话，同步过来的看不见）。

跑完把 `out/` 里除 `blobs/` 外的东西拿回来，按 §9.3 合成记录，归档到 `docs/zh-CN/findings/<日期>-m1-acceptance.md`。**`out/blobs/` 是对话原文，只在步骤 8 产生，跑完就删。**

### review/3 整改（2026-08-08）

[review/3](review/3_m1-batch2-batch3-review.md) 报了 1 高、1 中高、1 中和一批覆盖缺口，全部处理完：

| 项 | 处理 | 落点 |
|---|---|---|
| §3.1 高：`*_NEW` 用覆盖式 rename | `FsGateway.writeFileNoReplace`（stage tmp → `link`+`unlink`）；`target-exists` → `ABORTED_PRECONDITION`；无硬链接的文件系统退化前先做存在性检查并在报告标 `noReplaceUnavailable`（ADR-36） | `fs-gateway.ts` / `node-fs-gateway.ts` / `sync-engine.ts`；用例 **R-04b** |
| §3.2 中高：引擎绕过 E1/E2 分级 | P3 接上 `EvidenceCache`。**两侧 E1 命中且 hash 相等 → 不调用 `plan()`，直接 NOOP**——EV-1 由纪律变成控制流（ADR-35）。稳态 pass 现在 0 次全文读 | `sync-engine.ts` P3；用例 `evidence-tiers.test.ts`（含 S-06b / S-07 / X-03 与"伪造 manifest 的上限"） |
| §3.3 中：`sameSignature` 漏 `ino` | 改为复用 `stability.signaturesEqual`，引擎不再自己写一份比较 | `sync-engine.ts` |
| §4.1 U-12b / U-14 / `malformedTail`→Notice | 全部补齐；`truncatedTailPasses` 之前**从不递增**，U-11d 在引擎里根本不可达，已修 | `sync-engine.ts`；用例 U-11d / U-12b / U-14 |
| §4.2 S 编号漂移 | 测试名对齐 testing.md，并在 [testing.md §7.2](docs/zh-CN/testing.md) 加了一张**引擎级覆盖现状表**（含每条未覆盖项的原因） | 各 `tests/m1/*.test.ts` |
| §4.4 §11.2 字段禁令门禁 | 装上了；**第一版是死的**——`expectTypeOf().not.toHaveProperty(name)` 在 `name` 是联合类型时不判别，往 `ActionEntry` 加 `content` 也不红。改成逐条字面量后才真正拦得住 | `tests/m1/pass-report.test.ts` |
| §4.5 type-aware lint | `no-floating-promises` / `await-thenable` / `no-misused-promises` 已开（`projectService`）。虚拟路径的 lint 自检必须关掉这三条——project service 找不到磁盘上的文件会直接 fatal | `eslint.config.mjs` / `tests/build/eslint-rules.test.ts` |

**E1 的两个来源**（架构 §5.3.1 已补）：manifest 管 replica 侧（不可信），本机 `observations.json` 管本机侧（可信）。引擎刻意不区分——两者都只能授权 NOOP，信任度差别不改变它被允许做的事。由此得出恶意 manifest 的上限：它只能伪造一半，最坏结果是"本轮什么都不做"，`evidence-tiers.test.ts` 直接把这条断言了下来（并断言删掉 manifest 触发 T4 全量读后真相会浮出来）。

  **批 3 首批用例认领表**（来自 [review/2](review/2_m1-batch1-domain-review.md) §4，批 1 因分层归属写不了的那些，别漏）：

  | 用例 | 内容 | 状态 |
  |---|---|---|
  | **U-18b 集成形态** | 真实 tmpdir：写 `R0` → 等长 `R1` + `utimes` 还原 mtime → 跑 pass → 必须 `CONFLICT` | ✅ `sync-engine.test.ts` |
  | U-12b 备份断言 | 0 字节被 `PULL_OVERWRITE` 覆盖时，备份区确实有那份 0 字节备份 | ✅ `sync-engine.test.ts`（review/3 §4.1 补齐） |
  | `malformedTail` → Notice | planner 打 flag，报告层要真的渲染成 Notice | ✅ `sync-engine.test.ts` U-11d（连带修了"计数器从不递增"这个使它不可达的 bug） |
  | U-14 | 空目录 → 空 Action 列表，不报错 | ✅ `sync-engine.test.ts` |
  | U-16 / U-17 | `AWAIT_INIT` 零写入；文件数骤降 → `NOT_READY` 且不解释成"远端删了" | ✅ `readiness.test.ts` |
- **批 4 · Obsidian UI** → 真机十步验收（[testing.md §9.4](docs/zh-CN/testing.md)；两台机器的 `~/aiss-probe` 都还留着可复用）

批 1 从 `path-escape` 起步的具体理由：样本表已经全部实测（[testing.md §5.1](docs/zh-CN/testing.md) 12 条 `verified: true`），是唯一一个"输入输出都已知、可以纯表驱动写完"的模块，能顺带把 `tests/m1/` 建起来让 `check:no-skip` 从"M0 空跑"转成真门禁。

`src/main.ts` 仍然只做装配：8 条命令、ribbon、状态栏、设置页、定时 pass，全部转手给 `PluginRuntime`。三条约束别破：

- **`onload()` 不读文件系统**。`getRuntime()` 会 realpath vault 路径，所以设置页拿到的是**取值函数不是实例**；首次 pass 还要经 `setTimeout(…, 0)` 才排出去——从设置面板启用插件时 `onLayoutReady` 是**同步**回调，只"延到 layout-ready"并不够。
- `tests/build/artifact-smoke.test.ts` 的 `EXPECTED_COMMAND_IDS` 是**故意写死的字面量**，增删命令必须同步改。
- 那份 smoke 测试会把 `HOME` 指到临时目录再加载 bundle。别去掉：否则跑一次构建测试就会在开发者家目录里留下 `~/.ai-session-sync/machine.json`。

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

tmp/probe/                       2026-08 的探测套件（gitignore；留作 CLI 大版本升级后的回归复测工具）
tmp/probe-results/               两台真机的原始产物（gitignore；报告已归档进 findings，原始 JSON 快照只在本地）
tmp/acceptance/                  **M1 真机十步验收套件**（gitignore，要手工拷到两台机器）——见上方「真机验收怎么跑」
```

### 必须遵守的约定（写代码时最容易违反的几条）

- **文档去处**：技术决策只写 architecture.md（改动要同步 ADR 表）；CLAUDE.md 不复述技术决策（CI 的 `check:docs` 会挡）
- **⚠️ 的效力**：仍标 ⚠️ 的假设不得作为破坏性写入的依据，依赖它的代码路径保持只读或 dry-run
- **manifest 只能授权 NOOP**（架构 §5.3.2 授权矩阵）；`PlanInput` 类型上不得出现 manifest 派生的 hash 字段。引擎层的形式是：E1 命中走的那条分支**不调用 `plan()`**（ADR-35）——别为了"复用代码"把缓存 hash 塞进 `SideFacts.observedHash`
- **`*_NEW` 只能用 `writeFileNoReplace`**（ADR-36）。它不备份，所以"目标不存在"这个前提出错就是无备份的销毁
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
- ✅ **三平台 CI 已全绿**（2026-08-07，run 31186382661）。此前从 M0 起连续 5 次 push 都是 Linux 绿、macOS/Windows 红而没人看——**推完记得看一眼 `gh run list`**，红了五次和红了一次的修复成本差很多
  - 三个 bug 都在测试侧，且**都朝着"看起来成功"的方向失败**：Windows 上 `split(path.sep)` 让四 root 重叠检测变成空转（找不到重叠 = 通过）；`tsc --listFiles` 在 Windows 输出正斜杠而 REPO_ROOT 是反斜杠，于是 toolchain 测试报"tsc 检查了空程序"；macOS 的 `/var` → `/private/var` 让 `resolveUnderRoot` 正确地拒绝了一切（参数就叫 realRoot，测试没给 realpath）
  - 教训已固化：`path-guard` 导出 `splitPathSegments`（两种分隔符都吃），别让每个调用方自己写一个
- 批 4 又红了三次，同一类：**Linux 绿、另外两个平台红，且都朝"看起来成功"的方向失败**。三条已固化的对策——
  - **临时目录必须 realpath**（用 `tests/helpers/fs-cleanup.ts` 的 `makeRealTmpDir`）。裸 `mkdtempSync` 在 macOS 给 `/var/folders/…`（真身是 `/private/var/…`）、在 Windows 给 8.3 短名，两边都会让 `resolveUnderRoot` 判 SYMLINK——看起来像 guard 有 bug。现在 `runWorkspacePass` 的 preflight 会先查一遍并报 `root-not-canonical`，把这一类变成一句话
  - **断言别对 JSON 原文做子串搜索**。Windows 路径在 JSON 里是转义的，`toContain` 会红（吵，但无害），`not.toContain` 会**假绿**——"vault 里不许出现绝对路径"这条正好是后者
  - **`tests/m1/` 里不许 `skipIf`**，`check:no-skip` 会拦。平台条件用例放 `tests/posix/`（testing.md §8.5 早就写了）
- ⚠️ **branch protection 在私有仓库上不生效**：已配 Rulesets，但 GitHub 提示私有仓库需 Team 组织账户才强制执行。在仓库转公开或升级前，**门禁的实际强制点是本地 `npm run verify` + 推完看 `gh run list`**，不是 GitHub

### M1 期间必须补上的门禁欠账

M0 的自检把"门禁本身能不能拦住东西"验完了，但下面几项**要等 M1 有代码/测试之后才能装**，别忘了：

| 项 | 什么时候装 | 说明 |
|---|---|---|
| ~~`check:no-skip --min`~~ | ✅ 已装（`--min 100`，当前 162 条） | 加测试时不必调它；只有**大幅**扩容后才值得提高下限 |
| Q-32 Windows 执行数 ≥ ubuntu 的 95% | M1 收尾 | 目前无任何实现；需要跨 job 比对 `reports/vitest.json` |
| ~~store / 锁 / manifest 的落盘门面~~ | ✅ 批 4a 完成 | S-08/S-16…S-20 现在跑在 `runWorkspacePass` 上 |
| ~~type-aware lint~~ | ✅ 已装 | `no-floating-promises` / `await-thenable` / `no-misused-promises`，靠 `projectService`。`eslint-rules.test.ts` 的虚拟路径必须 override 关掉它们，否则 project service 会 fatal；同文件底部有一条写真文件到 `src/` 再 lint 的自检，证明它真的会红 |
| ~~§11.2 `PassReport` 字段禁令~~ | ✅ 已装 | `tests/m1/pass-report.test.ts`。**逐条字面量写**——循环形式的 `not.toHaveProperty(name)` 永远通过 |
| ~~`src/ui/**` 覆盖率归属~~ | ✅ 已定 | 没有 exclude，改为单独门槛（lines 70 / functions 60 / branches 55），并真写了 `ui.test.ts`。全局门槛没动 |
| `src/ui/**` 覆盖率归属 | 批 4 | 现在 UI 落在全局 80% 门槛下，表现层按 §4 是靠 stub smoke + 人工验收的，落地时要么显式 exclude（照 `main.ts` 的先例）要么补测试——**别顺手调低全局门槛** |
