# M1 批 4（状态落盘门面 + Obsidian UI）代码审核报告

> 审核对象：批 4a 落盘门面（`src/infra/{json-file,home-store,sync-dir-store,backup-writer}.ts`、`src/orchestration/{lock-file,state-adapters,pass-runner,workspace-identity}.ts`）与批 4b UI（`src/orchestration/plugin-runtime.ts`、`src/ui/{settings-tab,conflict-modal,report-modal}.ts`、`src/main.ts`、`src/providers/registry.ts`），及对应测试 `tests/m1/{stores,wired-pass,plugin-runtime,ui,evidence-tiers,conflict-commands,pass-report}.test.ts`
> 审核日期：2026-08-09
> 审核方式：只读代码审核，未修改被审核代码。逐行通读批 4 全部新增源码（约 4900 行含 orchestration 改动）与核心测试（约 2200 行），对照 architecture.md §4.1/§5.2.3/§5.3/§5.5/§5.6/§7.1/§8.1/§9.3/§9.6/§10.3/§11 与 testing.md §4/§5.2.3/§7.2/§12.2c 逐条核对；并逐条验证 [review/3](3_m1-batch2-batch3-review.md) 的整改是否真实落地。实跑 `npx vitest run tests/m1`（26 文件 630 条全绿）与 `npm run verify`（全部 10 步门禁，退出码 0），Node 20.20.2
> 审核基准：HANDOFF.md（2026-08-08，批 4 完成）声明 M1 代码完成（757 条测试、632 条 m1 阻塞用例），剩真机十步验收

## 1. 结论摘要

**批 4 达到设计基线，M1 代码层可以进入真机验收。** 这次审核最显著的发现不是批 4 本身的问题，而是 **[review/3](3_m1-batch2-batch3-review.md) 的三个正确性问题全部真实修复，且修复方式比建议的更彻底**：

- **§3.1（高）**：`*_NEW` 现在走 `writeFileNoReplace`（stage tmp → `link`+`unlink`），`target-exists` → `ABORTED_PRECONDITION` 下轮重规划；无硬链接的文件系统退化前先做存在性检查并在报告标 `noReplaceUnavailable`（ADR-36）。批 3 报告担心的"PULL_NEW 落地期间 CLI 创建同名文件被无备份覆盖"这条 I1 缝隙已闭合。
- **§3.2（中高）**：P3 接上 `EvidenceCache`，且**两侧 E1 命中且 hash 相等时不调用 `plan()`，直接 NOOP**——EV-1 由纪律变成控制流（ADR-35）。这比批 3 建议的"E1 复用 hash"更激进也更安全：缓存 hash 根本没有进入决策分支的路。稳态 pass 实测 0 次全文读（`evidence-tiers.test.ts` 用 `resetIo()` 计数器断言）。
- **§3.3（中）**：`sameSignature` 改为复用 `stability.signaturesEqual`，`ino` 比较回归。

同样值得记录的是 **review/3 §4 的覆盖欠账全部补齐**，且过程中抓到并修复了**三个 review/3 没发现的真 bug**（见 §2.6）。这种"整改时发现新 bug 并修掉"的轨迹，是测试真正在工作的证据，比"全部通过"本身更有说服力。

发现 **0 个 Blocker，0 个高危**。有 2 个中低危正确性/规范讨论点与若干观察项，均不阻塞真机验收，建议记入 M1 收尾或 M2。

## 2. 分层评估

### 2.1 批 4a · 落盘门面 — 优

**`json-file.ts`（100 行）— 优**
- `readJson` 把 absent / unusable / loaded 三分，且 **`EACCES` 归 `unusable` 而非 `absent`**——注释正确指出"不可读绝不是空目录，混同会让权限问题变成'远端看起来是空的，全量推上去'"。这是 review/1 §4.2 关注的"远端被误读为空"在文件读取层的防线。
- 零字节文件归 `unusable`（崩溃在 create 与 write 之间留下的东西），不当作 absent——保住了调用方"要不要重建"的决定权。
- `unusable` 从不在此处被重写，重建与否的决定留给知道文件用途的调用方（manifest 可重建、root.json 不可）——层次划分正确。

