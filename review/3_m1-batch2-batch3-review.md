# M1 批 2（infra）+ 批 3（SyncEngine + L2）代码审核报告

> 审核对象：`src/infra/*`（fs-gateway / node-fs-gateway / path-guard / state-store / backup-store / clock）、`src/orchestration/*`（sync-engine / pass-report / lock）、`src/providers/*`（provider-adapter / claude-code/adapter）、`src/domain/{conflict,manifest,readiness}.ts`，及对应 L1/L2 测试 `tests/m1/*`、`tests/helpers/{world,invariants}.ts`
> 审核日期：2026-08-08
> 审核方式：只读代码审核，未修改被审核代码。逐行通读全部批 2/3 源码（约 3900 行）与核心测试（约 4700 行），对照 architecture.md §4.1/§5.3/§5.5/§7.1/§9.2.1/§9.3/§9.6/§9.7/§10.2/§11 与 testing.md §1/§5.2–§5.5/§6/§7 逐条核对；实跑 `npx vitest run tests/m1`（19 文件 520 条全绿，Node 20.20.2）
> 审核基准：HANDOFF.md（2026-08-07）声明批 2 完成、批 3 基本完成（520 条 m1 用例，三平台 CI 全绿）；[review/2](2_m1-batch1-domain-review.md) §4 的批 3 用例认领表为验收依据之一

## 1. 结论摘要

**批 2/3 整体达到设计基线，核心安全性质有真实的多层防御。** review/1 的原始 Blocker 全部落实为可执行的结构：manifest 只能授权 NOOP（E0/E1/E2 判别联合 + `mayAuthoriseWrite` 类型收窄）、冲突状态由内容派生而非存储（`conflictId` 哈希派生，U-20 删全状态后仍收敛）、verify-then-swap 的残余窗口被文档化而非假装不存在。批 1 review 的 5 项认领用例中 **U-18b 集成形态与 U-16/U-17 已高质量落地**，且 U-18b 用真实 `utimes` 还原构造了"便宜信号全无效"的最难形态。

但有 **1 个高危写入路径缺陷**、**1 个中高危规范偏差**和若干覆盖缺口，其中两条直接对应 HANDOFF 自认的"未完成项"。**建议在进入批 4 前修掉 §3.1（高）与 §3.2（中高）**，其余可记入批 4 或 M1 收尾。

最刺眼的组织性问题：**HANDOFF 声明的 S 用例编号（S-01/02/03/08/10）与 testing.md §7.2 的实际编号不同义**——HANDOFF 的 S-08 是 testing.md 的 S-12，HANDOFF 的 S-10 是 testing.md 的 S-16/17 的近亲。testing.md 自身定义的 S-01–S-20 里约三分之二没有引擎级用例（见 §4.2）。这不是代码错，但让"批 3 覆盖了 S 矩阵"的声明无法被第三方验证。

## 2. 分层评估

### 2.1 infra 层（批 2）— 优，写入路径一处高危

**`fs-gateway.ts` / `node-fs-gateway.ts`（390 行）— 优**
- 原子写（同目录 tmp `"wx"` 独占创建 → fsync → rename → 目录 fsync）语义正确，失败路径清理 tmp 且**绝不降级为 delete-then-write**——这是把"暂时错误"变成"丢文件"的经典岔路，代码注释和测试都守住了。
- 目录 fsync 在 win32 跳过（findings F-4），`retryOnTransient` 只重试 `EPERM/EBUSY/EACCES/ENOTEMPTY` 且对无 code 错误立即抛出——测试直接断言了"不重试 ENOENT"和"退避序列逐项等于 `RENAME_RETRY_DELAYS_MS`"，这是 M0"门禁必须见过自己报错"精神在实现层的延续。
- `renameNoReplace` 用 `link+unlink` 在无 `RENAME_NOREPLACE` 的 Node 上凑出原子语义，并对不支持硬链接的文件系统显式降级（`noReplaceEnforced: false`）——与架构 §9.2.1 A9 的"平台不支持则退化 + 报告标记"一致。
- `ino === 0` 归一为 `undefined`（Windows 报 0），防止两个不同文件因同报 0 而误判相等——细节正确。

