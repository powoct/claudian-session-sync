# 2026-08-29 · `claudian` provider 两机验收(七步,Mac ↔ Windows)

> 原始记录在验收机带回的 `tmp/acceptance/out_r5/`(两份 record + 双机 24 张快照),不入库。
> 剧本:验收套件的 claudian 附录;判定与闸门:[testing.md §9.7](../testing.md)。
> **跑法 B(独立测试 vault)**——这是 2026-08-28 评审改过的推荐,见下「跑法 B 是对的」。

## 判定:七步全过

| 步 | 内容 | 结果 |
|---|---|---|
| C1 | 启用 + dry-run 闸门 + `providerRoots.claudian` | ✅ 闸门 Notice 逐字抓到;`diff` 证明 replica **零写入** |
| C2 | A 推送记录(meta + inputs + CLI 会话) | ✅ 三行 `PUSH_NEW`,sha256 逐字一致 |
| C3 | B 落地 + Claudian 列表可见 | ✅(需重载 Obsidian,附录已预告) |
| **C4 ⭐** | **`remote-at-converged-base` 快进,不是 CONFLICT** | ✅ **唯一的硬阻塞项通过** |
| C5 | B 快进拉回 | ✅(reason 字符串被定时 pass 冲掉,以文件层 + 备份区为据) |
| C6 | 墓碑跨机 + ADR-10 | ✅ CLI 会话文件未被删;删除语义与文档不符见 F-4 |
| **C7** | 真分叉 → CONFLICT → 隔离 → 解决收敛 | ✅ **v2 通过**;v1 暴露 F-5 |

`opaque-divergent-both-moved` 双侧原文件**字节都没变**,两分支各自入隔离区,逐条解决后两台
`up to date`、冲突计数归零。报告的「Files left alone」还正确识别了 Dropbox 的冲突副本。

**跑法 B 是对的。** C2 一步没有出现 `opaque-divergent-no-base` 冲突——因为新 vault 没有历史
记录。评审当初把推荐从「真实 vault + 冻结 git」改成「独立测试 vault」,正是为了这个;
在真实 vault 上跑会在用户真实的对话记录上先冒出几十条冲突。

## ⭐ F-5:断网期间跑过 pass 时,Tier R 记录会被**快进覆盖**而不是判 CONFLICT

验收人把 C7 跑了两轮,这是这份记录最有价值的地方。

| | 断网期间是否跑 pass | 结果 |
|---|---|---|
| **C7-v1** | **跑**(等于默认配置:`autoIntervalMinutes = 5`) | claudian 记录**无 CONFLICT,B 的版本被 A 的快进覆盖**;同一轮里 claude-code 会话正确判 CONFLICT |
| C7-v2 | 不跑(附录原文要求) | ✅ `opaque-divergent-both-moved`,两侧原文件不变 |

**v1 才是现实路径,v2 是人为路径。** 真实用户断网期间一定会跑 pass——那是默认行为。

**机理(自洽,不是随机)**:B 在断网期间推过 BETA,这把 B 的**收敛基点更新成了 BETA**;
Dropbox 对账时主路径留 A 的 ALPHA、把 B 的改名成冲突副本;此后 B 看到「local == base
(我自上次推送没改过)、remote 变了」⇒ 按 §7.2b #4b `local-at-converged-base` 快进。
**引擎无从得知:remote 的这次「变化」其实是同步工具丢弃了 B 自己的推送。**

字节没丢(B 的备份区 + Dropbox 冲突副本各一份),但**用户不会想到去看**。

**这不是 claudian 特有的**:Grok 轮的 F-3 是同一个现象(`summary.json` 未判 CONFLICT)。
它是**所有 Tier R(整份重写)provider 的共性**,而且两次都在真机上出现过了。

问题出在「收敛基点」的定义上:ADR-48 说基点在「本机亲历的收敛事件(等量 NOOP / 任一落地)」
更新,而**一次落地的推送并不等于对端收到了**——尤其当中间隔着一个会回滚的同步工具。
可能的方向(都要设计,不在本批):

- **基点只在「实读两侧相等」的 NOOP 上更新,不在自己的写入上更新。** 最干净,但会让
  「推送后第一次改动」在没有中间 NOOP 轮时退化为冲突。
- **把同步工具的冲突副本当信号**:报告已经能识别它们(§8.2),信息本来就有——
  同一 `logicalId` 旁边存在冲突副本时,不快进,判冲突。针对性强,但依赖工具留下可识别的副本。

记为 **OQ-18**,建议作为下一个 slice。

## ⭐ F-1:一台机器只能持有一个 workspace binding,跑法 B 按字面走不通

在已有真实 binding 的机器上给测试 vault 建身份后,设置面板报
`The vault's workspace identity differs from the one this machine is bound to`,
Folder path 输入框 disabled,而且面板显示的是**另一个 workspace 的配置**。

**复核确认,是产品缺陷不是套件问题**:

- `PluginRuntime.boundWorkspaceId()` 返回 `listBoundWorkspaces()[0]` —— **按文件名排序的第一个**。
  真实 workspace `0412cc12…` 排在测试 `76380098…` 前面,于是被当成「本机绑定的那个」。
- `checkWorkspaceIdentity` 见 vault 身份 ≠ 该 id ⇒ 返回 `WORKSPACE_IDENTITY_CHANGED` 且
  **不带 `file`**;`refresh()` 的 `this.identity.file?.workspaceId ?? bound` 于是回落到 `bound`。

**根因更深**:`WorkspaceBinding` 里**没有 vault 路径**(`workspaceId` / `syncDirPath` /
`providers` / `createdAt`),所以「这个 binding 属于哪个 vault」今天根本无从判断。
多 vault 场景从未被设计过。修法要动 schema(binding 记 vault 路径,选择时按当前打开的 vault 匹配),
**不能顺手改**——`WORKSPACE_IDENTITY_CHANGED` 是 ADR-21 的 fail-closed 护栏,
放宽它要非常小心。记为 **OQ-19**。

无数据风险(护栏停了同步),但**任何同时用本插件管两个 vault 的用户都会撞上**。
本轮的规避是临时把真实 binding 移出 `workspaces/`,跑完原样移回(sha256 逐字核对)。

## F-3:冲突面板对 claudian 的条目认不出是哪个文件(**已修**)

C7-v2 在 B 侧产生 2 条冲突(meta + inputs),面板里两个标题**都是** `Session conv-178 (claudian)`。

**这是 2026-08-26 那次修复(ADR-55)的漏洞,同一个失败模式在另一个 provider 上重现。**
当时的判据是「文件名是否已含 logicalId」,而 claudian 的文件名恰好就是 `logicalId + ".json"`
⇒ 文件名被抑制;同时 `logicalIdPrefix` 取前 8 位 = `conv-178`,对 meta 与 inputs 完全相同——
**`conv-<epochMs>-<rand>.<kind>` 里说明「是哪个文件」的那一半在末尾,被截掉了。**

修法:**只对 uuid 形状的 id 做 8 位缩写**,其余原样显示。四个 provider 逐一验过,
三个措辞一字未变,claudian 变成 `Session conv-1787925819663-qj5gp9vhq.meta (claudian)`。
已注入验证(退回只用前缀 ⇒ 测试变红)。

## F-4:Claudian 的 Delete 会删掉 `meta.json`/`inputs.json`,插件随后把它们复活

架构文档与验收附录都写「删除是墓碑,`meta.json` **原地保留**」(ADR-47)。
**实测 Claudian 2.2.4 把 `meta.json` 与 `inputs.json` 一并删除,只留墓碑。**
下一轮 pass 里插件按 `remote-only` 判 `PULL_NEW`,**把两个文件从 replica 复活回 vault**。

净效果是「墓碑 + 复活的记录」共存;Claudian 以墓碑为准隐藏对话,**功能上没问题**,
复活行为也符合 ADR-10「插件从不删」的精神。但 ADR-47 对 Claudian 删除语义的描述**是错的**,
已按实测更正。

附带:Claudian 的行内垃圾桶图标是 **Archive**(只置 `isArchived: true`),
真正的 Delete 在 Archive 视图里右键——附录已补。

## F-2:Dropbox 在线占位文件让套件的快照直接中断(Windows)

`evidence.mjs snapshot` 对带 `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` 的占位文件报
`UNKNOWN: unknown error, open '…'`;PowerShell 的 `ReadAllBytes` 能读并触发水化,Node 的首次
`open` 不能。规避:拍快照前先水化整棵 sync 树。

⚠️ **这条值得单独跟进**:架构文档 §9.5 / OQ-4 说插件对按需占位符的判据是
`OFFLINE` + `RECALL_ON_DATA_ACCESS`,但**插件在这种文件上的实际行为本轮没有被测**——
被测的是套件。记为观察项。

## 一处必须拦下的结论

记录里写「Grok 轮记的 F-1(首次启用无强制 dry-run)**是误判**,闸门存在,建议回填上一份记录」。

**不能回填。核对过:那条发现是对的。**

- dry-run 闸门是 `bc83ffd`(PR #8)引入的,**2026-08-26 20:45 JST** 合入;
- Grok 验收用的构建是 `8e4295cc…`,那一轮的时间戳是**同日 08:31**——**闸门是在那次验收之后才有的**;
- 本轮看到闸门,是因为用的是 0.2.0(构建 `16e8b226…`),而 0.2.0 **包含**那次修复。

也就是说:**这一轮之所以能看到闸门,恰恰是因为上一轮报了它不存在。** 把 F-1 记成误判会
撤回一条正确的发现,并让 ADR-55 失去由来。验收人当时的判断没有错,只是本轮无从知道
两个构建之间隔着一次修复。

## 收尾

两台真实 binding 已原样归位(sha256 逐字核对),测试 workspace 的 binding 与 `state/` 已删。
测试 vault、测试 sync 目录(含隔离区与 Dropbox 冲突副本)、测试 workspace 的备份区**保留未删**,
供复现。
