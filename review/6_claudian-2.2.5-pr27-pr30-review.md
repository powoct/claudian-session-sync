# Claudian 2.2.5 适配（PR #27–#30）独立审核报告

> 审核对象：2026-09-01 当日提交，基线 `4ea164d97681083819ca261ed4c567b961029a8e`，审核头 `0adac8e5883674b3c54b0d550486c349203bc2cc`；分别覆盖 PR #27（device 目录准入）、PR #28（不可读目录提示）、PR #29（本机会话发布到 flat 层）和 PR #30（验收及设置迁移）。本地 `origin/main` 为 `71a86fdbdfb30a5b4f32a7da8ae67be84ae81c84`，与审核头 tree 相同
> 上游基准：`<上游 claudian 仓库>` 的 2.2.5 tag（peeled commit `a5f38ad5e693c308f4e9e3100b8b244726a92e80`）；同时复核当前上游 `main` `e66f41c2674f03664788996851490512b3875744`，相关 persistence 文件与 2.2.5 tag 无差异
> 审核日期：2026-09-01
> 审核方式：只读 diff 与调用链审核、与上游 2.2.5 实现交叉核对、全量及定向测试、真实文件系统 symlink 注入。除本报告外未修改项目源码

## 1. 结论摘要

**总判：PR #29 的当前方案不适合发布。** 它解决了“让其他设备看到本机会话”的展示需求，却把 flat 副本放进了 Claudian 的正常读写权威链。结果不是只读投影，而是同一会话同时拥有 device 与 flat 两个可写权威；binding hash 只能发现/冻结一部分分叉，无法消除双写语义，也无法保护 Claudian 共用的 flat input ledger。

PR #27 的方向基本正确，但仍缺 source 侧真实路径约束；PR #28 只识别“未知目录名”，没有识别实际的 EACCES/EIO 等不可读状态；PR #30 的默认值迁移目标合理，但“显式设置过 3000ms”的兼容承诺与实现矛盾，而且会降写未来 schema。四个 PR 不应作为一个整体直接放行。

建议处置：

- **阻止 PR #29 发布**，直到上游提供独立的只读 projection/index 权威，或双方共同定义不会被 Claudian 当成正常会话写入目标的交换格式。
- PR #27 在补上 symlink/junction/hardlink 等 source containment 后可继续。
- PR #28 应区分“目录不存在”“目录名未知”“目录或文件不可读”，并把错误传到 pass report/UI。
- PR #30 在明确 3000ms 迁移取舍、保护未来 schema、补齐可复现验收材料后可合入。

## 2. 核心设计判断：flat 副本不是只读镜像

上游 2.2.5 的会话选择顺序确实是“本机 device → flat → legacy”（`SessionStorage.ts:65-90`），但这只描述**读取优先级**，不表示 flat 是只读层。`ConversationPersistenceStore.ts:213-233` 在 fence 不存在时允许目标路径写入；`ConversationRepository.ts:596-602,1911-1920` 的重命名和保存会写回当前加载到的 authority。因此：

1. 设备 A 继续从自己的 device 元数据读取并写回。
2. 设备 B 从 flat 元数据读取后，也会把标题、pin 等写回 flat。
3. 两边都认为自己在修改正常会话，但路径已经分叉。
4. binding 中的 hash 最多让发布器在发现 flat 被改后停止覆盖，不能把 B 的修改带回 A，也不能定义哪一份是最终权威。

这正是方案原本想避免的“双所有者、双路径”形态，只是第二个所有者从“对端 device 目录”换成了 flat。上游自身也明确要求不要在两个 live authority 之间自动复制（`上游 src/core/AGENTS.md:23`）。

问题还不限于元数据。`ConversationInputLedgerStorage.ts:87-90,124-133` 始终使用 flat 的 `.inputs.json`，并以整文件方式写回；对应 persistence store 路径见 `ConversationPersistenceStore.ts:89-95`。多个设备同时使用同一会话时，输入记录、图片关联和 turn 对应关系可能发生 lost update。即使把元数据镜像做成字段级 CAS，也不能解决这份共享 ledger 的并发写入。