**`path-guard.ts`（273 行）— 优，是批 2 最重的模块**
- 逐级 `lstat` containment 拒绝跟随符号链接，而非"先跟随再检查还在不在 root 内"——后者输给 TOCTOU，注释把这个选择的原因写明了。walk 结束后还对 `realpath(parent)` 做最终 containment 复查，兜住"walk 期间被换掉"的链接。
- `sawMissing` 规则（一级缺失后，更深层必须全部缺失，否则判 SYMLINK）是处理"新建路径"与"符号链接交换"的正确折中。
- `findRootOverlaps` 用 `splitPathSegments`（两种分隔符都吃）+ 运行时 `caseSensitive` 探测，正是 HANDOFF 记载的 Windows CI 失败教训固化后的形态；四 root 重叠的每个危险配置（syncDir 在 vault 内、syncDir=~、backupDir 在 syncDir 内、两 root 相同）各有测试。
- 凭证 denylist（§9.7.6）+ 外部同步工具残留物识别（§8.2）齐备，`isDenylisted` 大小写不敏感。
- `probeCaseSensitivity` 用真实写探针，不猜平台。
- 唯一可议：`mintStatePath` 的注释自称为"第二个合法铸造点"，但它**跳过了逐级 lstat walk**（只做字符串 containment）。对本机 state 目录这是合理简化（§5.5 该目录不受外部污染），注释也解释了理由，可接受。

**`state-store.ts`（400 行）— 优**
- 三方状态划分（§5.5/§5.6/§10.2/§10.3）的解析层全部 fail-safe：ledger 丢失/指纹不符/schema 过高一律归零为"全空"而非报错，与架构 §5.5"丢 ledger 的代价是慢一轮"一致。
- `parseObservations` 对指纹不匹配**作废整个文件**而非逐条——注释正确指出"指纹不符意味着每个 firstSeenMs 都在描述本 pass 没见过的文件"。
- `detectIdentityDrift` 故意**不比较 homedir**（搬家还是本机）、hostname 大小写不敏感——注释都给了理由。`rotateMachineId` 安全性的论证（"machineId 从不参与决策，所以轮换的全部成本是审计列表多一行"）是 §10.3 的正确落地。
- `checkWorkspaceIdentity` 的 W-0/1/2/4 与冲突副本检测（`findIdentityConflictCopies` 识别 `sync-conflict`/`conflicted copy`/`(n)`/`副本`）齐备。
- `findNonPortableValues` 用序列化 + 正则做机械检查——粗但方向正确（宁滥勿缺），有正/反用例。

**`backup-store.ts`（167 行）— 优**
- I1 管辖的轮转是本模块的灵魂：`planRotation` 只删 `recoverableFromSurvivor` 为真的版本，否则保留并标 `deferred`——"keep=3 本身是数据丢失路径"这一反直觉事实被测试直接锁死（含"可删与必须留并存"的混合用例）。
- 命名去 Windows 非法字符且字典序==时间序；同毫秒碰撞向上探序号，100 个全占后降级随机后缀，全占返回 `null`（配合 `"wx"` 创建让失败显式化）。
- `backupFailureIsFatal` / `rotationFailureIsFatal` 用无参函数把两个方向相反的语义钉死，测试各断言一次——形式简单但有效。

**`clock.ts`（68 行）— 优**
- `Clock`/`IdGen` 注入 + `fixedClock`/`sequentialIdGen` 确定性替身，是 testing.md §3 req 4 的干净落地。

### 2.2 orchestration 层（批 3）— 结构正确，一处规范偏差

