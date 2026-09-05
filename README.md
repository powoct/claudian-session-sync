# Claudian Session Sync

Sync the **raw session files** of [Claudian](https://github.com/YishenTu/claudian)-supported
agent CLIs between your computers, so a conversation you started on one machine can be
**resumed** on another — same session ID, full history, mid-thought.

An [Obsidian](https://obsidian.md) plugin. **Desktop only** (it reads and writes CLI
storage on your disk). Currently in **beta**, distributed via
[BRAT](https://github.com/TfTHacker/obsidian42-brat).

> **Not affiliated with Claudian.** This is an independent companion plugin for users of
> the Claudian plugin (YishenTu/claudian). It is not made by, endorsed by, or part
> of that project.

## What it does

- Watches the session storage of the agent CLIs Claudian drives (see the provider table),
  and mirrors those files into a **local sync folder you choose** — point it at a folder
  inside Dropbox, OneDrive, Google Drive, Syncthing, anything that syncs a directory.
  The plugin itself never talks to any cloud API and needs no account.
- On your other machine, the same plugin pulls those files into that machine's CLI
  storage, where the CLI finds them by its own normal discovery. `claude --resume <id>`
  or `codex resume <id>` then continues the conversation.
- Merging is **append-only and prefix-safe**: a file is only ever fast-forwarded to a
  version that provably contains it byte-for-byte. Timestamps are never trusted. If two
  machines extended the same session separately, that is a **conflict** — both versions
  are kept and you choose (see below). Nothing is silently overwritten, ever.

### Which conversations are synced

Only conversations **this vault's Claudian knows about**: the plugin reads the
conversation records Claudian keeps inside the vault (`.claudian/sessions/`) and syncs
exactly those sessions. A session you started with a bare `claude` or `codex` in a
terminal has no Claudian record and is not synced. Conversations you deleted in Claudian
stop syncing. Old records that carry no session ID (conversations from older Claudian
versions, or ones that never got a first reply) cannot be matched to a CLI file and are
skipped — continuing that conversation in Claudian once usually fixes this.

### What is never synced

| | Why |
|---|---|
| Credentials & CLI config (`auth.json`, `config.toml`, `.credentials.json`…) | Never read, never copied |
| Any SQLite database (`*.sqlite`, `-wal`, `-shm`) | Machine-local, absolute paths inside |
| `.claudian/` inside your vault | Not by default — it travels with your **vault's own** sync. An opt-in provider exists for setups whose vault sync cannot carry it; see the warning below |
| Files the plugin doesn't recognise | Conflict copies from sync tools, backups, anything foreign: reported, left exactly where they are, never touched |
| Deletions | Deleting a session on one machine never deletes it elsewhere |

## Provider support

Support is **evidence-tiered**: a provider only gets write access after its CLI's on-disk
lifecycle has been measured (strict append-only across new / resume / compact / fork /
kill) on real machines.

| Provider | Status | Notes |
|---|---|---|
| **Claude Code** | ✅ Supported | Lifecycle measured on macOS + Windows; cross-machine resume verified in a two-machine acceptance run |
| **Codex** | ✅ Supported | Lifecycle measured on macOS + Windows incl. compact; cross-machine resume verified in a two-machine acceptance run (2026-08-15) |
| **Claudian records** | ✅ Optional, off by default | Claudian's own conversation records (`.claudian/sessions/`), whole-file synced with converged-base fast-forward — for vaults whose own sync cannot carry dotfolders |
| **OpenCode** | ❌ Cannot be supported | Its history lives entirely inside one SQLite database; there is no per-session file to carry and no official export. This is structural, not a missing feature |
| **Grok** | ✅ Supported, off by default | Lifecycle measured on macOS + Windows (2026-08-24); cross-machine resume verified in a two-machine acceptance run in both directions (2026-08-26). A Grok session is a *folder* whose files disagree about how they are written — the history is appended, the record that makes the session visible is rewritten whole — so they are carried under different rules, and the files the CLI rebuilds are left where they are |
| **Pi** | ⏳ Planned | Not yet measured |

Every provider is **off by default**. Enabling one for the first time runs a dry run
immediately — it writes nothing at all — so you can open **Show last sync report** and see
exactly which of your existing conversations would start travelling before any of them does.
That set is usually larger than the one you have in mind: it is every conversation this vault
has a Claudian record for, not just today's.

## Install (BRAT)

1. Install **BRAT** from Obsidian's community plugins.
2. BRAT settings → *Add Beta Plugin* → `powoct/claudian-session-sync`.
3. Enable **Claudian Session Sync** in *Community plugins*.
4. Repeat on your other machine(s).

## Setup

On each machine:

1. **Sync folder** — in the plugin settings, point *Sync folder* at a local directory
   that your file-sync tool replicates (e.g. `~/Dropbox/agent-sessions`). Use the same
   folder (as seen by each machine) everywhere.
2. **Initialise** — the first machine initialises the folder with one click; the others
   join it. An empty-looking folder is never written to without that explicit step, so a
   half-downloaded folder can't be mistaken for a fresh one.
3. **Workspace identity** — created inside the vault (`.claudian-session-sync/`) and
   shared through your vault sync; if your vaults don't sync to each other, copy that one
   small folder across once (or set the ID by hand).
4. **Enable providers** — toggle the CLIs you actually use. First enable = forced dry run.
5. Sync runs on an interval (default 5 min) and on demand from the status bar.

### Resuming on the other machine

- **CLI**: `claude --resume <session-id>` / `codex resume <session-id>` works as soon as
  a sync pass has landed the file. The session may not appear in interactive pickers
  (they can filter by origin) — resuming **by ID** always works.
- **Claudian's UI**: Claudian lists conversations from its records in
  `.claudian/sessions/` inside the vault. Those records travel with your **vault's**
  sync, not with this plugin — see the next section.

> **There is a setting for this.** *Share this device's conversations with your other
> devices* (off by default, and set per machine) **moves** each of this machine's
> conversation records into the layer every device reads. All of them then list the
> conversation, and all of them write to the same record. Three things to know before
> turning it on. Claudian decides where to save a conversation **once per session**, so
> after a move it keeps writing a copy in this device's folder until you next restart
> Obsidian; each sync folds that copy forward into the shared one, and where it cannot tell
> which version should win it keeps both and asks you — the command **Repair shared
> conversation records** lists those with both sizes and dates, one at a time. Turning the
> setting back off stops further moves but **does not un-share what has already moved**.
> And a shared conversation carries
> any folders it had been given access to as absolute paths, which on the other machine may
> point at something else — the same exposure every conversation had before Claudian 2.2.5,
> when all records lived in that layer.
>
> **Claudian 2.2.5 and later: the conversation may not be *listed* on the other machine,
> even though resuming works.** From 2.2.5 each new conversation's record is filed under
> the device that created it (`.claudian/sessions/devices/device-<hash>/`), and Claudian's
> list is device-scoped — a record belonging to another device is not shown. This plugin
> still carries the session file, so `claude --resume <id>` / `codex resume <id>` work
> normally; what is missing is the entry in Claudian's sidebar. The **Assign to this
> device** button does not help here: it promotes a record from the *top level*, not from
> another device's folder. Moving (or copying) that one `conv-*.meta.json` up to
> `.claudian/sessions/` makes the conversation listed and assignable again.

## ⚠️ Keep `.claudian/` in your vault sync

Claudian's conversation list lives in `<vault>/.claudian/`. This plugin deliberately does
**not** sync it (it is rewrite-style data with machine-local paths inside; carrying it
safely is planned work). So:

- If you sync your vault with **git / Syncthing / a cloud-drive folder**: make sure
  `.claudian/` is **not excluded**. Then both halves arrive — records via your vault
  sync, session files via this plugin — and conversations appear in Claudian's UI on
  both machines.
- **Obsidian Sync** users: note that Obsidian Sync
  [excludes hidden folders](https://help.obsidian.md/sync/settings) other than
  `.obsidian`, so it will **not** carry `.claudian/`. For exactly this case the plugin
  ships an optional **Claudian records** provider (off by default): enable it on both
  machines and the records travel through the sync folder instead — identical files are
  left alone, a one-sided change fast-forwards (with a backup), and anything else becomes
  a conflict for you to settle. Do **not** enable it if your vault sync already carries
  `.claudian/` — two transports over one folder feed your sync tool conflicts.

## How your data is protected

- **Backups before every overwrite.** Any file about to be replaced — on either side —
  is backed up first (default: 3 versions per file per direction, configurable). No
  backup, no overwrite. *Restore an earlier version* (command palette) lists what was
  kept and puts one back — and says, before you click, whether the next sync will undo
  it, propagate it to your other machines, or raise a conflict for you to settle.
- **Verified writes.** Overwrites re-check the target immediately before renaming the
  new version into place; anything that moved gets re-planned instead of written.
- **Conflicts keep both versions.** A genuine fork is detected by content, quarantined
  (both branches, content-addressed, shared by both machines), and surfaced with three
  choices: keep this machine's version, keep the other's, or open the folder and look.
  Each machine that extended the session confirms once. The losing branch stays in
  quarantine *and* in backups.
- **Unknown files are never touched.** Sync-tool conflict copies and other foreign files
  are recognised, reported ("Files left alone"), and never moved, renamed or deleted —
  moving one would make your sync tool propagate a deletion to every machine.
- **Stability gating.** Files still being written (by the CLI or by your sync tool) are
  observed, not copied; a pass acts only on files that have provably held still.

### What it touches on your disk, and why the store review says what it says

The community listing's automated review flags two things about this plugin. Both are
accurate readings of the code, and both are worth explaining rather than explaining away.

**"Direct filesystem access — can read and write any file on the system."** True, and
unavoidable: the files this plugin exists to sync are your CLIs' session files, which live
in `~/.claude`, `~/.codex`, `~/.grok` — *outside* the vault, where Obsidian's vault API
cannot reach. That is also why the manifest says `isDesktopOnly: true`. What it actually
touches is a short list:

| | |
|---|---|
| **Reads** | the session files of the providers *you* switch on (all off by default), and Claudian's conversation records inside your vault |
| **Writes** | your sync folder, those same session files when pulling a conversation from another machine, and its own state under `~/.claudian-session-sync` |
| **Never** | anything else. Every path is resolved segment by segment and rejected if it escapes a known root or passes through a symlink; files it does not recognise are reported and left alone; credentials (`auth.json`, `config.toml`, `.credentials.json`) are excluded by name and never read |

**"Persists data in localStorage instead of the Obsidian plugin data APIs."** This one is a
false positive, and the distinction matters. This plugin's own settings go through
`loadData()`/`saveData()` — the plugin data API, as expected. It **reads** exactly one
`localStorage` key, `claudian.deviceSettingsKey`, which belongs to Claudian: from 2.2.5
Claudian files each conversation's record under a folder named for a hash of that seed, so
deriving the same hash is the only way to know which of those folders is this machine's.
It is read, never written, used only to name a folder inside your own vault, and never sent
anywhere. `main.ts` marks the call site with the same explanation.

### Honest limitations

- Two machines writing the **same session at the same time** is detected and contained
  (conflict, both versions kept), not prevented — this is a file-sync architecture, not
  a real-time collaboration protocol.
- Files larger than *Max file size* (default 64 MB) are skipped and reported.
- The CLIs themselves append metadata to session files — Claude Code, for instance,
  appends title records even when you merely *open* a session. That is normal, absorbed
  by the merge, and not this plugin (or Claudian) writing to your files.
- If your vault lives behind a **symlink**, note that Claude Code derives its project
  directory from the *resolved* path; if the resolved paths differ between machines, set
  the directory override in the provider's settings.
- Windows: if Claudian itself can't find a CLI (`.cmd` wrapper detection), that is a
  Claudian issue unrelated to this plugin — sessions sync regardless of how the CLI is
  launched.

## Development

```bash
npm ci
npm run verify   # typecheck, lint, secret/docs gates, ~1000 tests, build, bundle checks
```

Design documents (Chinese): [architecture](docs/zh-CN/architecture.md) ·
[testing & acceptance](docs/zh-CN/testing.md) · [measured findings](docs/zh-CN/findings/).
Every behavioural claim above traces to a decision record (ADR 1–67) and, where it
matters, to a real-machine measurement.

## License

[MIT](LICENSE)

---

## 简体中文摘要

在多台电脑之间同步 AI agent CLI(Claude Code、Codex 等)的**原始会话文件**,让你在
A 机器上的对话能在 B 机器上 `resume` 继续。桌面端专用;不接任何网盘 API,只认你指定
的本地同步文件夹(Dropbox / OneDrive / Syncthing 均可)。

- **只同步本 vault 的 Claudian 有记录的会话**;纯终端起的会话、已在 Claudian 里删除
  的会话、没有 session id 的旧记录,都不同步。
- **合并只做前缀快进**,从不信时间戳;双机分叉 = 冲突,两个版本都保留,由你选择。
  覆盖前必备份;不认识的文件永远原地不动;不传播删除。
- **请勿把 `.claudian/` 排除在你的 vault 同步之外**——Claudian 的会话列表靠它;
  注意 Obsidian 官方同步不带隐藏文件夹(`.obsidian` 除外)。
- **Grok 已通过两机验收**(2026-08-26,双向),同步的是会话本体(记录 + 历史),其余文件由
  对端 CLI 自行重建;和所有 provider 一样**默认关闭**,首次打开会先跑一轮 dry-run 让你先看
  范围——**那一轮什么都不写**。
- 本插件与 Claudian 项目**无隶属关系**。

设置与安全细节见上文英文说明;设计文档在 [docs/zh-CN/](docs/zh-CN/)。
