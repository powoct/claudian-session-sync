# M1 批 1（领域层纯函数）代码审核报告

> 审核对象：`src/domain/types.ts`、`src/domain/path-safety.ts`、`src/domain/merge-policy.ts`、`src/domain/stability.ts`、`src/domain/planner.ts`、`src/providers/claude-code/path-escape.ts`，及对应测试 `tests/m1/*.test.ts`、`tests/fixtures/path-escape-cases.json`
> 审核日期：2026-08-07
> 审核方式：只读代码审核；未修改被审核代码。逐行通读全部源码与测试，对照 architecture.md §5.3.2 / §6.3 / §7.2 / §7.4 / §9.1 / §9.7 与 testing.md §5.1–§5.5 逐条核对；实跑 `npx vitest run tests/m1`（230 条全绿，Node 20.20.2）
> 审核基准：HANDOFF.md 声明批 1 已完成（230 条 m1 用例，domain 覆盖率 98%）。实测覆盖率：行 99.55% / 分支 96.56%，五个模块函数覆盖率均 100%

## 1. 结论摘要

**批 1 达到设计基线，可以进入批 2。** 两个"最重要的测试"（U-07、U-18）都以其设计形态存在且有层次冗余；review/1 提出的两个 Blocker 级问题（manifest 缓存授权覆盖、mtime 活跃判断）在类型层面被根除而非被规约；决策表优先级与架构 §7.2 逐条一致，并有 5400 组合穷举 + 五条与优先级无关的纯安全断言兜底。

代码质量整体高于常见首版实现：注释解释了每条规则的失败形态（"为什么"而不是"是什么"），fail-closed 方向统一，错误诊断有序且被测试锁定。

发现 **0 个 Blocker**。有 2 个低危正确性缝隙、若干规范引用错位与覆盖缺口，均不阻塞批 2，但建议在批 2 开工前或批 3（SyncEngine 集成）时处理，具体见 §3、§4。

## 2. 逐模块评估

### 2.1 `domain/types.ts`（84 行）— 优

- branded type 三件套 + `Result<T>` 是全部正确性约定的载体。`exactOptionalPropertyTypes` 下 `err()` 对 `detail: undefined` 的显式处理（L49-51）是被注释说明过的刻意行为。
- `InvalidInputError` 与 `Result` 的分工（编程错误 throw / 不可信输入返回 Result）在整个批 1 被一致遵守：`path-safety` 全程不 throw（有测试断言），`path-escape` 对编程错误 throw。
- `PathViolation` 22 个变体中，批 1 纯字符串层实际产出 15 个；其余 7 个（`SYMLINK` / `NOT_REGULAR_FILE` / `HARDLINK_SUSPECT` / `DENYLISTED` / `ROOT_OVERLAP` / `CASE_COLLISION` / `NORMALIZATION_COLLISION`）属批 2（PathGuard/FsGateway）领地，分配合理。

### 2.2 `domain/path-safety.ts`（287 行）— 优，一处冗余导出

- `parseNeutralRel` 的检查顺序（控制字符 → UNC → 盘符 → 绝对 → 反斜杠 → 段级 → 深度 → 逐段 → 总长）与架构 §9.7.3 的 ①–⑦ 顺序一致，且**顺序本身是 normative 的这一点被测试锁定**（如 `"a:b"` 报 `DRIVE_LETTER` 而非 `SEGMENT_CHARSET`，测试里有注释解释为什么这是更具体的诊断）。
- 跨平台等效性处理到位：保留名（含 `com0`–`com9` / `lpt0`–`lpt9`，比 Windows 实际保留集更宽，方向安全）、8.3 短名、NFC/NFD 冲突、大小写冲突都不依赖运行平台。
- `isSameOrDescendant` 分段比较而非 `startsWith`，`caseSensitive` 是运行时探测结果——正是 review/1 §4.6 要求的形式。
- `utf8Length` 按码点算字节数，与段长限制（255 字节）的文件系统语义匹配。
- **瑕疵**：文件末尾 `export type { PathViolation };`（L287）是冗余再导出（`PathViolation` 从 `./types` import 进来只为自用）。无害，但它是 domain 层唯一的"出口非本模块定义"之处，建议删除以免被误当作模式复制。

### 2.3 `domain/merge-policy.ts`（169 行）— 优，一个推理瑕疵