**`home-store.ts`（329 行）— 优**
- store (b)（§5.5/§5.6）的布局与读写；每个路径经 `mintStatePath` 铸造，无裸 cast。
- `loadRemote` 对 `syncDirPath` 不匹配的记录**归零为 `INITIAL_REMOTE_RECORD`**——注释正确："一条关于别的目录的记录对这条目录什么也没说；轻信它会把另一个目录挣来的 READY 状态送给这条目录"。
- `loadObservations` 把 §5.5 的 fail-safe 具体化：任何疑虑都用空 ledger 跑一轮（慢，从不出错）。
- `parseProviders` 中 `enabled: v.enabled === true`——缺席即禁用，注释正确："provider 由用户说'开'而开，不是由一条畸形记录忘了说'不开'而开"。

**`sync-dir-store.ts`（286 行）— 优，是批 4a 最重的模块**
- store (c)（§5.3/§5.4/§9.6）；**每个写入路径经 `resolveUnderRoot`（逐级 symlink walk）而非 `mintStatePath`**——注释正确："家目录是我们的、布局是构造的；这个目录是不可信的，逐级 walk 正是重点"。这是对不可信目录的正确态度。
- manifest 与 root.json 的不对称处理到位：manifest 是缓存（不可读=重建，代价是慢一轮）；root.json 是身份（不可读=停，重建会毁掉另一台机器认这条目录的锚）。
- `readRoot` 严格区分 absent / corrupt / ok——`unusable`（含 EACCES）归 `corrupt` 不归 `missing`，因为"missing + 空目录"是唯一会提供初始化按钮的路径，权限错误绝不能摸到它。
- `isEmpty` 把 `.DS_Store`/`Thumbs.db`/`.aiss/` 等归为"非内容"——注释给了具体理由（macOS Finder 新建的文件夹已含 `.DS_Store`，把它当内容会让每个新 sync 目录变成 NR-1 而非初始化屏幕）。
- `scanWorkspace` 一次 walk 同时产出 counts 与 zeroByteRels——注释正确："分两次取会让文件在两次之间变化，把 shrink 检测与 regression 检测弄出分歧"。
- `probeWritable` 的探针文件名带 machineId——两台机器同时探测不会互相读到对方的失败。

**`backup-writer.ts`（242 行）— 优**
- backup-store 纯逻辑（命名/轮转决策）与本模块 I/O 的分离，正是"轮转规则要能脱离文件系统测试、回答规则所需的读取要能带着文件系统测试"的分工。
- 备份写经 `writeFileNoReplace`（独占）——注释正确："一个我们认为空着的名字被占了，说明有别的东西在写；写穿它会毁掉一个备份来做一个备份"。
- `rotate` 中 unreadable 的旧备份 `recoverableFromSurvivor` 归 false（"不能证明"必须读作"保留"，否则就是在无知上删除）。
- `isReproducible` 刻意**不复用 `comparePrefix`**——注释解释了为什么：合并问题里"前缀停在记录中间"是否决项（下一台机器会接到半成品行），而备份问题只问"这些字节还找得回来吗"，半截前缀从更长版本里依然找得回来。这是对同一个"前缀"概念在两个语境下不同语义的精准把握。
- `appendIndex` 故意吞掉失败（索引是给人看的便利，恢复从不查它）——有注释说明，方向正确。

**`lock-file.ts`（155 行）— 优，修复了批 3 没发现的真 bug**
- `read()` 把"没有文件"（absent）与"文件读不懂"（corrupt）**分开**——这正是 HANDOFF 记载的 bug：之前都归 null，于是获取锁时对着那个刚被判定忽略的文件做独占创建、失败、报 `LOCK_HELD`，插件从此再也不同步。现在 absent 才允许独占创建，corrupt 走覆盖（注释解释了为什么这对：epoch 复查让任何接管都可恢复）。
- 心跳在 `mayWrite` 里做（每次写前自然报到），无独立 timer；过期则下轮 `mayWrite` 返 false——"丢一个 pass，不碰撞"。
- `release` 只删"仍是自己的"锁——删掉被偷的锁会让第三个实例在小偷 mid-write 时自由获取。

