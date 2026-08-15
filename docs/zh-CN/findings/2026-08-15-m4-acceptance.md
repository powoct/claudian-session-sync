# 2026-08-15 · M4 验收增补(Codex 跨机 resume,Mac ↔ Windows)

> 完整原始记录(含真实路径与哈希)在验收机器的 `tmp/acceptance/out_r3/`,不入库。
> 本文是脱敏摘要。剧本:验收套件 AGENTS.md「M4 验收增补」附录(A/B/C 三项)。
> 插件 0.1.0(2026-08-14 构建);Codex CLI:A 机 0.147.0、B 机 0.146.0;
> 同步工具 Dropbox;两台 vault 的 `.claudian/` 经 git 互通。

## 判定总表

| 项 | 结果 |
|---|---|
| **A. Codex 跨机 resume** | ✅ **通过**——B 机 `codex exec resume <id>` 历史完整、可续聊(核心断言,与 M1 步骤 4 同构);双向回传、备份保护、三方 sha256 收敛全部成立 |
| B1. subagent 观察 | 已记录:主线程完整、缺 subagent 线程**不影响续聊**;subagent rollout 不准入符合预期 |
| B2. Claudian UI 入口观察 | 已记录:`.claudian/` 互通后 UI 列表可见、历史完整、**UI 续聊写进同一个 rollout** 并被正常推回 |
| C. maxFileSizeMB | ✅ 两侧 = 64(0.1.0 默认,无需手调);全程零 SKIP_TOO_LARGE(含 21 MiB 既有 rollout) |
| I1(两侧全程) | ✅ 成立(派生元数据按 Win D-3 裁决排除) |

**处置:Codex 的 experimental 标签已摘除**(本文对应 commit)。摘除标准 = 生命周期
探测(2026-08-13)+ 本轮跨机 resume 验收,两者缺一不可。

## A 项证据链(摘要)

A 机 Claudian 发起 Codex 对话 → `PUSH_NEW/APPLIED`,replica 出现
`codex/2026/08/15/rollout-…-<uuid>.jsonl`(67167B,sha 与本地逐字一致)→ Dropbox
送达,B 机落进 `~/.codex/sessions/2026/08/15/`(**日期层一致**)→ B 机
`codex exec resume <uuid> "continue"`:模型读入完整历史(40,976 tokens),回合持久化
14→27 records → B 推回(`PUSH_OVERWRITE`,覆盖前 remote 版自动备份)→ A 拉回
(`PULL_OVERWRITE`,A 的原版备份,与推送前逐字一致)→ 三方收敛。
B 随后**从 Claudian UI 续聊同一对话**,回合写进同一 rollout(27→39 records)并再次
推回——UI 与 CLI 同源同文件,链路完整。

## R3-1 · B 侧一次未复现的 DEFER 序列(归因已否证,机制未定)

**现场观察**:subagent 测试会话的主 rollout 到达 B 的 replica 后,连续 3 次手动
Sync 均 DEFER 不落地;操作者排查发现 B 的 vault 里还没有该会话的 Claudian 记录
(git 未同步),记录到达后第一次 Sync 即落地——**由此推断「拉动侧同样受记录准入约束」**。

**该归因不成立**,两级证据:

1. **快照取证**:replica 里该文件自 05:51:37 起**字节冻结**(79844B,同一 sha),
   横跨 DEFER 窗口的三张快照——DEFER 期间远端静止,也排除「对端持续推送导致
   side-unstable」的备选解释。
2. **全链路测试**(`tests/m1/codex-pull-unrecorded.test.ts`,真实 PluginRuntime +
   真实默认参数):「库里有记录但没有这条」与「连库都没有」两种状态下,replica 里的
   codex rollout 都在标准 settle(观察轮 + 行动轮)内落地。**拉动侧在设计、实现、
   组合根三层都不经过记录准入**——`classifyNeutral` 只校形状,这是 ADR-46/47 的
   有意决定(拉方可能永远没有记录,Obsidian Sync 不带点目录)。

**现场那几次 DEFER 的真实原因从归档产物无法定位**(pass report 未留存;套件快照的
local 树只覆盖 claude-code,见下方套件缺口)。与记录到达的时间相关性判定为巧合。
**若再现**:第一时间打开「Show last sync report」,记录该行的 Why 列(reason +
evidence 层级)——那是 R2-1 教训的直接应用,reason 字段比任何事后推断都准。

## 计划外发现与环境备注

- **套件缺口(下轮前修)**:验收套件 `config.json` 只快照 claude-code 的
  providerRoot,codex 本地树不在五树快照内——R3-1 无法做本地侧取证正是因此。
  下轮跑之前把 codex root 加进快照范围。
- **Codex CLI Windows 沙箱**(环境问题,与本插件无关):B 机工具调用报
  `codex-windows-sandbox-setup.exe program not found`,工具调用失败但会话恢复与
  续聊不受影响。两台机器宜补装 Codex 的 Windows 沙箱组件。
- **Dropbox manifest 冲突副本仍在累积**(本轮 +1,共 7 份):传输层噪音,插件
  `SEGMENT_CHARSET` 拒收正确(§8.2 第 1 层),延续 R2-3 观察。是否需要清理指引,
  留 README/FAQ 议题。
- B 机落地首个 rollout 前经历了两轮观察(D-6 语义,by design),第三次 Sync 落地
  ——与重装插件(0.0.1→0.1.0)后的首轮观察语义一致。

## 对既有结论的影响

- **M4 的验收半边完成**:Codex 核心断言通过,experimental 摘除。M4 剩余为发布
  动作(仓库转 public、LICENSE、打 tag),均为用户操作。
- OQ-12 的推论获得实证:`.claudian/` 互通(git)时,对端 Claudian UI 完整可用;
  UI 续聊与 CLI resume 写同一文件。
- subagent 缺失的实际影响首次实测:**结论已回传主线程,不影响续聊**——
  「不同步 subagent rollout」由观察项转为已确认的可接受行为(README 不需警告)。
