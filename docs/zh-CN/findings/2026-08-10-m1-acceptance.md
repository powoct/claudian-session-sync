# 2026-08-10 · M1 十步真机验收（Mac ↔ Windows）

> 完整逐步记录（含真实路径与哈希）在验收机器的 `tmp/acceptance/out/`，不入库。
> 本文是回填文档用的脱敏摘要；路径中的用户名以 `<user>` 代替。
> 判定基准：[testing.md §9.4/§9.5](../testing.md)。两台记录的缺陷编号不同，
> 本文统一采用 macOS 记录的编号（D-1…D-6），Windows 记录的对应项在括号内注明。

## 环境

| 项 | 机器 A | 机器 B |
|---|---|---|
| OS | macOS 26.5.2 | Windows 11 (10.0.26200) |
| Claude Code | 2.1.226 | 2.1.226 |
| Obsidian | 1.12.7 | 1.13.4 |
| Claudian | 2.1.2（同机共存，ai-title 开启） | 2.1.2 |
| 同步工具 | Dropbox 264.4.3385 | Dropbox 264.4.3385 |
| vault 位置 | iCloud Drive 内 | OneDrive 内 |

两台 vault 分属不同网盘，**vault 内容并不互通**——workspace.json 由人工拷贝。

## 十步结果

| 步 | 结果 |
|---|---|
| 1 dry-run 零写入 | ✅（五树零变化；观察窗口需避开定时 pass，见 D-1） |
| 2 A 推送 | ✅ 字节级一致 |
| 3 B 落地 | ✅ 转义目录名与规则逐字一致（OQ-3 Windows 样本回填） |
| 4 **B 按 ID resume** | ✅ **M1 核心断言通过**：历史完整、可继续对话 |
| 5 B 续写推送 | ✅ 覆盖前备份正确 |
| 6 A 拉回 | ✅ PULL_OVERWRITE + 备份；拉回由后台定时 pass 完成 |
| 7 双向 2 轮 | ✅ 零 CONFLICT；一次计划外双边交错被前缀合并正确吸收（字节级验证） |
| 8 分叉 → 冲突 → 解决 | ⚠ 检出与隔离 ✅（3 文件、连续 3 轮不增殖、I1 成立）；**A 侧解决 ✅、B 侧解决被锁死（D-3，阻塞）** |
| 9 备份回滚 | ✅ 备份可被 CLI 直接加载 |
| 10 关闭期间追加被捕获 | ✅（首轮观察、次轮推送，见 D-6 裁决） |

**M1 Exit 判定（首轮）：不通过**（D-3 阻塞）。核心链路（落地 / resume / 续写 / 回滚 /
会话数据 I1 全程成立）全部成立。**→ 2026-08-11 步骤 8 复验通过后，M1 Exit 判定为
通过**（见文末复验章节；复验中发现的 R2-1 已修复并有回归覆盖，属可用性缺陷，
不构成 Exit 阻塞——两轮闭环即使带着它也走完了，且无任何数据丢失）。

## 缺陷与处置（处置落在 2026-08-11 批次）