**`pass-report.ts`（149 行）— 优**
- "报告类型上没有任何能装文件内容的字段"是结构约束而非约定，§11.2 的意图达成（但见 §4.4：testing.md 要求的 `expectTypeOf` 断言门禁未装）。
- `CrashSignal` 刻意不继承 `Error`——这是整个崩溃矩阵可信的前提，有专门测试断言 `isCrashSignal(new Error("io")) === false`。
- 15 个 `HookPoint` 覆盖 P0–P8 与 P6 内部的备份/rename 前后，屏障设计符合"生产 no-op、测试注入崩溃/并发"的契约。

**`lock.ts`（141 行）— 优**
- R-09（进程内重叠）与 R-10（跨实例文件锁）分离正确。`decideAcquire` 进程内 busy 优先于文件系统；`mayWrite` 比 epoch 而非 pid（注释正确："被抢者的 pid 还是它自己"）。陈旧锁可抢占 + epoch 让被抢者写入失效，是"可抢占锁"与"坏锁"的分水岭，端到端 R-09 测试（`Promise.all` 双 pass 恰好一个 aborted 且零 action）质量高。
- 纯逻辑完备；落盘 I/O 未接（HANDOFF 自认，见 §4.5）。

**`sync-engine.ts`（726 行）— 结构正确，但有本批最重要的两个发现**

优点先说：九阶段顺序正确（稳定性闸门真的在读字节之前）；`CATCHABLE_IO` 白名单让 `CrashSignal` 穿透到测试；`mintWritePath` 强制 adapter 输出过 PathGuard（evil-adapter 防线）；隔离是 copy 不动原件（I1-b）；A8 最后一眼 + 备份失败取消覆盖 + 锁被偷则中止都在。两个发现见 §3.1 / §3.2。

### 2.3 providers 层（批 3）— 优

- `provider-adapter.ts`：`classifyFileName` 白名单优先于冲突副本模式（§8.2 layer 1），注释记录了 OneDrive `-<hostname>` 后缀误伤的教训——模式匹配现在只用于解释白名单已拒绝的文件。
- `claude-code/adapter.ts`：Tier A 扫目录发现；`auxSuffixPattern` 只匹配 `.origin.json` 且注释说明"只写在 sync 目录、永不拉进 provider 目录"（OQ-5 的保守落地）；`memory/` 目录跳过（F-7 已知限制）。

### 2.4 新增 domain 模块（批 3）— 优

- **`manifest.ts`**：E0/E1/E2 判别联合 + `mayAuthoriseWrite` 类型收窄是 U-18 防御的类型形态；`e0Matches` 五分量全等（EV-2）；更高 schema `unusable` 且 `writable: false`（字面 `false` 使"不可写"可被类型检查）；未知字段双层存活（M-05）；坏 entry 只丢一条（M-06）。**注意**：该模块完整但**引擎尚未消费它**（见 §3.2 与 §4.3）。
- **`readiness.ts`**：NR-1…NR-9 全表齐备；NR-9 最先（目录不可达则其余观察无意义）；AWAIT_INIT 对空目录零写入（U-16）；`notReady()` 保留高水位不降级（"把变小当正常"的静默路径被堵死）；自愈仅限 NR-6/7/9，其余需人工——与 §9.6.3 一致。
- **`conflict.ts`**：`conflictId` 按字典序排两 hash 再截断——"local/remote 在两台机器上互换"这一导致同分歧两身份的经典 bug 被这个排序消掉。隔离布局在 sync 目录内（两台机器都能摸到）。

### 2.5 L2 world 与不变量（批 3）— 优，是批 3 最大亮点

- **`world.ts`**：双 replica 用两个真实目录，使 `flush()` 能表达延迟/截断/0 字节/mtime 策略——共享目录会让这些行为无法表达，注释把这点讲透了。`crashDuringPass` 注入不可捕获信号后 `restart()` 清进程态，语义诚实。
- **`invariants.ts`**：`assertRecoverable`（I1）按**有序字节前缀**判定存活，不是集合——注释正确指出集合语义会让 `[a,b,c]→[c,b,a]` 和去重 `[a,a,b]` 都"通过"却毁掉可 resume 的 session。`assertEveryOverwriteBacked` 对报告而非文件系统断言（"报告缺失 backupPath 本身就是 bug"），`assertInventoryPreserved`/`assertConflictFrozen` 边界清晰。