## 3. 阻断项

### B-1｜两个 live authority 会静默分叉

**位置**：`src/orchestration/conversation-mirror.ts`；上游 `SessionStorage.ts`、`ConversationPersistenceStore.ts`、`ConversationRepository.ts`

发布者拥有 device 元数据，接收者拥有可写 flat 元数据。双方的标题、pin、模型等元数据修改都合法，但不会收敛。binding hash 只记录发布时基点，不是跨设备合并协议。设置文案中“对端元数据改动不会回来”虽披露了代价，却没有改变该状态本身对用户数据的一致性风险。

**建议**：不要向上游的正常 flat authority 发布可写副本。需要上游增加只读 projection/index，或使用插件专属、不会被 Claudian 当成会话 authority 的清单格式。

### B-2｜删除后的稳定状态不会清理镜像，会使会话重新出现

**位置**：`src/orchestration/conversation-mirror.ts:86-110`；上游 `ConversationRepository.ts:506-519,1996-2007`

mirror 虽扫描 `.deleted.json`，但删除处理嵌在 `.meta.json` 循环中。上游删除流程会先写 tombstone，再删除 metadata 和 ledger；最终稳定状态通常只剩 tombstone。此时循环看不到 owner metadata，flat 镜像不会被删除。

后果不仅是对端残留：原设备自己的 device metadata 消失后，上游选择链可能回退到仍存在的 flat 元数据，使已删除会话重新出现或重新被准入。当前测试 `tests/m1/conversation-mirror.test.ts:192-205` 在 tombstone 存在时仍保留 metadata，因此没有覆盖上游真实稳定状态，是一条 false-green 用例。

**建议**：删除清理由 tombstone 独立驱动，不能依赖 metadata 同时存在；补“仅 tombstone 留存”的真实生命周期回归测试。即便修复，本项仍不能单独解决 B-1。

### B-3｜“不复制 `.assigned.json`”不足以遵守 fence 语义

**位置**：`src/orchestration/conversation-mirror.ts`

上游会在任何 metadata 路径解析前检查 assignment fence。当前 mirror 不写也不复制 `.assigned.json`，但同样**从不读取它**。如果 source 会话已存在外来、无效或变化中的 fence，发布逻辑仍会把 metadata 复制到 flat。flat 的 `.deleted.json` 也没有成为发布 veto；对端删除 flat 会话后，发布器可把它再次创建出来。

**建议**：source fence 和 flat tombstone 都必须在 metadata 读取/发布之前 fail closed；需要定义 fence 损坏、临时缺失和对端删除的明确状态机，而不是把“不复制文件”等同于“不受文件影响”。

### B-4｜mirror 绕过同步锁，检查与写入之间存在覆盖窗口

**位置**：`src/orchestration/plugin-runtime.ts:241-248,871-899`、`src/orchestration/conversation-mirror.ts:97-143`、`src/orchestration/sync-engine.ts:1013-1059`

mirror 在正常 pass 及其锁之前运行。创建路径是“先读到不存在，再用 replacing atomic write”；刷新与删除也没有最终观察、CAS、no-replace、备份或稳定性检查。peer、Claudian 与同步引擎在检查后写入时，mirror 可能静默覆盖或删除新内容。

同步引擎现有 A8/no-replace 路径已经展示了正确模式（`sync-engine.ts:1013-1059`），但 mirror 没有复用。另一个竞态是 record callback 捕获旧 binding 后保存整份 binding（`plugin-runtime.ts:879-894`），可能覆盖同时发生的设置或 provider 变更。

**建议**：所有 mirror 读改写都进入同一互斥边界；create 使用 no-replace，update/delete 使用以旧 hash 为条件的 CAS，并保留备份与稳定性检查；binding 采用局部原子更新。