| 编号 | 内容 | 处置 |
|---|---|---|
| **D-3（高，阻塞；Win 记录称 D-1）** | 非发起方机器上冲突解决被 stale 守卫永久拒绝（`branch-moved`），双机各写一对视角命名副本进同一共享隔离目录、读取端任取导致同一分支被同时当作两侧 | **已修**：隔离目录机器中立化 + 点击当下活文件判定视角（ADR-40）；回归用例覆盖 B 机场景与旧版 4 副本目录 |
| **D-1（中）** | 零变化的定时 pass 也重写 `.aiss/manifest.json`（updatedAt + 抽检 entry 的 generation 自增），Dropbox 由此制造 4 份 manifest「冲突副本」 | **已修**：entry 未变不改写、无变化不保存（ADR-41） |
| **D-2（低）** | 隔离区 meta.json 每轮同尺寸重写（detectedAt 重打） | **已修**：no-replace 写入，meta 字节稳定（ADR-40 附带） |
| **D-4（低；Win 记录称 D-2）** | 状态栏冲突计数取隔离目录数（解决后仍显示、对端目录到达翻倍），且文案叠加（`1 change, 1 conflict · 1 conflict`） | **已修**：计数取 pass 报告去重会话数、CONFLICT 不再计入 change、解决后自动补跑一轮（ADR-42） |
| **D-5（中）** | 备份轮转删除第 4 旧份后 index.jsonl 条目残留（磁盘 3 份、索引 4 条） | **轮转本身属设计**（仅删除可由幸存版本前缀重建的份，I1 保持）；**索引已补**：删除时追加 `{"event":"pruned", reproducibleFrom}` 日志行，索引语义明确为 journal 而非 inventory |
| **D-6（低；Win 记录称 D-4）** | 重启/恢复传输后的第一轮 pass 只观察不动作，剧本「启动即捕获」「恢复即冲突」两处期望顺延一轮 | **裁决：by design**（fail-safe 稳定窗口）；剧本措辞已放宽（AGENTS.md 步骤 8/10） |
| Win D-3（待裁决项） | evidence.mjs 把 `.aiss/manifest.json` 与隔离 meta.json 纳入 I1 判定，每次 check 必报 | **裁决：工具修正**——派生元数据不在 I1 保护范围（I1 保护会话字节）；工具已排除并计数提示。插件侧 D-1/D-2 修复后该噪声本身也基本消失 |
| **R-1（第三方风险）** | Claudian 的 ai-title 功能（默认开启，Haiku）向 session 文件追加 `{"type":"ai-title",…}` 记录，**包括冲突中的非活动会话**，实测两次 +236B 并直接催生第二个 conflictId | 与「local 只被 CLI 与本插件写」的隐含假设相抵触。前缀合并天然容忍单侧追加（步骤 7 已实证吸收一次）；对冲突会话的追加在 ADR-40 后不再锁死解决。**遗留**：README 须写明共存行为；是否对已知单行元数据类型做识别，留 M2 评估 |

## 回填的实测事实

- **OQ-3 转义样本（双平台回填 ✅）**：macOS `/Users/<user>/Library/Mobile Documents/iCloud~md~obsidian/Documents/<vault>` → `-Users-<user>-Library-Mobile-Documents-iCloud-md-obsidian-Documents-<vault>`；Windows 盘符与反斜杠同样逐字符转 `-`。每个非 `[A-Za-z0-9-]` 字符恰好一个 `-`，与实现逐字一致。
- **resume 只看不聊也会追加**（+530B/+1 行实测）：查看即写入，冻结式冲突快照必然过期——ADR-40 的直接依据之一。
- **Dropbox 对共享单文件的高频重写会制造「冲突副本」文件**：manifest 全程 4 份。非 ASCII 副本文件名被 `SEGMENT_CHARSET` 正确拒收，不会被误认为 session（§8.2 第 1 层起效）。
- **冲突检出与恢复传输之间有一轮 pass 的时间差**（观察轮语义，by design）。
- **一次分叉需要每台续写过的机器各确认一次**——已写进剧本与冲突弹窗文案。
- **Claudian 会话元数据（vault 内 `.claudian/sessions/`）人工拷贝到另一台后可完整恢复会话**（用户附加验证）——它不在本插件同步范围内（vault 分属不同网盘时也不随 vault 同步），是潜在的 M2 provider 候选，见 CLAUDE.md 边界讨论。

## 2026-08-11 · 步骤 8 复验（第二轮，改名迁移后）

> 原始记录在验收机器的 `tmp/acceptance/out_r2/`。范围：§3 P0 改名迁移 + 步骤 8 完整闭环 ×2 轮。

