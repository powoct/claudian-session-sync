# M2（Codex provider + 记录准入 + 远端白名单）代码审核报告

> 审核对象：M2 全部改动（commit `71bb906..a18874c`，9 个 commit）。核心源码：`src/orchestration/sync-engine.ts`（+105）、`src/providers/{provider-adapter,registry,vault-scope}.ts`、`src/providers/claude-code/adapter.ts`、`src/providers/codex/{adapter,rollout-name}.ts`、`src/domain/{external-artifacts,conflict,settings}.ts`、`src/orchestration/{conflict-commands,pass-report,pass-runner,plugin-runtime}.ts`、`src/ui/{report-modal,settings-tab}.ts`；及测试 `tests/m1/{codex-adapter,conflict-shape,external-artifacts,multi-provider,record-admission,remote-whitelist}.test.ts`（新）、`tests/helpers/{fake-providers,world}.ts`、`tests/m1/{provider-adapter,pass-report,ui,conflict}.test.ts`（改）。合计约 2600 行新增
> 审核日期：2026-08-13
> 审核方式：只读代码审核。逐文件通读 M2 全部 diff，对照 architecture.md §5.3.2/§5.4/§6.1/§6.2/§6.4/§6.6/§7.2b/§8.2/§9 与 testing.md I1–I4，及三份 M2 findings（claudian-source-survey、m2-probe）逐条核对。关键前提由主会话亲自复核（见各 finding 的「复核」注记）。实跑 `npm run verify` 全绿（716 条 M1 用例、21 条 bundle 合同、语句覆盖率 91.3%、全部门禁退出码 0），Node 20.20.2
> 审核基准：HANDOFF.md（2026-08-12/13）声明 M2 已交付「Codex adapter + 注册表 + 设置」「ConflictMeta v3 + mode 守卫」「记录准入推广为统一规则（ADR-47）」，M1 现网缺陷（ADR-45 远端白名单）已修，OQ-11/OQ-13 已决

## 1. 结论摘要

**Blocker：0 ｜ 高危：0 ｜ 中：2 ｜ 低：3（1 条经复核为假警报，已剔除）。**

**总判：M2 达到设计基线，可以进入下一步（M4 README + 真机验收）。** 三处核心改动——ADR-45 远端白名单接线、ADR-46/47 记录准入、ConflictMeta v3 + mode 守卫——实现与 HANDOFF/架构文档声明一致。E 节（不变量）逐条核对**未发现回退**：manifest 仍只授权 NOOP、`*_NEW` 仍走 `writeFileNoReplace`、覆盖前必备份、决策仍不读时间戳、`domain/` 仍无 `RuntimeEnv`/`Date.now`/`Math.random`、`as SafeAbsolutePath` 铸造点未扩散。

本次最显著的不是实现缺陷，而是**两条中危均为测试缺口而非实现错误**——且都朝着 HANDOFF 反复强调的"看起来成功"方向：一个在未来有人注册第三个 adapter 时才发作，一个在 adapter 两份白名单漂移时才发作。它们今天全是绿的，价值在于"那天会变红"。

## 2. 分层评估

### 2.1 sync-engine — 优

`listReplicaFiles`（967–998）按 adapter 逐 subtree 递归遍历，深度上限 `depth + 1 < MAX_DEPTH`（6 层文件，覆盖 Codex 的 `provider/YYYY/MM/DD/file` 5 段，余量正确）。远端-only 文件经 `adapter.classifyNeutral` 判定（237–247），`null` 进 `unknownFiles` 并携带 layer 2/3 分类——**ADR-45 的"远端侧第 1 层"已真正接线**。归属不再一律 `adapters[0]`。mode 守卫（263–271）在决策表前拦截非 `append-jsonl` primary，产出 `SKIPPED_POLICY` + notice，注释把"为什么不能跑决策表"（binary 会被当行比较、`tailState` 把非 UTF-8 尾部叫 truncated、DEFER 后文案句不达意）讲得极清楚。`remoteOnlyGroup` 的 `absPath: ""`/`lastModifiedMs: 0` 确认不被任何决策路径消费。

