# 2026-09-10 · Codex 新格式单机验收(G0–G4,macOS)

> 原始记录在 `tmp/acceptance/out_r9/`(record + config + 终态快照),不入库。
> 剧本:验收套件的「Codex 的新格式」附录;修复见 ADR-73。
> 被测构建 `main.js` sha256 `f891de1b…` / 275,435 B。**单机完成**。

## 判定:G1–G4 全过

| 步 | 内容 | 结果 |
|---|---|---|
| G0 | 基线 | ✅ 带 `_` 的文件 0 个;`in BOTH layers` = none |
| **G1** | 造一条 rewind 过的会话 | ✅(改走 app-server,见偏离 1) |
| **G2 ⭐** | 带 `_` 的文件要能同步 | ✅ **闸门通过** |
| **G3 ⭐** | 不认识的文件要出声 | ✅ **闸门通过** |
| G4 | 别的东西没被吵到 | ✅ |

## G1/G2:两个文件,一个线程

| | 字节 / 行 | sha256 前 8 |
|---|---|---|
| rewind **前** `…-01a08b1b-….jsonl` | 100,042 / 37 | `b9bc80cc` |
| rewind **后** `…-01a08b1b-…_01a08b1d-….jsonl` | 55,064 / 17 | `737790e5` |

**两个都在** —— codex 不删旧的,与 `revert_thread.rs` 的「Old rollouts stay intact」一致。
threadId 前 8 位 `01a08b1b` 与 rollout id 前 8 位 `01a08b1d` **不同**,正是 ADR-73 要分开的两个 id。

**快照独立复核**:`local:codex` 与 `replica` 两侧各有这两个文件,四个 sha256 两两配对相同。
0.3.2 下带 `_` 的那个根本不会进候选集,replica 里会只有一个。

## G3:通知逐字

> Codex's sessions folder has 1 file(s) this version **does not recognise** and will not sync
> (rollout-2026-09-10T00-00-00-notarealid.jsonl). If Codex has been updated, this plugin probably
> needs to catch up — the conversations in them **are not travelling**.

删掉探针文件后再同步,**整节消失**。写的是「1 file(s)」——
说明本机原本没有插件不认识的 codex 文件,普查没有误报。

## ⚠️ 「报告里没有那一行」:不是缺陷,是查找方法不成立

验收人如实记了「未捕捉」,并怀疑报告对 `NOOP` 有省略。**查证后两者都不是**:

- `report-modal.ts` 的 Files 表**遍历 `report.actions` 全量、不截断**;
- 引擎的每一条路径(DEFER / 预算 / 不支持的 mode / 正常动作)**都会 push 一行**;
- **而 `actions` 从未被排序** —— `sync-engine.ts:909` 原样传出,渲染按目录遍历顺序。

验收人是按「Session 列升序」去找的,看到 `01a08142` 之后直接是 `04995d0e` 就判定不存在。
**那个顺序并不存在**,所以这个推断不成立;189 行里那一行多半就在别处。

**但这是第二次有人在报告里找不到该找的行**(2026-09-01 那轮丢的是被自动 pass 冲掉的行)。
表格无序 + 上百行,本身就是个可用性问题。已记 **OQ-33**。

## 套件要改的四条(验收人提出,均已改)

1. **G1 第 1 步必须说「在 Claudian 里新建对话」。** 验收人先用 `codex exec` 在 vault 目录起会话,
   G2 一个文件都同步不了 —— 因为 ADR-47 的准入读的是 **Claudian 的对话记录**,
   `codex exec` 起的会话没有记录。**插件拒绝同步是正确行为**,但附录的先决条件
   (「codex CLI 在这个 vault 目录下用过至少一次」)不足以让会话可测,白费一轮。
2. **补上非交互的 revert 路径。** 附录原写「只能在 TUI 里 Esc-Esc」,验收人从源码找到了
   同一个底层操作的 JSON-RPC 入口:`codex app-server` 的 **`thread/revert`**
   (`with_rollout_id` 的唯一生产调用者就是 `revert_thread.rs`)。
   顺序是 `initialize` → `thread/resume` → `thread/revert`,**G1 因此可脚本化、可复现**。
3. **`thread/turns/list` 必须先 `thread/resume`**,否则返回 0 条。
4. **Claudian 开着该会话时 revert 会被拒**(`already has an active writer`),需先退出 Obsidian。

## 未测的

- 真正的 TUI Esc-Esc 路径未走(本会话无法驱动全屏 TUI)。走的是同一个 `revert_thread`,
  产出形态一致,但「TUI 里那个按键确实触发它」这一点**未经实测**。
- `.jsonl.zst` 压缩(OQ-31)仍未生效,未测。