**结果：闭环通过。** 两轮分叉（各自让不同侧的分支抢到 canonical）均走完
「分叉 → CONFLICT 检出 → 双机各确认一次 → 三方 sha256 收敛」；D-3 原死锁场景
（B 的「Keep the other machine's version」，含本地分支被第三方追加过的变体）不再被
拒绝；D-1（manifest 静默）、D-2（quarantine meta 字节稳定）、D-4（计数与文案）回归
全部通过；迁移保留 machineId / workspaceId / rootId 与全部备份；旧命名隔离目录被
自动补写 `branch-*` 副本并可解决；跨目录同哈希副本不重复写（内容寻址去重）。
I1 在每对相邻快照间成立。

### R2-1（新缺陷，本轮修复）：解决点击可能被瞬时 I/O 打成无声空操作

现象：3 次「Keep the other machine's version」中 2 次（r8b 首次与 P0 旧冲突）没有任何
落盘效果，用户看到"正常"的 Notice 且状态栏随后显示 up to date；下一轮 pass 重新检出
同一分歧，第二次点击才收敛。

根因（快照取证，两条独立证据链一致）：

1. **失败点击是 resolve 的失败早退，不是写入丢失**——点击前后**五棵树逐字节零变化**
   （连 observations.json 都没动；而成功的 resolve 必带跑一轮 pass、必先落一份败方
   备份，成功样本中 backup 与覆盖相隔仅十几毫秒）。能在 backup 之前退出的只有
   unknown-conflict / branch-moved(kept 读取失败) / path-rejected 三类。
2. **成败与"隔离副本或 canonical 刚被写入多久"完全相关**：4 次点击里，凡目标文件
   在数分钟内刚被同步工具搬运/刚被本机 pass 写入的都失败，静置 ≥10 分钟的都成功
   ——指向同步工具对正在哈希/上传的文件的**瞬时锁**使 `readFile` 暂时失败。
3. 旧代码把这类瞬时失败说成**终态**：读不到隔离副本 → 条目消失 → `unknown-conflict`
   （文案居然是 "may already be resolved"，被合理地当成了成功）；读不到 kept 侧 →
   `branch-moved`（让用户去 re-sync 等一个不会来的修复）。同时 DEFER 轮（side-unstable
   观察窗口）不产生 CONFLICT 动作，报告计数归零，状态栏在分歧仍在时显示 up to date。

修复（ADR-44）：① resolve 的条目查找失败先立即重试一次；② kept 侧读不到 →
新失败原因 `kept-unreadable`，文案直说"文件忙，几秒后重试"；`unknown-conflict`
文案不再断言已解决；③ 冲突计数改为**粘性集合**——CONFLICT 加入、只有一手证据
（等量 NOOP / 覆盖落地 / 本机 resolve 成功）移除，DEFER 一律不动——观察窗口与失败
点击之后状态栏不再说谎。回归用例两条，均经注入验证会红。

### R2-2（裁决：按设计，无数据丢失）：备份轮转删除最老一份

r8b 收敛时 B 的第 4 份 local 侧备份触发轮转，最老的 53746B 版本被删。判定：**按设计**。
`planRotation` 只在被删版本是**最新幸存版本的字节前缀**时才删（删除时刻已做逐字节
验证）；本例 53746 ⊂ 53982 ⊂ 69314 ⊂ … ⊂ 94736，在 B 本机即可由 3 份幸存备份任一
重建。每方向每 session 保留 `backupKeep`（默认 3，设置可调 1–20）；复验记录中
"保留 4 份"是把 local/remote 两个方向合并计数所致。索引残留已由 pruned 日志行
（16e361f）解决。**结论：I1 不受影响，文档补一句说明即可**（testing.md 验收剧本
与 README 提及）。

## 与上一轮探测（2026-08-06）的关系

本轮未推翻 2026-08-06 的任何结论；OQ-8（append-only）在真实双机流量下持续成立
（步骤 7 的交错合并即字节级证据）。仍未决：OQ-7（规模性能）、OQ-10（漫游
profile），均属 M2。