### 2.2 providers — 优

`vault-scope.ts` 解析**全部 fail-closed**：`sessionId: null`、缺 `providerState`、三选一（`sessionId`/`threadId`/`providerSessionId`）、墓碑排除、JSON 撕裂跳过、非 UUID 拒绝，两个 adapter 共用同一读取端（claude-code 传 `"claude"`、codex 传 `"codex"`），无漂移面。Codex adapter 归属**只用 vault 记录的 id**，`sessionFilePath` 等绝对路径字段从不读取；`classifyNeutral` 刻意不校归属，注释说清了为什么。`rollout-name.ts` 正则 `^(?:.+-)?(<UUID>)\.jsonl$` 双锚定、无嵌套量词（ReDoS 免疫）。`registry.ts` 的 Codex `experimental: true` + `scopeNote` 与 HANDOFF/§6.1.1 一致。`provider-adapter.ts` 的 `classifyFileName` 仍是"前导段"语义，Codex 不用它而用尾部锚定——`rollout-name.ts:32-38` 把"为什么不能共用"写明，这份诚实值得肯定。

### 2.3 domain — 优

`external-artifacts.ts` 的 layer 2/3 严格只读：OneDrive `-<hostname>` 低置信必须 sibling 佐证（107–119），`insertionBetween` 对 extensionless 名字处理正确。已验证 `confidence` 字段只决定文案、不进任何判定，符合 §8.2"第 2/3 层只决定这句话怎么写"。`conflict.ts` v3 存 `neutralRel`（117–131 注释把 schema 2 为什么错讲得比代码本身还清楚），`buildConflictMeta` 按 hash 排序分支、不含 local/remote 标签（ADR-40 机器中立）。`settings.ts` 的 `maxFileSizeMB` fallback 20→64 与 P5 实测一致，注释把"为什么是 64"写了。

### 2.4 orchestration 其它 — 优

`conflict-commands.ts` 的 v3 接入干净：`readEntry` 优先用记录的 `neutralRel`，v2 回退 `\`${providerId}/${logicalId}${extension}\`` 重建——对唯一写过 v2 的 flat provider 正确，对 nested provider **正确地为 superseded 而非错误地可解决**。`resolveConflict` 返回 `neutralRel` 供 `plugin-runtime.ts:347-350` 结算粘性集合，链路通。`pass-report.ts` 的 `UnknownFileEntry` 类型上无内容字段，`pass-report.test.ts` 已把 §11.2 字段禁令扩展到它。`pass-runner.ts` 的 `mintWritePath` 根集合含全部 provider root——"第二个更简单的写入路径"没有出现。

### 2.5 ui — 良

`settings-tab.ts` 的 `describeProvider` 正确渲染 Tier + experimental + scopeNote；`report-modal.ts` 把 `unknownFiles` 渲染为 "Files left alone"。`conflict-modal.ts` 对 `superseded` 条目禁用 keep 按钮——v3 误报 superseded 的回归路径在 UI 层有兜底。

### 2.6 测试 — 良（三处"看起来成功"方向的缺口）

新测试的"会红"意识总体很好：`remote-whitelist.test.ts` 明确写在 wired pass 上（"the classifier was correct all along and unit-tested; what was missing was the call"——正是 review/3 的「死 gate」教训的正面应用）；`conflict-shape.test.ts` 造 v2/v3 目录断言 `superseded` 真假两向；`multi-provider.test.ts` 的 silent-adapter 用例（不 list 但 replica 有文件 → 仍 `PUSH_OVERWRITE`）钉住了准入/成员资格分离这堵承重墙。三条缺口见 finding M2-2 / M2-3 / M2-4。

## 3. 发现清单

### 正确性缺陷

