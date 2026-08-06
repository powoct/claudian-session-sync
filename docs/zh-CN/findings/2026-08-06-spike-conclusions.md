# Spike 结论汇总 · 2026-08-06 真机探测

> 来源：`tmp/probe-results/` 下的 macOS 与 Windows 两份探测报告（原件已归档为本目录的 [probe-macos](./2026-08-06-probe-macos.md) / [probe-windows](./2026-08-06-probe-windows.md)）。
> 环境：macOS 26.5.2 arm64 + Windows 11 26200 x64；Claude Code 2.1.223（跨版本实验覆盖 2.1.211 / 2.1.220）；Codex 0.146.0。
> 本文是 OQ 逐条判定与文档回填的映射，两份文档中所有 ✅ 标注以此为据。

## 逐条判定

| OQ | 判定 | 一句话结论 |
|---|---|---|
| **OQ-1** 跨平台 resume | ✅ **通过** | mac 产生的 jsonl 原样落到 Windows 转义目录，按 ID resume 历史完整、可续聊；`cwd`（POSIX 路径）只是元数据，无任何警告；续聊严格追加、行尾保持 LF、两台机器的 `cwd` 值在同一文件里共存。**`toNeutral`/`fromNeutral` 保持 identity。** |
| **OQ-2** Codex 发现机制 | ✅ **有结论** | 0.146.0 靠**扫目录**发现 session：只复制 rollout 文件（两个索引都不动），`codex resume --all` 立即可见、可 resume（两平台一致）。`session_index.jsonl` 是旧版残留（全程零写入）；无官方 import 命令但也不需要。rollout 本身严格 append-only（macOS 用 lifecycle 工具实证一轮）。**Codex 从"Tier B 候选"升级为 Tier A 候选**，M2 接入。 |
| **OQ-3** Windows 转义规则 | ✅ **通过** | 规则见下文"转义规则（实证版）"。`C:\Users\ct\vault` → `C--Users-ct-vault` 猜测被证实。**新事实：CLI 的输入是 realpath**（`/tmp`→`-private-tmp`；symlink 目录落 realpath 对应目录；Windows 大小写/正斜杠拼写被归一化）。 |
| **OQ-4** OneDrive 占位符 | ✅ **有结论** | 可靠判据 = 文件属性 **`OFFLINE`(0x1000) + `RECALL_ON_DATA_ACCESS`(0x400000)**；`REPARSE_POINT` **不可用**（OneDrive 常态位，水合后也在）。读占位符不报错，触发水合（4 KB ≈ 862 ms），`stat.size` 始终正确。 |
| **OQ-5** 未知扩展名容忍度 | ✅ **通过** | `.conflict` / `.bak` / `.jsonl.bak` / `.jsonl.tmp` / 0 字节 `.jsonl` / 非 uuid 名的 `.jsonl` 全部：不进列表、不报错、不被改动。**隔离副本与 staging 目录可以与原文件同目录。**（未测变体：uuid 形状文件名 + 他人内容——同步工具应避免这种命名，我们的命名规范已避开。） |
| **OQ-6** 其他 provider | 🟡 **部分** | OpenCode：纯 sqlite 存储 + **官方 `export`/`import` 命令**（未来走导入导出，不是文件搬运）。Grok：目录即会话（多文件，`summary.json` 整体重写）+ FTS 索引。Pi：单 jsonl、文件名 `<ts>_<uuid>.jsonl`、无索引、**转义规则与 Claude Code 不同**（`--` 包裹、空格保留）→ Tier A 候选。三者的生命周期均未验证。 |
| **OQ-7** 规模性能 | ⏳ 未做 | M2。 |
| **OQ-8** 生命周期 append-only | ✅ **PASS（无需任何降级）** | 两平台合计 36 个快照零前缀违规。**compact 是追加**（+27–31 KB 到同一文件，旧字节不动，UI 只显示摘要之后的内容）；**fork（Esc×2 回退分叉）是逻辑分叉、物理追加**（`logicalParentUuid` 指向历史节点，不产生新文件）；retry 是追加；`kill -9` 后末行完整（单样本）且 resume 正常；跨版本（±2 个版本）resume 严格追加、`version` 字段逐行混存。文件名恒等于 `sessionId`；末尾恒有 LF（36/36）；**空会话不落盘**（交互式打开后直接退出不产生任何文件 → CLI 自身永不产生 0 字节 jsonl）。 |
| **OQ-9** junction / 8.3 短名 | ✅ **通过** | `lstat().isSymbolicLink()` 对 junction（`mklink /J` 与 Node `symlink(…, "junction")` 两种）都返回 **true** → 架构 §9.7.4 的逐级 lstat 拦截覆盖 junction。`realpath` 展开 junction 为目标路径；但**不展开 8.3 短名**（`AISS-P~1` 原样返回）→ 字符串层的 `SHORTNAME_LIKE` 拒绝是唯一防线，必须保留。 |
| **OQ-10** 漫游 profile | ⏳ 未做 | M2。 |

## 转义规则（实证版）