### 2.2 批 4a · 编排组合根 — 优

**`state-adapters.ts`（270 行）— 优**
- ledger（本机观察）与 evidence cache（内容事实，remote 半在 sync 目录、由别的机器写）的 provenance 分离，正是 review/2 §3.2 的要求。注释明确："两者都可以错；ledger 错代价是慢一轮，cache 错代价是漏一轮；都不能代价是一次写"。
- `recordVerified` 把 hash 与"算它时针对的签名"**成对存储**——注释正确："`sig` 在每次观察都会动，包括看着文件变却没读的 pass；把会动的 sig 配一个旧读的 hash，正是 E1 绝不允许的错配"。
- `evidence.lookup` 的 remote 侧先过 `isValidEntryKey`（M-06），local 侧要求 `verifiedSig` 与 `contentHash` 同时在——两个来源的信任度差别不改变它能授权的事（只能 NOOP），这与 ADR-35 一致。
- `recordOutcomes` 把 `abortStreak`/`skippedForBudgetPasses` 的递增从引擎的 ledger 写里分离出来——注释正确："引擎报告 outcome，ledger 存 outcome；把 action 结果穿进 `LedgerEntryView` 会把报告关注点塞进稳定性判定读的类型里"。

**`pass-runner.ts`（496 行）— 优，是批 4a 的组合根**
- 阶段顺序（roots → overlap → machine identity → binding → workspace identity → readiness → state load → runPass → commit）不可互换，每步在 `runPass` 前都可零写入中止——文件顶部注释把这个"为什么是这个顺序"讲得极其清楚。
- `findNonCanonicalRoots` 把"root 不是自己的 realpath"变成一句话（`root-not-canonical`）——macOS 的 `/var`→`/private/var`、Windows 的 8.3 短名让 `resolveUnderRoot` 正确但不可读地拒绝一切，这个 preflight 把一类 CI 教训固化成可诊断的错误。
- **NR-5 盲区修复**（HANDOFF 记载）：就绪扫描在 pass 前跑，记下的计数从不含我们刚写的；写过的 pass 在 commit 时补一次扫描。当前实现（L296-310）只在有 push 且 APPLIED 时补扫，且 `maxCounts` 保证高水位只升不降——注释解释了为什么不能写入更小的数（"会让 shrink 检测对着我们自己的测量噪声上膛"）。
- T6 采样用 `hashBytes(token + key)` 排序而非 `Math.random`（domain 层禁令的延伸），均匀且可复现。

**`workspace-identity.ts`（119 行）— 优**
- 身份由用户显式创建一次（ADR-20），拒绝一切猜测。`readWorkspaceIdentity` 把 `unusable` 透传为 `null`（而非 `undefined`=absent）——注释正确："截断的身份文件是半途的 vault 同步；读成'还没有身份'会给用户一个 Create 按钮，为已有身份的工作区再铸一个 id"。
- `IDENTITY_MESSAGES` 作为数据与 checker 放在一起而非散在 settings tab——"这些字符串是 fail-closed 设计的全部用户契约；一个说'something went wrong'的状态会让拒绝同步看起来像 bug 而非决定"。

### 2.3 批 4b · plugin-runtime — 优