- `comparePrefix` 的三分支（`prefix` / `divergent` / `not-line-aligned`）把"行对齐"做成问题的一部分而非事后检查，§7.4 的核心语义被压缩成 20 行无依赖代码。64 KiB 分块在测试里有跨块边界的 off-by-one 用例。
- `tailState` 对"JSON 前缀极少自身合法"的依赖有明确的例外处理（top-level scalar `123` 判 `truncated`），测试覆盖 scalar / array / string / null / 半截多字节字符。
- **推理瑕疵（低危）**：`tailState` 对**空文件返回 `"lf-terminated"`**（L105，注释 "An empty file has no partial record in it"）。结论对当前批 1 无害——`canBeOverwriteSource(空)` 返回 true 正是期望行为，`planner.tailIsTruncated` 也用 `size > 0` 做了双保险。但该分类在语义上不准确：空文件既不是"以 LF 结尾"也不是"末行完整"。批 3 若有其他消费者按字面理解 `lf-terminated`（例如决定"要不要补一个 LF"），这个值会误导。建议批 3 前要么改返回独立分档（如 `"empty"`），要么在 `TailState` 的 doc comment 里写明"空文件归入 lf-terminated 是约定而非描述"。
- `compareBySignature` 的短路规则（等长 + hash 不同 → `divergent`，无需读字节）正确实现了 U-18b 的领域层一半；另一半（同 size 同 mtime 的 E2 实读）属批 2/3 的 infra，见 §4.3。

### 2.4 `domain/stability.ts`（185 行）— 优

- 完整落实 review/1 §4.3 的裁决：不读时钟判断年龄，只比较本机观察。`E0Signature` 按**分量**存储而非预 hash——这正是 HANDOFF.md 对批 2 的嘱咐，顶部注释把原因（未来 mtime 降级路径需要"剔除 mtime 后重算"）写清楚了。
- `judgeStability` 的四个 unstable 原因全部 fail-safe：缺 ledger 一律 unstable（`no-ledger-entry`），与架构 §5.5 "丢 ledger 退化为只读 + 建立观察"一致。
- future-mtime 路径正确：`ignoreMtime` 剔除单分量后继续比其余四个，且 `flags` 携带 `futureMtime` 让原因可见。时钟回拨（`clockRolledBack`）有界重启窗口而非永久 defer。
- `firstSeenMs` 保留语义正确：quiet-window 等待不重启计时（否则每轮 pass 观察都重置等待、文件永不 actionable），其余一切变化都重置。两条路径各有测试。
- `allowsPullNewFastPath` 的不对称性（只创建、永不替换；`fullyParsed` 必须逐行 parse）与架构 §9.1.3 逐条一致，五个拒绝分支各有测试。
- `signatureKey` 用 `\x00` 作分隔符——字段含 NUL 的可能性在段校验层已被排除，选择安全。

### 2.5 `domain/planner.ts`（234 行）— 优，两处规范级讨论点

- 优先级阶梯（1 格式 → 2 就绪 → 3 体积 → 4 占位符 → 5 稳定性 → 6 已知冲突 → 7 内容相同 → 8 发散 → 9 前缀 → 10 单侧存在）与架构 §7.2 决策表逐条一致，注释明确"顺序是 normative 的，测试断言它"。
- U-18 的根除方式符合 review/1 §4.2 的指导意见：`PlanInput` 上不存在任何能塞缓存 hash 的字段，唯一的 manifest 派生输入被隔离进 `DeferOnlyHints` 独立对象——"让加任何 hash 形状的东西看起来就是错的"这一目标在类型层面达成。
- 0 字节处理是"by construction 而非 by convention"的范例：`normaliseRelation` 不信任调用方对零字节侧的 relation 声明，就地重算；穷举测试再断言"任何声称零字节侧 divergent 的输入都不产出 CONFLICT"。
- `conflictKnown` 只有 `NOOP` 携带、不存在 `CONFLICT_KNOWN` action——与架构 §7.1 末尾的约定一致（稳定冲突与真收敛靠布尔量区分，testing §7.3.2 的 `STABLE_CONFLICT` 判定依赖它）。
- **讨论点一（EV-1 边界）**：`DeferOnlyHints` 里有两个成员，但 EV-1（"只能让决策更保守"）字面上只对 `remoteHadNonZeroSize` 成立（它把 PUSH_OVERWRITE 变成 DEFER）。`truncatedTailPasses` 的效果只是给**已经是 DEFER** 的结果追加 `malformedTail` flag。这不算违反（结果没有变得更激进），但 testing.md §5.2 描述的"唯一例外是布尔量 `remoteHadNonZeroSize`"与实现里 hints 有两个成员的事实存在文档漂移。此外 `truncatedTailPasses` 的规范来源是 manifest/ledger 历史计数，批 2 实现 store 时应把它与 `remoteHadNonZeroSize` 的权威来源分别写清。
- **讨论点二（U-11d 的层次归属）**：testing.md U-11d 的字面期望是"报告 `MALFORMED_TAIL` + Notice，**仍不覆盖任何一方（不是 DEFER 死循环，要让用户看见）**"。当前实现达到阈值后仍返回 `DEFER` + `malformedTail` flag——"让用户看见"依赖报告层渲染 flag + Notice（批 3/4 的职责）。这在分层上是干净的（planner 不产生 Notice），但"不是 DEFER 死循环"的字面要求要靠批 3/4 的消费来兑现。建议：批 3 实现 PassReport 时把 `malformedTail` flag → 报告 `MALFORMED_TAIL` + Notice 的映射写成一条显式验收用例，否则 U-11d 的"可见性"一半永远悬在空中。