**M2-1 ｜ 低（测试断言误导，生产代码正确）** ｜ `tests/m1/codex-adapter.test.ts:213`
`rolloutLogicalId` 对含**冒号**的时间戳前缀（`rollout-2026-08-06T12:43:59.123Z-<id>.jsonl`）断言通过。生产正则行为正确（该名字会被 `path-safety` 的 `WINDOWS_ILLEGAL` 拒绝，永不同步），但测试把"永不落进 sync 目录的形状"当合法输入，给未来改正则的人错误印象。
**依据**：findings/2026-08-13-m2-probe P1（实测冒号 0）；`path-safety.ts` §9.7.3 ⑦。
**建议**：改注释为"前缀形状宽容（该前缀本身会被路径规则拒绝，宽容无害）"，并补一条"含冒号名字 `classifyNeutral` 通过 adapter 校验但 `parseNeutralRel` 拒绝"的引擎级断言。

### 测试缺口

**M2-2 ｜ 中** ｜ `src/orchestration/sync-engine.ts:235-247`、`tests/m1/multi-provider.test.ts`
未注册 provider（`opencode`/`grok`/`pi`）的 replica 文件当前无害——`listReplicaFiles` 按已注册 adapter 的 subtree walk，未注册的根本不被遍历（**主会话已复核 967–998 行确认**）。但**没有一条测试钉住"未注册 provider 的 replica 文件永远不被落地"**。multi-provider 测试用 `extraAdapters` 注册假 adapter，方向相反。这条测试今天绿，价值在有人注册第三个 adapter 且其 `classifyNeutral` 宽松匹配那天变红。
**依据**：§6.1"Tier 归属必须有实测证据，未验证一律只读"；findings/2026-08-12 §3（OpenCode 结构排除）。
**注入验证**：临时在 `PROVIDERS` 塞一个 `classifyNeutral: () => ({ logicalId:"x", role:"primary", mode:"append-jsonl" })` 的 `opencode` adapter——测试应变红（它被 pull 了）；若仍绿说明测试没走到那条路径。

**M2-3 ｜ 中** ｜ `src/orchestration/sync-engine.ts:235-247`
`classifyNeutral` 返回非 null 即进决策流。claude-code aux 被跳过**纯属巧合**（aux 恰好不是 primary）。§6.2 实现约束要求"`classifyNeutral` 与同一 adapter 的 `listSessions` 共用一份白名单声明"——claude-code 做到了，codex 用等价另一套，但**引擎层没有测试验证这份自洽**。若未来某 adapter 的 `classifyNeutral` 对非 primary 形状错误返回 `role:"primary"`（如 Grok 的 `updates.jsonl`），无任何测试拦下。
**依据**：§6.2 `classifyNeutral` 实现约束；ADR-45。
**注入验证**：把 claude-code `classifyNeutral` 的 `parts.length === 2` 改成 `=== 3`——自洽测试红，但现有全部测试可能仍绿（引擎只喂 remote-only 文件），这正是缺口。
**建议**：加表驱动测试——每个已注册 adapter，把 `listSessions` 能列出的每个 `neutralRel` 喂给它自己的 `classifyNeutral`，断言非 null 且 `logicalId` 一致；反向亦然。这是"两份白名单不漂移"的直接编码。

**M2-4 ｜ 低** ｜ `src/providers/vault-scope.ts:113-120`
墓碑按文件名前缀匹配（正确，**不读** `.deleted.json` 内容，fail-closed 方向对）。但没有测试钉住"0 字节或撕裂的 `.deleted.json` 仍终止准入"。Claudian `markDeleted` 整份重写（survey §4），撕裂可读非杞人忧天。
**注入验证**：把墓碑集合构建改成读内容 try-parse——测试红；当前按文件名判断是对的，注入后变按内容判断就漏。
**建议**：`record-admission.test.ts` 加一条——墓碑写 `'{'` 半截，断言 session 仍不被准入。

### 观察项 / 建议

**M2-5 ｜ 低** ｜ `src/orchestration/sync-engine.ts:263`
mode 守卫按 `file.mode` 逐 primary 判定，当前 `SessionGroup.files` 只有 primary，无路径可达问题。**M3 接入 Grok（多文件 group）时须把守卫从"逐 primary"提到"逐 group"**——aux mode 可能与 primary 不同，而 §6.6 group 原子性要求整组 DEFER 而非逐文件跳过。现在不必动，记入 M3 前置。