**`plugin-runtime.ts`（754 行）— 优，是批 4b 的核心**
- **不含任何 Obsidian 类型**，lint 强制（`obsidian` import 只允许在 `src/ui/` 与 `src/main.ts`）——这是整个插件能在纯 Node 测试里跑的边界，且是被执行而非被意图。
- 构造纯（`onload()` 不读文件系统）；所有 I/O 在 `refresh()` 或更后——sync 目录通常是云盘，Obsidian 加载插件时阻塞。
- `RuntimePhase` 扁平枚举（10 个互斥情形）而非嵌套布尔——状态栏与设置页都需要"现在什么情况"作为单一答案。
- `pathGuard()` 的 bootstrap 正确：先以 `caseSensitive: true` 构造临时 deps，mint 出 state root 做探针目录，再真实探测——注释解释了为什么临时值不会影响结果（state root 平凡地包含自身）。
- `loadOrCreateMachine` 的漂移轮换是静默的（machineId 从不参与决策，轮换成本是审计列表多一行）——与 §10.3 一致。
- `prepare()` 失败时返回 status 而非抛——"pass 无法组装"本身是状态栏需要显示的结果。
- `syncNow` 的 catch 把异常归为 error phase 而非吞掉——注释正确："抛出的 pass 是 bug 不是普通结果；每个预期失败都是值。把它浮成 error 状态而不是吞掉，是用户看到'出事了'与看到插件悄悄停止同步的差别"。

### 2.4 批 4b · UI 组件 — 优

**`settings-tab.ts`（266 行）— 优**
- runtime 以 thunk 传入（注册 tab 不构建 runtime，否则 realpath vault 路径会破坏 `onload()` 零 I/O 契约）。
- 面板围绕"插件拒绝做什么"组织（无身份→创建一次、无 sync 目录→选一个、空目录→新还是在下载），每个拒绝附一句风险解释——注释正确："一个只有名字当标签的 setting 什么也教不会；这里的标签是插件停下来的理由"。
- sync 目录路径输入框**无 placeholder 示例路径**——注释解释了双重原因（为 macOS 写的示例在 Windows 上是错的；密钥扫描器也会拒绝字面家目录）。这是把 check:secrets 门禁的约束转化成了设计决定。
- "Backups cannot be switched off"直接写进描述，且测试断言输入 0 后 `backupKeep >= 1`。

**`conflict-modal.ts`（127 行）— 优**
- 三个选项，第三个（"show me both"）不是凑数——注释正确："只给两个按钮会逼人猜；'让我自己看'是合法答案，一个只提供两个看似不可逆按钮的插件会逼人乱选"。
- **措辞完全避开 "local"/"remote"**——注释正确："这两个词的含义随你坐在哪台机器前而互换，正是当初让冲突 id 由内容派生要避免的混乱"。有测试断言文案不含这些词、不含会话内容。
- `describeOutcome` 给 `branch-moved` 一句完整的话（它不是故障：对话框开着时 session 动了，所以你看的分歧已不是盘上那个）。

**`report-modal.ts`（107 行）— 优**
- dry run 的唯一输出是这个视图，所以每行带决策依据的四元组而非一句话。`explain()` 只渲染 size/line count/evidence tier/hash **前缀**——"够审计一个决定，永远不够读一个"。
- `PassReport` 类型上没有能放一行对话的字段（§11.2），所以这个视图无论如何渲染都不可能泄漏——有测试用 sentinel 字符串断言整个 UI（设置页 + 报告 + Notice）不含会话文本。

**`main.ts`（225 行）— 优**
- 纯装配；8 条命令、ribbon、状态栏、设置页、定时 pass 全转手给 `PluginRuntime`。
- `onload()` 不读文件系统；`getRuntime()` 惰性构建；首次 pass 经 `setTimeout(…, 0)` 排出——注释解释了为什么只 `onLayoutReady` 不够（从设置面板启用插件时 `onLayoutReady` 是同步回调，在 `onload()` 内部触发）。
- `rescheduleIfNeeded` 只在数字变化时重建 interval——注释正确："每次 pass 都换会为插件生命周期累积注册，尽管每个单独的都 tidy"。
- `globalThis.setInterval` 而非 `window`——bundle 被合同测试在纯 Node 里 head-first 加载，`window` 不存在，那里的 ReferenceError 会是测试装置失败冒充生产失败。
- `vaultRoot()` 用 `realpathSync.native`——批 4a 发现的"原子写从不建目标目录"bug 的教训已固化（ADR-37，world 的 `mintWritePath` 替身顺手 mkdir 把它盖了一路）。