### 2.6 `providers/claude-code/path-escape.ts`（100 行）— 优

- 12 条实测样本全部 `verified: true` 且测试断言未验证样本数为 0（机制保留给未来 CLI 版本），三平台覆盖齐全——批 1 从它起步的理由（"输入输出都已知、纯表驱动"）成立。
- 非幂等是刻意的防 bug 设计（把自己输出喂回来 → throw），有测试。
- UNC 拒绝、realpath 责任在调用方、unescape 只产出 `candidates` 且返回类型无法被落位消费（类型级测试）——三处都与架构 §6.3 及 OQ-3 结论一致。
- astral 字符（emoji）按 UTF-16 code unit 映射为两个 `-` 的行为被显式标注为"inferred, not verified"，并指引用 `custom` 策略——⚠️ 假设的标注纪律执行到位。

## 3. 正确性缝隙（建议批 2/3 处理）

### 3.1 低危：fastPath 可越过占位符检查（优先级 4 vs 5 的序错位）

`planner.ts` L131-143：`fastPath` 为真时跳过整个优先级 5（含截断尾检查），但 `pullNewFastPath: true` 与 `remoteSide.isPlaceholder: true` 的组合会先命中优先级 4（`SKIP_PLACEHOLDER`）——这一顺序是对的。然而**`local.isPlaceholder: true` + fastPath** 的组合没有测试：规范上本机不存在该 logicalId 是 fastPath 的前提（`!local.exists`），而占位符必然 `exists: true`，组合在语义上不可能出现。当前测试生成器未把 `isPlaceholder` 纳入笛卡尔积维度，这类"维度外不可能态"只靠读代码论证。建议：要么在穷举生成器里加 placeholder 维度（断言任何 placeholder 输入不产出写），要么在 `plan()` 入口对 `fastPath && local.exists` 显式归一化为非 fastPath。成本低，消除一类"未来的调用方传了矛盾输入"的脆弱性。

### 3.2 低危：`MALFORMED_TAIL_PASSES` 计数来源未在类型上隔离

`truncatedTailPasses` 与 `remoteHadNonZeroSize` 同住 `DeferOnlyHints`，但前者是**本机 ledger 的连续计数**（本机事实），后者是 **manifest 的 size 历史**（别的机器写的字符串，架构 §5.2 L429 要求"当作不可信文本"）。批 2 落地两个 store 时若顺手从同一处喂 hints，会把"不可信远端字符串"引进稳定性计数路径。当前类型无法区分两者来源。建议批 2 实现时把 `truncatedTailPasses` 移出 `DeferOnlyHints`（它是本机事实，不算 manifest 派生），或在 `PlanInput` doc 里写清各自权威来源。

## 4. 测试覆盖缺口（不阻塞，批 3 前建议补齐）

### 4.1 U-18b 目前只有领域层一半

testing.md U-18b 定义在 L1/L2（真实 tmpdir：`R0` → 等长 `R1` + `fs.utimes` 还原 mtime → 跑 pass → 必须 CONFLICT）。当前只有 `compareBySignature` 单元测试（等长不同 hash → divergent）和 planner 的 CONFLICT 分支测试。集成形态（E2 实读不被 E1 stat 缓存短路）要等批 2 FsGateway + 批 3 SyncEngine 才能写——这是层次归属使然，不算缺陷，但 **U-18 的"最重要测试"地位要求批 3 把它列进首批 L2 用例**，建议在批 3 开工清单里显式置顶。

