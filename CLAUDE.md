# Claudian Session Sync — Obsidian 插件

> **本文的定位**：产品目标、边界、协作约定——这些**不随实现变化**的东西。
> **技术方案不在本文**：当前实现规范是 [docs/zh-CN/architecture.md](docs/zh-CN/architecture.md)，测试与验收是 [docs/zh-CN/testing.md](docs/zh-CN/testing.md)。
> 凡涉及"怎么做"的判断（合并规则、冲突处理、写入安全、路径映射、provider 分级……）**一律以架构文档为准**，本文不复述。启动期草稿里已被取代的条款，逐条记在架构文档的[附录 A](docs/zh-CN/architecture.md)。

## 项目目标

一个 **desktop-only** 的 Obsidian 插件，在多台电脑（含 Mac ↔ Windows 跨平台）之间同步 AI agent CLI 的对话 session 原始文件（jsonl 等），使用户能在另一台机器上 resume 同一 session 继续对话。

命名（2026-08-11 定）：**Claudian Session Sync**。适配范围以 Claudian（fork: YishenTu/claudian）支持的 agent CLI 为准（Claude Code、Codex、Grok、OpenCode、Pi），**不额外适配、不保证兼容其它 agent CLI**；README 需写明本插件与 Claudian 无隶属关系（除非其作者另行接纳），且同步对象**默认不含** vault 内 `.claudian/sessions`（见下"与 Claudian 的界限"）。

一句话：**把 agent CLI 的 session 存储在多机之间做"带语义的搬运工"**——不理解对话内容，只理解 session 文件的追加式结构和机器相关的落位规则。

## 不做的事（产品边界，长期有效）

- ❌ 不把 session markdown 化、不往 vault 里塞笔记（区别于 Claude Code Sync 类插件）
- ❌ 不做网盘 OAuth 直连（Drive / Dropbox API）——只支持"指定本地同步目录"，用户自行把它指到网盘客户端目录或 Syncthing 目录，天然兼容一切同步工具
- ❌ 不提供强一致的并发写保证。两台机器同时写同一 session 是架构性限制，只做检测、隔离、告警与可恢复兜底（精确的保证与不保证清单见架构文档 §9.4.3）
- ❌ 不同步 CLI 的凭证与配置
- ❌ M1–M2 不做删除传播
- ❌ 不**默认**同步 vault 内的 `.claudian/sessions/`（Claudian 自身的会话元数据）。它是改写型 JSON，不满足 append-only 前提——M3 起以**默认关闭**的独立 provider 提供（opaque 合并模式，架构文档 ADR-48），仅供 vault 同步带不动 `.claudian/` 的用户（如 Obsidian Sync）启用；其余用户开启即双传输，设置文案有警告

## 支持的 provider

用户使用 Claudian 插件（fork: YishenTu/claudian），它支持多个 agent CLI。各 provider 的存储结构、Tier 归属与当前状态**见架构文档 §6**，本文只记一条不变的要求：

> provider 抽象成接口 + 配置驱动的路径映射，每个 provider 一个 adapter；用户可在设置里启用/禁用单个 provider，也可手动覆盖路径（应对版本变化和非标准安装）。**Tier 归属必须有实测证据，未验证一律只读。**

## Obsidian 插件约束

- `manifest.json` 中 `isDesktopOnly: true`（依赖 Node `fs`/`os`/`path`）
- 通过 `require("fs")` 等使用 Node API（Electron 环境）；vault 外路径合法可访问
- 构建：esbuild 打包为 `main.js`，标准 Obsidian 插件模板（TypeScript）
- 分发：先 BRAT，不急于进官方市场

## 里程碑

M0 脚手架 → M1 Claude Code 单 provider 跑通 Mac ↔ Windows resume → M2 provider 抽象 + Codex/OpenCode → M3 冲突与备份 UI → M4 README 与 BRAT 发布。

各里程碑的交付内容见架构文档 §15，**Exit Criteria 见测试文档 §9.5**。

## 待验证的事实（真机 Spike）

未决问题清单 OQ-1…OQ-10 见架构文档 §16。**2026-08-06 的 macOS/Windows 真机探测已回答全部 M1 阻塞项**（含 OQ-8 append-only：PASS），逐条判定见 `docs/zh-CN/findings/`；仍未决的只剩 OQ-7（规模性能）与 OQ-10（漫游 profile），均属 M2。

**对仍标 ⚠️ 的假设，依赖它的代码路径必须保持只读或 dry-run，直到实测回填 ✅。**

## 与 Claudian 的界限

Claudian 在 vault 内存的 `.claude/`（或 `.claudian/`，因版本而异）元数据**随 vault 自身的同步走**，本插件不管它——但 README 要提醒用户别把它排除在 vault 同步之外。

Windows 上 Claudian 对 CLI 路径的检测问题（`.cmd` wrapper）与本插件无关，用户排查时容易混淆，README 里要写清界限。

## 协作约定

- 沟通语言：中文；**代码、注释、commit message 用英文**
- 开发者主力机：MacBook Pro（macOS）+ Windows 机器；开发在 Linux remote-ssh 环境进行
- 熟悉 TypeScript/Node、Docker、VPS 运维，可直接给技术方案，不需过度解释
- **文档去处**：产品边界与协作约定写本文；技术决策写 architecture.md（含 ADR 表）；测试与验收写 testing.md；实测结论回填到对应文档并把 ⚠️ 改成 ✅。**不要在本文复述技术决策**——两处并存必然漂移，而本文会被 agent 自动注入、优先级最高，写错的代价最大