## 3. 正确性问题（建议批 4 前处理）

### 3.1 高危：PUSH_NEW / PULL_NEW 写入未用 `renameNoReplace`，会静默覆盖并发创建的目标

**位置**：`sync-engine.ts` `applyAction`（约 L470-490）——所有写动作（含 `*_NEW`）都走 `deps.fs.writeFileAtomic(minted.value, sourceBytes)`。

**问题**：`writeFileAtomic` 的 rename 是**覆盖式**的。对 `PUSH_OVERWRITE`/`PULL_OVERWRITE` 这正确（目标预期存在）。但对 `PUSH_NEW`/`PULL_NEW`，语义前提是"目标不存在"。架构 §9.2.1 A9 明确要求 NEW 动作用**不覆盖语义的 rename**（`RENAME_NOREPLACE` / `RENAME_EXCL`），让"目标已被别人创建"在系统调用层失败，而不是静默覆盖。

**具体失败形态**：PULL_NEW 落地期间，本机 CLI 恰好创建了同名 session 文件（新 session 落盘）。A8 最后一眼在 `targetPre` 是 ENOENT 时通过；随后覆盖式 rename 把 CLI 刚写的真实对话**直接盖掉**——没有备份（NEW 动作不触发备份，备份只在 `overwriting` 分支），I1 被违反且无任何记录。这正是 `node-fs-gateway.ts` 实现了 `renameNoReplace`、其测试注释明说"`*_NEW` 动作依赖它"的原因——但该函数**在引擎里从未被调用**。

**佐证**：`node-fs-gateway.ts` L107 注释 "The *_NEW actions rely on this"，`fs-gateway.test.ts` L178 注释 "The *_NEW actions rely on this: somebody else created it while we were working must fail at the syscall, not silently overwrite their file"——意图在 infra 层备好了，编排层没接上。

**建议**：`applyAction` 对 `PUSH_NEW`/`PULL_NEW` 走一条"写 tmp → `renameNoReplace`"路径（或给 `writeFileAtomic` 加 `noReplace` 选项），`renameNoReplace` 返回 `target-exists` 时记 `ABORTED_PRECONDITION` 下轮重规划。补一条 L2 用例：PULL_NEW 进行中 CLI 创建同名文件 → 断言本地那份字节不丢。

### 3.2 中高危：引擎绕过了架构的 E1/E2 证据分级，每个 stable 文件每轮无条件全量读

**位置**：`sync-engine.ts` P3（约 L226-228）——`localBytes = localO2.exists && localStable.stable ? await readBytes(...) : null`，对 remote 同理。

**问题**：架构 §7.1 P3 规定"按 §5.3.2 授权矩阵决定 **E1 复用还是 E2 实读**"，`domain/manifest.ts` 也完整实现了 `evidenceFor`（E0 全等 → E1 复用 hash/lineCount，否则 E0）。但引擎**从不读 manifest、从不调 `evidenceFor`**，对所有 stable 文件无条件全量 `readFile`。

**影响**：
- **正确性**：反而更安全——E2 实读是最高证据级，manifest 永不授权写，U-18 防线以最强形式成立。这不是正确性漏洞。
- **性能**：E1 的全部意义是省掉稳态 I/O（两 stat + 尾部读，不读全文）。当前实现对 N 个未变 session 每轮全量读，OQ-7（1000 session 规模性能）会在此显现——稳态下本应是近零 I/O。
- **结构**：`manifest.ts` 是完整的死代码；HANDOFF 声称"M-01…M-08 全覆盖"指的是 manifest 模块自身的单元测试，但**没有任何引擎级测试证明 manifest 被正确消费**（因为根本没消费）。

**建议**：批 4 或 M1 收尾时，把 P3 改为"E0 命中 manifest → E1（跳过 readFile，hash 用 `entry.contentHash`）；否则 E2 实读"，并补 S-06b（manifest 先到、session 后到不做破坏性动作）与 S-07（manifest 被删后自动重建、结果逐字节一致）两条引擎级用例——这两条恰好是当前缺失、且只有接上 manifest 才能写出真义的用例。