### B-5｜开关不是“本设备”设置，关闭也不可逆

**位置**：`src/domain/settings.ts:1-9,38-57,142`、`src/orchestration/plugin-runtime.ts:241-247`

`mirrorConversations` 放在会随 vault 同步的 `PortableSettings` 中。设备 A 打开后，设备 B 收到设置就可能自动发布 B 的本机会话，违反开关名称所表达的逐设备同意。关闭时 runtime 直接不再调用 mirror，已经创建的 flat 副本和 binding 不会清理，用户也无法通过该开关撤回已发布内容。

**建议**：把同意状态放到 machine-local settings；定义关闭时的安全撤回流程，并对已经被 peer 修改、已被 assign 或存在 tombstone 的副本给出明确冲突结果，不能静默删除。

### B-6｜原样复制元数据会传播机器本地能力路径

**位置**：`src/orchestration/conversation-mirror.ts:113-143`；上游 `src/core/types/chat.ts:206-227`、`ConversationController.ts:683-706`、`InputController.ts:1107-1142`、`ClaudeExecutionRequestEncoder.ts:149-181`

mirror 复制原始 metadata bytes，其中包括 `externalContextPaths`。接收设备会原样恢复这些绝对路径，并最终编码为 Claude 的 `additionalDirectories`。如果相同绝对路径在另一台机器上指向不同内容，打开共享会话可能无意授予 agent 对本机目录的访问能力。

这与 README 中“.claudian 含机器本地路径”的风险说明直接冲突：文档承认该字段不能跨机照搬，mirror 却正好进行了照搬。

**建议**：任何跨机 projection 必须采用字段级 allowlist，只携带纯展示字段；路径、工具授权、执行上下文及未来未知字段默认剔除。仅靠 README 警告不够。

### B-7｜device key 文本校验修复了 `../../..`，但真实路径仍可越界

**位置**：`src/orchestration/conversation-mirror.ts:38-39,77-83`、`src/main.ts:162-166`、`src/providers/vault-scope.ts:166-178`

PR #29 已拒绝直接路径穿越的 device key，生产 key 也由 SHA-256 生成；这一修复本身有效。真实文件系统注入仍证明：一个名称合法的 device 目录若是 symlink/junction，`readDir(mine)` 和后续 `readFile` 会跟随到 vault 外，再把外部 `.meta.json` 发布进 store。记录准入代码同样在列目录时丢失 entry type，随后跟随 link，可将 vault 外 session id 纳入同步范围。hardlink 也没有明确拒绝。

临时回归用例 2/2 稳定复现：一条把外部 metadata 发布到 flat，一条把外部 session 识别为已准入。安全扫描把该问题评为 medium，但在本插件的隐私边界中应按发布阻断处理。

**建议**：逐层 `lstat`，拒绝 link/reparse point；解析 realpath 后验证仍位于可信 root 内；对被读取的最终文件重复 containment 检查。若运行环境不能可靠提供这些原语，应 fail closed。

## 4. 重要问题与文档偏差

### I-1｜“Assign to this device”的跨机效果取决于传输通道

内置 Claudian provider 的白名单仅包含 `meta|inputs|deleted`（`src/providers/claudian/adapter.ts:46-49`），不传 `.assigned.json`。因此，“对端点击 Assign 会把原机隐藏”只在整 vault 同步工具也传输 fence 时成立；若用户仅依赖插件 provider，该 fence 不会回到原机。README 与设置文案把条件性行为写成了无条件事实。

**建议**：分别说明 full-vault transport 与 plugin-managed transport 的行为；验收矩阵必须覆盖两条通道。

### I-2｜PR #28 没有真正检测不可读目录