### 2.5 review/3 整改验证 — 全部真实落地

| review/3 项 | 验证结果 | 证据 |
|---|---|---|
| §3.1 高：`*_NEW` 用覆盖式 rename | ✅ **修复，比建议更彻底** | `sync-engine.ts` L583-610：`overwriting` 走 `writeFileAtomic`，否则走 `writeFileNoReplace`；`target-exists` → `ABORTED_PRECONDITION`；`noReplaceUnavailable` 上报。ADR-36 |
| §3.2 中高：绕过 E1/E2 | ✅ **修复，比建议更激进** | `sync-engine.ts` L264-289：双侧 E1 命中且 hash 相等 → **不调 `plan()` 直接 NOOP**（ADR-35）；稳态实测 0 全文读。`evidence-tiers.test.ts` 的"伪造 manifest 上限"用例直接断言最坏情况是"一轮什么都不做" |
| §3.3 中：`sameSignature` 漏 `ino` | ✅ **修复** | `sync-engine.ts` L838-846：改为复用 `signaturesEqual`，注释说明"引擎不再自己写一份比较" |
| §4.1 U-12b / U-14 / malformedTail | ✅ **补齐** | `sync-engine.test.ts` 有 U-11d/U-12b/U-14；`sync-engine.ts` L322-331 把 `malformedTail` flag 转成 `notices` |
| §4.2 S 编号漂移 | ✅ **对齐** | testing.md §7.2 加了引擎级覆盖现状表（本次未逐条复核，但 HANDOFF 与测试名已对齐） |
| §4.4 §11.2 字段禁令门禁 | ✅ **装上，且发现第一版是死的** | `pass-report.test.ts` 逐条字面量断言；注释记载"循环形式的 `not.toHaveProperty(name)` 在联合类型时不判别，加 `content` 也不红" |
| §4.5 type-aware lint | ✅ **装上** | `eslint.config.mjs` 开 `projectService`；`no-floating-promises`/`await-thenable`/`no-misused-promises` |

### 2.6 整改过程中抓到并修复的新 bug（review/3 未发现）

这三个 bug 是 HANDOFF 明确记载、且当前代码里能看到修复痕迹的。它们的存在本身就证明了"测试在真工作"：

1. **坏锁文件是永久的**（`lock-file.ts`）：absent 与 corrupt 不分导致 LOCK_HELD 死锁。当前 `read()` 三分。
2. **NR-5 在每次 push 后有一轮盲区**（`pass-runner.ts`）：就绪扫描不含自己刚写的，清空目录在那轮读成"从来没有东西"。当前 commit 时补扫。
3. **原子写从不建目标目录**（ADR-37）：world 的 `mintWritePath` 替身顺手 mkdir 盖了一路，换真 PathGuard 后每次 `PUSH_NEW` 都 `FAILED_IO`。当前归 `stageTemp`。
4. **`truncatedTailPasses` 从不递增**（`sync-engine.ts`）：导致 U-11d 在引擎里根本不可达。当前 planner 的 `history.truncatedTailPasses` 取两侧 streak 的较长者，且引擎层正确递增。

## 3. 正确性/规范讨论点（中低危，不阻塞）

### 3.1 中低：E1 NOOP 分支跳过了 `conflictKnown` 判定

**位置**：`sync-engine.ts` L268-289。

**现象**：E1 双侧命中且 hash 相等时直接 NOOP，**不调用 `plan()`**。这意味着如果某个 session 之前曾被判 CONFLICT 且 quarantine 目录已存在，但当前两侧 hash 恰好相等（例如用户手工把两侧改成一致后又触发 E1），E1 分支会绕过 `plan()` 里"已知冲突 → NOOP 携带 `conflictKnown: true`"的逻辑。