```
escape(p) = for each char of realpath(p):  [A-Za-z0-9-] 原样保留，其余任何字符（含路径分隔符、
            盘符冒号、. 空格 _ ( ) 及每个非 ASCII 字符）→ 各替换为一个 "-"
```

- POSIX：前导 `/` → `-`，故目录名以 `-` 开头；`/Users/ct/vault` → `-Users-ct-vault`
- Windows：`C:` → `C-`，加上后随 `\` 即前缀 `C--`；`C:\Users\ct\vault` → `C--Users-ct-vault`；`D:\aiss-probe\plain` → `D--aiss-probe-plain`
- **输入是 realpath**：`/tmp/x` → `-private-tmp-x`（macOS `/tmp` 是 symlink）；在 symlink 目录里开会话**不产生新目录**，落进 realpath 对应目录；Windows 上全小写拼写 / 正斜杠拼写都归一化到磁盘上的真实大小写
- 大小写在字符层**保留**（`UPPER-Case` 原样）；归一化只发生在 realpath 这一步（按磁盘真实拼写）
- **不可逆**：`my.vault` / `my-vault` / `my vault` 撞名；`中文目录`（4 个汉字）→ `----`，不同的等长非 ASCII 名互相撞名。反转义只能做诊断——与架构 §6.3 的既有决策一致
- 无长度截断、无哈希后缀（样本范围内）
- UNC ⚠️ 未测（管理共享无权限）——UNC 路径下的 vault 在实测前按**不支持**处理（中立层本来就拒绝 UNC）

## 计划外的重要发现

| # | 发现 | 影响 |
|---|---|---|
| F-1 | **`claude --resume` 的 picker 只显示交互式来源的会话**（`entrypoint=cli`）；headless（`-p`，`sdk-cli`）创建的会话在任何列表视图都不出现，但 `--resume <sessionId>` 按 ID 完全正常 | 同步验证与用户引导必须用**按 ID resume**；"picker 里看不到" ≠ "文件没同步过来"。M1 验收剧本步骤 4 已改为按 ID |
| F-2 | resume 打开会话不发消息直接退出，macOS 上也会**追加**约 236 B 元信息行 | "只是打开看了一眼"也会改变文件——稳定性判定（签名变化→重新计时）天然覆盖，无需改设计 |
| F-3 | Windows 上 Node 经 `\\?\` 前缀**能创建** `CON`、`aux.txt`、尾随点/空格文件名 | 我们的 `RESERVED_NAME` / `TRAILING_DOT_OR_SPACE` 拒绝仍必须保留——Node 写得进去，但资源管理器与同步工具会坏 |
| F-4 | Windows 目录 fsync 返回 `EPERM` | `FsGateway` 的目录 fsync 必须在 win32 上跳过（架构文档原本已标 POSIX，实证确认） |
| F-5 | macOS rename 覆盖已打开文件后，旧句柄的写入进旧 inode、不进新文件（`oldHandleWritesVisibleInTarget=false`）；Windows 上对被自己打开的文件 rename 直接 `EPERM` | 逐字证实架构 §9.1.6 的风险模型与"Windows 反而更安全"的判断 |
| F-6 | mtime 粒度：macOS ≈ 40 µs、Windows(NTFS) ≈ 1 ms；APFS 规范化不敏感（NFC/NFD 同名），NTFS 规范化敏感（NFC/NFD 并存两个文件） | 证实 E0 签名必须含 tailHash、中立层必须 NFC+ASCII 的两条既有设计 |
| F-7 | 会话目录里会出现 `memory/` 子目录（2.1.223） | M1 的白名单只同步 `<uuid>.jsonl`，`memory/` 不被同步——记为已知限制，归属待查（OQ-8 Q7 未完全回答） |
| F-8 | 探测套件自身的脱敏遗漏：`oq3-snapshot.json` 与 `oq5-planted.json` 落盘未走 redact（两台机器的 agent 都发现并已手工处置交付件） | ✅ **已修复**（2026-08-06）：两路输出改为落盘前 redact；`oq5-clean` 经 `unred()` 反解后删除（兼容旧格式记录）；顺带补了短用户名（<3 字符）在转义目录名中不被替换的边界缺陷 |
| F-9 | 真实用户语料里存在 `retractedMessageUuids` / `supersedesUuids` 顶层 key（fork 实验文件中未出现），一个真实文件有 2/131 个 `parentUuid` 断点（sidechain/attachment） | 对 append-only 无影响（物理层仍是追加）；解析器不应假设 parentUuid 链无断点 |

## 回填清单（本次已完成）

- architecture.md：文档头 ✅ 口径、§6.1.1（Claude Code → Tier A ✅、Codex → Tier A 候选）、§6.3（转义规则实证 + realpath）、§6.4（Codex 扫目录发现）、§6.6（Codex group 修正）、§7.2（0 字节来源注记）、§7.4.1（Q3 LF ✅）、§9.1.6（F-5 ✅）、§9.5（OneDrive 判据）、§9.7.3/9.7.4（OQ-9 ✅、F-3）、§16 OQ 表
- testing.md：§5.1 样本表（全部 verified）、§9.4 步骤 4（按 ID resume）、§10 Spike 表（判定回填）、S-21 退役注记