`vault-scope.ts:152-178` 把 `listDir` 异常折叠成空数组，把 `readTextFile` 失败折叠成 `null`；`unreadDirs` 实际只记录不认识的目录名，不记录 EACCES、EIO、撕裂读取等真实 I/O 错误。mirror 也把读取失败转为空/null，而 runtime 在 `plugin-runtime.ts:871-899` 吞掉 outcome/error，最终可能仍显示“up to date”。

**建议**：保留 I/O 错误类别和受影响路径，传入 pass report/UI；测试应注入 `listDir` 与 `readTextFile` 失败，而不是只造陌生目录。

### I-3｜相同字节并不证明 flat 文件属于本发布器

`conversation-mirror.ts:128-133` 遇到一个无 binding、但字节恰好相同的既有 flat 文件时，会直接把它纳入 binding。之后 owner 更新即可覆盖该文件。这违反“不是我写的 flat 记录一概不碰”，因为内容相等不是 provenance 证明。

**建议**：没有插件可验证的创建凭证时只报告冲突，不得收编；凭证也不应放入会被上游解释的会话文件内。

### I-4｜删除语义的注释和验收模型与上游不一致

`vault-scope.ts` 附近注释把删除描述成“markDeleted 后 metadata 仍在”，但上游 repository 完整流程会删除 metadata/ledger。当前测试因此覆盖了瞬态形状，没有覆盖稳定形状。文档中“moving (or copying)”的手工建议也不安全：copy 会直接制造两个 live authority。

## 5. PR #30 专项审核

PR #30 的实际 tracked diff 只有：

- `docs/zh-CN/architecture.md`（+1）
- `src/domain/settings.ts`（+37/-2）
- `tests/m1/settings-migration.test.ts`（+53）

### P30-1｜旧版显式 3000ms 无法被保留，承诺与实现矛盾

迁移代码正确地把 schema 1/default 3000ms 改为 15000ms；fresh default 也为 15000ms。但旧 schema 中“沿用默认 3000”与“用户显式选择 3000”在持久化形状上完全相同，代码自己也承认无法区分（`settings.ts:22-32`）。`carried` 路径（`settings.ts:166-173`）仍把所有旧 schema 的 3000 都迁走。

测试 `settings-migration.test.ts:22-38` 只证明 schema 2 的显式 3000 会保留，回避了真正不可区分的旧 schema 情形。因此“手动设置过 3000ms 的用户不受影响”不成立。

**建议**：产品必须明确选择其一：安全默认优先，接受所有旧 3000 被迁移；或在旧版本先落一个可区分的 explicit-choice 标记后再迁移。无法同时承诺两者。

### P30-2｜读取未来 schema 后会降写为 schema 2

`parseSettings` 接受未来 schema 和未知字段，却始终构造 schema 2（`settings.ts:115-145`）；`serialiseSettings` 以及 `plugin-runtime.updateSettings:329-333` 随后会把文件保存为 schema 2。注入 schema 99 + `futureMode` 的临时测试显示：未知字段仍在，但 schemaVersion 被降成 2。

这会丢失未来版本的迁移权威；文件以后可能被当成旧 schema 再次执行迁移。未知字段保留不能补偿 schemaVersion 被篡改。

**建议**：要么拒绝写入高于当前版本的设置，要么保留原 schemaVersion 并仅更新当前版本明确拥有的字段。不能悄悄 downgrade。

### P30-3｜默认迁移表缺少版本边界

`SUPERSEDED_DEFAULTS` 没有记录“从哪个 schema、迁移到哪个 schema”。下一次升级到 schema 3 时，如果继续保留 3000→15000 映射，schema 2 中用户有意设置的 3000 可能再次被迁移。

**建议**：把迁移建模为按版本顺序执行的函数，例如 `migrate1to2`；只对确切来源 schema 运行一次。

### P30-4｜内存迁移未立即落盘，架构文档仍写 schema 1

refresh 仅在内存中 parse（`plugin-runtime.ts:204-209`），只有以后发生设置更新时才持久化。因此运行期有效值是安全的，但“完成一次迁移/磁盘 schema 已升级”的表述不准确。`docs/zh-CN/architecture.md:1742-1746` 仍把 `PortableSettings.schemaVersion` 写成 1。