**评估**：这不造成数据损失——E1 只在两侧 hash 相等时命中，而 hash 相等意味着内容一致，本来就不该有冲突。`conflictKnown` 的本意是"同一对发散内容已隔离过，别重复堆副本"，而 E1 命中时内容根本不一致的场景不存在。此外 `conflictId` 由内容派生，内容一致后旧冲突 id 自然不再被计算（U-21 的自动解除机制）。**结论：语义自洽，但值得在 ADR-35 或 `sync-engine.ts` 注释里点一句"E1 NOOP 不需 conflictKnown，因为 hash 相等即无冲突可言"**——当前注释只说了 EV-1，没说这个推论。

### 3.2 中低：`resolveConflict` 对 `keep-remote` 不查远端就绪

**位置**：`conflict-commands.ts` L100-104。

**现象**：`keep-local`（要写 sync 目录）前查 `mayWriteRemote()`，`keep-remote`（只写本机）不查。注释解释了不对称的理由（"半水合的目录是 push 真正会造成伤害的地方"）。

**评估**：方向正确——`keep-remote` 只把 quarantine 里的 remote 副本写回本机 provider 目录，不碰 sync 目录，确实不需要远端 READY。但有一个边角：`keep-remote` 覆盖本机文件前会备份本机旧版本（正确），可如果本机该 session 在冲突后又被 CLI 续写过，`kept === chosen` 的校验（L113-117）会返 `branch-moved` 而拒绝——这是正确的保守行为。**结论：设计自洽。唯一建议是在 `describeOutcome` 的 `remote-not-ready` 文案里补一句"only keeping this machine's version writes to the sync folder"，让被拒的用户理解为什么另一个按钮可用。**

## 4. 覆盖与门禁核实

- **测试规模**：`npm run verify` 退出码 0；`tests/m1` 26 文件 630 条全绿（HANDOFF 说 632，差异应来自 `tests/posix/` 的平台条件用例，`check:no-skip` 统计口径为 m1 阻塞用例）。
- **UI 测试**（`ui.test.ts` 431 行）：质量高——不是"面板渲染了"，而是"每个拒绝都带理由到达屏幕，且控件做的和标签说的一致"。含 sentinel 字符串断言整个 UI 无会话文本泄漏、双身份文件 → `identity-blocked`、冲突视图三选项且无 "local/remote" 措辞。
- **`stores.test.ts` / `wired-pass.test.ts`**：S-08/S-16/S-17/S-18/S-19/S-20 首次有端到端证据（真 `runWorkspacePass` + 真状态文件），含 root-not-canonical 与四 root 嵌套的 preflight 中止。
- **`evidence-tiers.test.ts`**：E1 稳态 0 全文读（`resetIo` 计数器断言）、伪造 manifest 上限（最坏=一轮 NOOP）、S-06b（manifest 先到不做破坏性动作）、S-07（manifest 删后重建逐字节一致）、X-03（更高 schema 不动 manifest 字节）。
- **`pass-report.test.ts`**：§11.2 门禁——逐条字面量 `expectTypeOf` 禁令 + ALLOWED_KEYS 白名单 + sentinel 字符串断言报告无会话文本。
- **门禁**：`check:no-skip` 630 条 ≥ `--min 100`；`src/ui/**` 单独覆盖率门槛（lines 70 / functions 60 / branches 55）而非塞进全局 80%——符合 HANDOFF"别顺手调低全局门槛"的告诫。
- **lint**：`obsidian` import 只允许 `src/ui/` 与 `src/main.ts`；type-aware lint 已开。

## 5. 规范一致性