### 3.3 中危：`sameSignature` 比对遗漏 `ino`，弱于架构 §9.1.4 复查表

**位置**：`sync-engine.ts` L659 —— 只比 `size/mtimeMs/ctimeMs/tailHash`，**漏 `ino`**。

**问题**：架构 §9.1.4 O3/O5 明确要求"`ino` 必须相同"。`ino` 是检测"同路径被替换成另一个 inode"（`rename` 覆盖、删除重建）的唯一信号——此时 size/mtime/ctime/tailHash 可能全同。当前 `observe()` 已经采了 `ino`（L584），`stability.ts` 的 `signaturesEqual` 也比 `ino`，唯独引擎内这个私有 `sameSignature` 漏了。

**影响**：TOCTOU 检测留了一道缝——A8 最后一眼无法发现"目标在我们准备期间被 rename 换成了内容相同的另一个 inode"。后果轻微（字节相同，覆盖它不伤数据），但这是规范偏差，且修复成本一行。

**建议**：`sameSignature` 补上 `ino` 比较（处理 `undefined` 两侧相等的情形）。

## 4. 覆盖缺口与欠账

### 4.1 review/2 批 3 认领表兑现情况

| 认领项 | 状态 | 说明 |
|---|---|---|
| U-18b 集成形态 | ✅ **高质量落地** | `sync-engine.test.ts` 用真实 `utimes` 还原 mtime（亚毫秒精度丢失有注释说明），断言 CONFLICT + 双侧冻结 + 三个不变量 |
| U-12b 备份断言 | ❌ **未兑现** | `planner.test.ts` 只断言 action 是 PULL_OVERWRITE；`sync-engine.test.ts` 没有"0 字节被覆盖时备份区确有那份 0 字节备份"的引擎级断言。S-10（zeroByte 投递）只断言"本地内容没被清"，没碰备份路径 |
| `malformedTail` → Notice | ❌ **未兑现** | `sync-engine.ts` 只在 adapter 失败时 push `notices`；planner 产出的 `malformedTail` flag 没有在引擎层转成 Notice/报告项。U-11d"让用户看见"的可见性一半仍悬空 |
| U-14（空目录→空 Action） | ❌ **未兑现** | 全测试无对应用例 |
| U-16/U-17 | ✅ **落地** | readiness.test.ts 覆盖 AWAIT_INIT 零写入与文件数骤降→NOT_READY |

### 4.2 HANDOFF 的 S 编号与 testing.md 漂移

HANDOFF 批 3 声称"S-01/02/03/08/10"已落地，但对照 testing.md §7.2：

- 测试里 `S-08`（半截投递 defer）对应 testing.md 的 **S-12**；
- 测试里 `S-10`（0 字节投递不清空）对应 testing.md **S-16/17** 的近亲（testing.md S-10 是"一对 replica 服务两 workspace"，未实现）；
- testing.md 的 **S-04/04b/04c/05/06/06b/06c/07/09a/09b/10/11/13/14/15/18/19/20 均无引擎级用例**（S-04 的隔离稳定性由 quarantine 测试部分覆盖，S-09b 由崩溃矩阵覆盖，但都没有按 S 编号命名/认领）。

**建议**：批 4 前做一次编号对齐——要么测试改名/补齐到 testing.md 的 S 表，要么在 testing.md 标注哪些是 M1 必做、哪些推迟。当前状态让"S 矩阵覆盖"无法被审计。

### 4.3 manifest / state-store 落盘 I/O 未接（HANDOFF 自认）

批 2 欠账"store I/O 门面"与批 3 欠账"锁的落盘实现"都未做：`parseObservations`/`parseMachineFile`/`parseManifest`/`decideAcquire` 都是纯逻辑，`world.ts` 用 `MemoryLedger` 内存替身，真实落盘路径（FsGateway 读写 `machine.json`/`workspaces/*.json`/`observations.json`/`locks/<ws>.lock`/`manifest.json`）没有任何实现与测试。**这意味着 S-07（manifest 删后重建）、S-20（observations 丢失退化只读）等只能靠纯逻辑单元测试推定，无引擎级证据。**

