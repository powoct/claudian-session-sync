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

**M1 Exit 判定：不通过**（D-3 阻塞）。核心链路（落地 / resume / 续写 / 回滚 /
会话数据 I1 全程成立）全部成立。

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

## 与上一轮探测（2026-08-06）的关系

本轮未推翻 2026-08-06 的任何结论；OQ-8（append-only）在真实双机流量下持续成立
（步骤 7 的交错合并即字节级证据）。仍未决：OQ-7（规模性能）、OQ-10（漫游
profile），均属 M2。