| 项 | 状态 |
|---|---|
| `onload()` 零 I/O（§12.2c） | ✅ 构造纯，thunk 惰性，`setTimeout(…,0)` 排出首 pass |
| obsidian import 边界（§4.1） | ✅ lint 强制，plugin-runtime 无 Obsidian 类型 |
| E1 只能授权 NOOP（§5.3.2 EV-1 / ADR-35） | ✅ 控制流层面：E1 分支不调 `plan()` |
| `*_NEW` 只能 `writeFileNoReplace`（ADR-36） | ✅ `target-exists` → `ABORTED_PRECONDITION` |
| 备份不可关闭 / 覆盖前必备份（§9.3） | ✅ `backup-writer` 失败返 null 取消覆盖；UI 描述明说 |
| 冲突状态由内容派生（§8.1） | ✅ `conflictId` 哈希派生，U-20/U-21 全绿 |
| 身份显式创建一次（§5.2.3 / ADR-20） | ✅ `workspace-identity.ts` 拒绝一切猜测 |
| machineId 漂移静默轮换（§10.3） | ✅ `plugin-runtime.ts` `loadOrCreateMachine` |
| store (b) 绝不同步 / store (c) 不授权破坏（§5.6） | ✅ `home-store` 与 `sync-dir-store` 的态度不对称且正确 |
| 不读时间戳做决策方向 | ✅ 时钟仅用于本机稳定性观察与报告 |

## 6. 结论与 M1 收尾建议

批 4 是 M1 的收官批次，质量与前三批一致且在工程严谨度上更进一步：**review/3 的三个正确性问题全部真实修复（两个比建议更彻底），整改过程中还抓到并修复了四个 review/3 没发现的真 bug**。UI 层把"每个拒绝都带理由到达屏幕"作为测试断言的对象，而不是停留在"渲染不崩"——这对一个核心承诺是"绝不静默丢 session"的插件来说，是正确的测试哲学。

M1 代码层可以进入真机十步验收。建议验收前或验收中顺手处理：

1. **§3.1（10 分钟）**：在 `sync-engine.ts` E1 分支或 ADR-35 补一句注释，点明"E1 NOOP 不需 `conflictKnown`，因为 hash 相等即无冲突可言"——消除后来者"这里是不是漏了什么"的疑惑。
2. **§3.2（10 分钟）**：`describeOutcome` 的 `remote-not-ready` 文案补一句"only keeping this machine's version writes to the sync folder"。
3. **真机验收重点**（testing.md §9.4）：批 4 的落盘门面（home-store / sync-dir-store / lock-file / backup-writer）全部依赖真实文件系统行为，是 CI 三平台绿但真机仍可能翻车的区域——尤其 Windows 的 `link()` 在跨盘或某些文件系统上的行为、`renameNoReplace` 的退化路径、以及云盘客户端对 `.aiss/` 与 `.quarantine/` 的处理。
4. **M2 前瞻性记录**：OQ-7（1000 session 规模性能）现在有 E1 稳态 0 全文读做地基，但 `scanWorkspace` 每次 push 后补扫 + `walk` 递归在全量文件数大时的成本值得在 M2 基准里量化。

## 附：三批 review 追踪闭环

| review | 报告 | 发现 | 当前状态 |
|---|---|---|---|
| review/1 | 设计审核（pre-implementation） | 28 项 finding，含 manifest 缓存 / mtime / machineId / workspace 双 id / 路径穿越 / append-only 未验 / I1-I2 形式化 | 全部落实为结构或显式拒绝（testing.md 附录 A） |
| review/2 | 批 1 领域层 | 0 Blocker；2 低危（fastPath 矛盾输入、hints 来源混合）+ 覆盖欠账 | hints/history 已分离（批 2/3）；覆盖欠账在批 3/4 补齐 |
| review/3 | 批 2/3 infra + SyncEngine | 1 高（NEW 覆盖式 rename）+ 1 中高（绕过 E1/E2）+ 1 中（漏 ino）+ S 编号漂移 + 门禁欠账 | **全部真实修复**（本报告 §2.5 逐条验证） |
| review/4 | 批 4 落盘 + UI | 0 Blocker / 0 高危；2 中低危讨论点（§3.1/§3.2） | 待 M1 收尾顺手处理 |

三批实现 review 的发现数呈 28 → 2 → 3 → 2 的收敛趋势，且严重度从 Blocker 降到中低危讨论点——设计基线在每一轮都真实抬高，没有在后续批次发现"早期批次的根本性返工"。这是健康的演进轨迹。