**建议**：明确迁移是 lazy 还是 eager；若是 eager，在安全写入和未来 schema 守卫后原子持久化。同步更新架构文档。

### P30-5｜提交说明中的验收材料未进入版本库

commit body 提到 acceptance appendix、`evidence.mjs`、store `--conv` 和安全截断修复，但 `git show 0adac8e --name-only` 仅有上述三个 tracked 文件。相关内容位于被 `.gitignore:2` 排除的 `tmp/acceptance`，其他开发者和 CI 无法复现。

**建议**：若这些材料属于 PR 交付物，把脚本/说明放入 tracked 的 `scripts/`、`docs/` 或测试目录，仅忽略运行产物和敏感 evidence。

## 6. 分 PR 结论

| PR | 结论 | 主要理由 |
|---|---|---|
| #27 | 有条件通过 | device 准入方向正确，直接 device key traversal 已关闭；仍需处理合法名称 link/junction/hardlink 越界读取 |
| #28 | 不完整 | 当前提示的是未知目录，不是真实 unread I/O；错误仍会被折叠并可能显示成功 |
| #29 | 不通过 | 双 live authority、共享 ledger、删除复活、fence/tombstone、竞态、同意范围、能力路径泄漏均未闭合 |
| #30 | 修改后可通过 | 默认值提升合理；旧显式 3000 承诺、未来 schema 降写、版本化迁移与验收材料需修正 |

## 7. 验证记录

- 当前审核头定向测试：`conversation-mirror` 11 条、`plugin-runtime` 25 条、`record-admission` 12 条、`settings-migration` 5 条，共 **53/53 通过**。
- 当前审核头全量：**53 个测试文件、1007 条测试全部通过**。
- PR #29 目标 commit `66921a7`：**52 个测试文件、1002 条测试全部通过**。最初描述中的“1001”已过期；最终 commit 又增加了一条 unresolved-root 用例。
- `npm run typecheck`、`npm run lint`、`npm run check:docs`、`git diff --check` 均通过。
- 真实文件系统 symlink 注入：**2/2 复现** source 越界读取/准入。
- 首次受限环境中的全量测试出现 982 通过、25 失败；失败用例的子进程输出为空，复核确认是 `spawnSync ... EPERM` 一类环境假阴性。以允许子进程的只读复跑结果为准，项目测试本身全绿。

测试全绿说明现有实现与现有断言一致，不代表上述设计风险已被覆盖。尤其 deletion 测试使用了错误生命周期形状，symlink 与未来 schema 降写也不在正式测试集内。

## 8. 建议的最小收敛顺序

1. 暂停 PR #29；先与上游确定只读 projection/index 机制。没有这一前提，不建议继续给现有 mirror 打补丁后发布。
2. 独立修复 PR #27/#28 的 source containment 与 I/O 可观察性，并加入真实文件系统测试。
3. 将 PR #30 改成显式、逐版本 migration；决定旧 3000 的产品取舍，保护未来 schema，并把验收源文件纳入版本库。
4. 若仍要做跨设备展示，重新设计字段级投影，只输出展示所需字段，排除 input ledger、绝对路径、授权/执行上下文及未知字段。
5. 验收至少覆盖：full-vault transport 与 plugin provider 两种通道、tombstone-only 稳定删除、对端 rename/pin、并发 create/update/delete、开关跨设备传播与撤回、symlink/junction/hardlink、future schema。

**最终建议：保留 #27/#28/#30 的可独立修正部分，撤回或重做 #29。** 当前最大的风险不是某个缺少的条件判断，而是把“展示副本”放进了上游的正常可写 authority；在该前提不变时，局部加 hash、fence 或 CAS 都无法给出一致、可逆且不丢数据的跨设备语义。