### 4.4 §11.2 PassReport 字段禁令门禁未装

HANDOFF"M1 门禁欠账"表列了"批 3：类型层禁止 `content`/`buffer`/`bytes`/`lines: string[]`/`sample`/`head`/`tail`，配 `expectTypeOf` 断言"。当前 `pass-report.ts` 结构上确实没有这些字段（人工核实），但**没有对应的 `expectTypeOf<PassReport>()` 类型断言测试**——也就是说"明天有人加一个 `content` 字段"没有任何门禁会红。这与批 1 U-18a 用 `expectTypeOf<PlanInput>().not.toHaveProperty("manifestHash")` 形成的先例不一致。

### 4.5 其余 HANDOFF 自认欠账（确认属实，非新发现）

- 冲突命令 UI 接线（批 4）。
- `src/ui/**` 覆盖率归属（批 4）。
- Q-32 Windows 执行数 ≥ ubuntu 95%（M1 收尾）。
- type-aware lint（`no-floating-promises`）——批 2 起该装，**当前未装**；`sync-engine.ts` 这类长 async 函数正是它的目标场景。

## 5. 规范引用与文档一致性

| 项 | 状态 |
|---|---|
| `PlanInput.hints` / `history` 分离 | ✅ 批 2/3 已按 review/2 §3.2 建议拆分：`hints: DeferOnlyHints`（仅 `remoteHadNonZeroSize`）与 `history: LocalHistory`（仅 `truncatedTailPasses`），来源分离落实 |
| testing.md L142 字段名漂移 | ✅ 已修正（实现 `observedHash`/`size`/`stable` 与文档叙述一致） |
| `path-safety.ts` 冗余再导出 | ✅ 已删除 |
| 决策表优先级（§7.2） | ✅ 引擎经 `plan()` 复用，与批 1 一致 |
| 备份不可关闭 / 覆盖前必备份 | ✅ `applyAction` 中 `overwriting` 分支先备份、失败即 `FAILED_BACKUP` 取消 |
| 不读时间戳做决策方向 | ✅ 决策只由字节；时钟仅用于本机稳定性观察 |

## 6. 结论与批 4 交接建议

批 2/3 把 review/1 的两个原始 Blocker 变成了**结构上不可能**（而非"约定不要这么做"），这是本项目最关键的工程目标，达成质量高。L2 world 的双 replica 设计与 I1 的有序字节前缀语义是同类项目里少见的严谨。

但批 3 宣称"基本完成"时，写入路径有一个高危缺口（§3.1 NEW 动作无 noReplace）、一个中高危结构偏差（§3.2 绕过 E1/E2）、一个中危规范偏差（§3.3 漏 ino），且 HANDOFF 的 S 覆盖声明无法被第三方验证（§4.2）。

**进入批 4 前建议按序处理：**

1. **§3.1（高，半天）**：NEW 动作接 `renameNoReplace`，补并发创建同名文件的 L2 用例。这是唯一可能真丢用户字节的路径。
2. **§3.2（中高，1 天）**：P3 接 manifest 的 E1/E2 分级，补 S-06b/S-07。消除死代码 + 为 OQ-7 规模性能铺路。
3. **§3.3（中，10 分钟）**：`sameSignature` 补 `ino`。
4. **批 4 一并处理**：U-12b 备份断言、U-14、`malformedTail`→Notice、S 编号对齐（§4.1/§4.2）、§11.2 类型断言门禁（§4.4）、type-aware lint（§4.5）。

**可推迟到 M1 收尾**：store/锁落盘 I/O（§4.3）——但这会卡住 S-07/S-20 的引擎级验证，建议在批 4 早期先做，否则真机十步验收前这批场景始终没有端到端证据。