**M2-6 ｜ 低** ｜ `src/providers/codex/rollout-name.ts:20`
`CODEX_ROLLOUT_NAME` 的 `(?:.+-)?` 前缀对超长/控制字符安全（正则线性，路径安全由下游 `parseNeutralRel`/`mintWritePath` 兜底，链条闭合）。建议在文件顶部注释补一句"本正则不负责路径安全，那是 `parseNeutralRel` 的层"——现在这句推理要读者自己走一遍。

**~~M2-7~~ ｜ 已复核为假警报（不计入）** ｜ `src/ui/settings-tab.ts:231`
初审怀疑 `Number("abc")=NaN` 会穿透 `clamp`。**主会话复核 `settings.ts:135` 的 `clamp` 本体**：`typeof value !== "number" || !Number.isFinite(value)` 直接归 fallback——NaN 被 `!Number.isFinite` 拦下，正确落到 64。**无缺陷。**（保留此条仅为记录已核对。）

## 4. 已验证为正确的关键点

- **ADR-45 远端白名单**：三种成品冲突副本（Syncthing / Dropbox EN / OneDrive `-<hostname>`）经 wired pass 断言不进 CLI 目录、原地不动、进 `unknownFiles`；`classifyNeutral` 在 pull/remote 侧每条路径被调用，无 bypass。
- **多 adapter 归属**：远端文件按所在 subtree 归属，`multi-provider.test.ts` 双向交叉断言不落地。
- **日期分层递归**：深度上限 6 层 > Codex 5 段；引擎级用例断言日期目录在 `neutralRel` 中原样保留且落位重建。
- **ADR-46 归属**：`vault-scope.ts` 绝不读 rollout 内容、绝不使用记录内绝对路径；用 `D:\elsewhere\…` 异机路径反证。pull 侧 `classifyNeutral` 不校归属（注释与实现一致）。
- **fail-closed 解析**：`sessionId: null`、缺 `providerState`、三选一、墓碑、撕裂 JSON、非 UUID id（`../../../etc/passwd`）全部有测试，方向全是"不同步"。
- **准入 ≠ 成员资格**：silent-adapter 用例 + 墓碑后仍收敛用例，双向钉住承重墙。
- **mode 守卫**：`SKIPPED_POLICY` + notice、不进决策表、本机零文件，有 opaque-mode 注入测试。
- **ConflictMeta v3 兼容**：v2 目录（无 `neutralRel`）重建对 flat provider 正确可解决、对 nested provider 正确地 superseded，`conflict-shape.test.ts` 两向断言。
- **不变量零回退**：`PlanInput` 无 manifest hash 字段；E1 命中分支不调 `plan()`；`*_NEW` 走 `writeFileNoReplace`；覆盖前必 `deps.backup`；决策不读时间戳；`as SafeAbsolutePath` 在 M2 改动文件中零出现。

## 5. 整改建议汇总

| 编号 | 严重级 | 类型 | 建议落点 | 是否阻塞 M4 |
|---|---|---|---|---|
| M2-1 | 低 | 测试断言误导 | `codex-adapter.test.ts` 改注释 + 补引擎级断言 | 否 |
| M2-2 | 中 | 测试缺口 | 新增"未注册 provider replica 文件不落地"用例 | 否（M3 前补） |
| M2-3 | 中 | 测试缺口 | 新增 adapter 白名单自洽表驱动测试 | 否（M3 前补） |
| M2-4 | 低 | 测试缺口 | `record-admission.test.ts` 补撕裂墓碑用例 | 否 |
| M2-5 | 低 | 观察项 | mode 守卫提为逐 group——记入 M3 前置 | 否 |
| M2-6 | 低 | 注释补强 | `rollout-name.ts` 顶部补路径安全分层说明 | 否 |

**整改窗口建议**：M2-2 / M2-3 / M2-4 三条测试缺口随 M4 一起补齐（成本低、不阻塞发布）；M2-5 记入 M3 开工清单（Grok group 原子性同批处理）。