### 4.2 U-12b 的备份断言同样依赖批 2

testing.md U-12b 要求"断言备份区存在那份 0 字节备份"。当前 planner 层只能断言 action 是 `PULL_OVERWRITE`；备份路径未短路这一点要等备份模块。同 4.1，属层次归属，记入批 3 清单即可。

### 4.3 U-14 / U-16 / U-17 未见对应用例

testing.md §5.2.1 的 U-14（空目录 → 空 Action 列表）属 work-list 层（批 3），U-16/U-17 属就绪状态机（批 3 §9.6）。批 1 未覆盖合理，但 HANDOFF.md 批 3 清单未显式列出这三条，建议补进批 3 的用例认领表。

### 4.4 穷举生成器的维度盲区

§5.2.7 笛卡尔积（实测 5400 组合）未含三个维度：`isPlaceholder`、`pullNewFastPath`（固定 false）、`hints`（固定全零）。前三条纯安全断言不受影响（它们针对 divergent / not-ready / oversized / zero-byte，与这三个维度正交），但"fastPath 是不稳定输入到写的唯一通道"这条断言目前只靠两个定点用例守着。建议把 `pullNewFastPath` 与 hints 纳入生成器，断言"fastPath=false 时不稳定输入绝不写"在全部组合上成立（当前该断言在生成器里靠注释 `pullNewFastPath is false throughout this generator` 回避了）。

## 5. 规范引用与文档漂移

| 项 | 位置 | 说明 | 建议 |
|---|---|---|---|
| testing.md 字段名漂移 | testing.md L142 | 称 `PlanInput` 字段为 `observedHash / observedSize / observedStableFor`；实现是 `observedHash / size / stable` | 批 2 前统一，免误导 |
| EV-1 成员数 | testing.md §5.2 vs `DeferOnlyHints` | 文档称"唯一例外是布尔量"，实现有两个成员 | 见 §3.2 |
| 冗余再导出 | `path-safety.ts` L287 | `export type { PathViolation }` | 删除 |
| 0 字节 tail 分类 | `merge-policy.ts` `tailState` | 空文件归 `lf-terminated` 是约定非描述 | 批 3 前写明或分档 |

## 6. 门禁与工程约束合规

- 批 1 代码在 `eslint.config.mjs` 的 domain 规则组覆盖下：`RuntimeEnv` 禁令、`Date.now()` / `Math.random()` 禁令、`../` 禁令、`as SafeAbsolutePath` 铸造禁令——源码中零违反（`stability.ts` 只收 `nowMs` 参数，正是禁令要求的形式）。
- 全部测试使用普通 `expect`/`it`，无 `fc.assert` 裸调用（本批无属性测试，合理）；无 `.skip`（`check:no-skip` 在 M1 起从空跑转为真门禁，230 条 ≥ `--min 100`）。
- `tests/m1/` 五个文件共 137 个 `it` 块（`it.each` 展开后 230 条），命名全部携带 testing.md 用例编号或架构章节号，可追溯性优。
- `path-escape-cases.json` 的 `$comment` 把"input 是 realpath 不是用户输入""用户名已脱敏"两条关键事实写在 fixture 自身里，防误读设计好。

## 7. 结论与批 2 交接建议

批 1 可以放心作为批 2 的地基。两个最重要的失败形态（U-07 分叉覆盖、U-18 缓存 hash 授权）都有"类型层 + 单元层"的双保险，决策表优先级有穷举兜底，真机实测样本全部入库且 `verified` 门槛锁定。

进入批 2 时建议按序处理：

1. **顺手清理**（批 2 开工即做，10 分钟）：删除 `path-safety.ts` 冗余导出；修正 testing.md L142 字段名漂移。
2. **批 2 设计时落实**：`FsGateway` 写方法签名只收 `SafeAbsolutePath` 时，回看 §3.1（fastPath 与矛盾输入）；两个 store 的 hints 来源分离，回看 §3.2。
3. **批 3 首批用例置顶**：U-18b 集成形态（§4.1）、U-12b 备份断言（§4.2）、`malformedTail` → Notice 映射（§2.5 讨论点二）、U-14/U-16/U-17 认领（§4.3）、穷举维度补齐（§4.4）。
