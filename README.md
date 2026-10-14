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
terminal has no Claudian record and is not synced. A conversation you delete in Claudian
stops being *admitted*: no new session of it is uploaded from this machine. A session file
already in the sync folder keeps converging both ways — including anything you add to it
here from a terminal — because deletions are never propagated (see also
[Claudian 2.3.3](#claudian-233-and-later)).
Old records that carry no session ID (conversations from older Claudian
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
- **Wait for the history before you send.** If you send in a Claude conversation whose
  session file has not reached this machine yet, the CLI cannot find the session and
  Claudian then removes the conversation — or, when part of its history is here, carries on
  without the missing part. For a shared conversation that change is made to the shared
  record, so it reaches your other devices with your vault sync. After every sync the
  plugin looks for exactly that: a conversation Claudian lists here whose current session
  file is in the sync folder but not on this machine is named in the sync report. A pop-up
  names it by title on the first sync after Obsidian starts, or once it is still waiting a
  sync later — a conversation that arrives while Obsidian is running is not in Claudian's
  list until the next launch, and its history usually lands a sync later anyway. Wait for
  the sync that brings it. It is likeliest on a device's first syncs, or for a session file
  over *Maximum file size* (which travels with the vault, so this only happens when the limit
  was lowered after the file was copied, or your devices keep different limits). Opening
  the conversation is harmless, though it can look empty until the history arrives. If your
  vault sync carries `.obsidian/workspace.json`, Claudian may reopen such a conversation's
  tab at launch. The check needs the Claude Code provider on, and it looks for the session
  file where that provider is set to look — a `CLAUDE_CONFIG_DIR` set only for Claudian is
  not seen.

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
> Claudian's **Assign to this device is not supported while it is on** — with Claudian
> 2.3.3 or later on any of your devices, the next sync moves the conversation back into the
> shared layer, or, for one this device shared itself, holds it and lists it under **Repair
> shared conversation records**. To keep a conversation on one device, turn the setting off **and leave it
> off**: turning it back on shares it again. (If any of your machines still runs Claudian
> 2.2.6 or earlier, a shared conversation also carries the folders it had been given access
> to as absolute paths, which on the other machine may point at something else; Claudian
> 2.2.7 removed that feature.)
>
> **Claudian 2.2.5 and later: the conversation may not be *listed* on the other machine,
> even though resuming works.** From 2.2.5 each new conversation's record is filed under
> the device that created it (`.claudian/sessions/devices/device-<hash>/`), and Claudian's
> list is device-scoped — a record belonging to another device is not shown. This plugin
> still carries the session file, so `claude --resume <id>` / `codex resume <id>` work
> normally; what is missing is the entry in Claudian's sidebar. The **Assign to this
> device** button does not help here: it promotes a record from the *top level*, not from
> another device's folder. Moving that one `conv-*.meta.json` up to
> `.claudian/sessions/` makes the conversation listed and assignable again. Move it, do not
> copy it, and do it while Obsidian is closed on the machine that created the conversation
> (or restart Obsidian there before using it again): Claudian keeps writing to whichever
> copy it loaded at startup, and deleting the conversation there removes only that copy.

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

### Claudian 2.3.3 and later

Claudian 2.3.3 changed how it deletes a conversation: it now removes the record and
leaves no deletion marker, and *Assign to this device* no longer leaves an assignment
marker either. **The default setup is not affected**: a deleted conversation's record is
gone, so this machine stops admitting its sessions, and what is already in the sync folder
keeps converging as described above.

- **Claudian records** provider (off by default): a conversation you delete on this device
  **stays deleted here**. The plugin remembers which records this device has held, and
  does not restore one that is now missing — not when another device pushes it again, and
  not when you point the plugin at a new sync folder. The sync report lists it as
  `deleted-here`, and the command **Bring back conversations deleted on this device**
  undoes it. Your other devices keep the conversation, and a device that has not received
  it yet still will — deletions are never propagated. One exception: a Claude conversation
  whose history is in the sync folder but has not reached this machine yet may have been
  removed by Claudian itself (it does that when asked to resume a session it cannot find),
  so the plugin restores it once and says so; if you deleted it, delete it again and it
  stays deleted. This needs the Claude Code provider on. A conversation whose history is
  nowhere — Claude Code purges old transcripts after thirty days — simply stays deleted.
  Records an older version of this plugin had already restored after you deleted them
  cannot be told apart from ones you want — delete those once more. For the best result,
  update this plugin and let it sync once **before** the first launch of Claudian 2.3.3 or
  later on a device; most devices have already passed that point, and for them the
  one-more-delete above is the whole cost.
- **Share this device's conversations** (off by default): a conversation you delete can
  come back after a restart if it was started in that Obsidian session or used shortly
  before Obsidian was last closed; deleting it again removes it. One that another device
  deleted or assigned to itself after this device shared it is no longer shared again;
  if this device still holds a copy of its own (it was shared in the current Obsidian
  session), that copy is listed under **Repair shared conversation records**. This starts as soon as
  **any** device syncing the vault runs Claudian 2.3.3, so upgrade all of them together, or
  turn sharing off on the ones you have not upgraded yet. From Claudian 2.3.12, a
  conversation in the shared layer cannot be mentioned with `@` in another conversation.

When this plugin detects Claudian 2.3.3 or later *on the same device* with sharing on, it
says so in its settings, at the top of every sync report, and once per launch. A device
still running an older Claudian cannot tell that another one has upgraded, so it stays
silent. The version is read from Claudian's `manifest.json`; Obsidian Sync carries that
file but not Claudian itself (it is over Obsidian Sync's size limit), so update Claudian on
every device and the two will agree.

Later Claudian releases changed three more things worth knowing:

- **2.3.6** no longer reads the old `.claude/sessions` folder. A conversation recorded only
  there no longer appears in Claudian; its session file still syncs and resumes from a
  terminal.
- **2.3.8** strips image data (from subagent tool results) out of conversation records when
  it saves them, so with the Claudian records provider on, the sync folder can shrink by
  tens of megabytes in one go. The plugin's "has the sync folder been emptied?" check no
  longer counts conversation records' bytes, so this does not pause syncing. After updating,
  each device re-checks the sync folder once: its first sync copies nothing, and the second —
  one sync interval later, or a second **Sync now** at least 90 seconds after the first —
  carries on. A device an older version had already paused with "fewer bytes than before"
  resumes the same way.
- **2.3.11** moves an archived Codex conversation's session file into Codex's own archive
  folder (`~/.codex/archived_sessions`). A conversation archived on a device stays archived
  there: the plugin sees the file in the archive and does not copy the sync folder's version
  back into the active folder (the sync report lists it as `archived-here`). Other devices
  keep their own copy in their active folder and keep syncing it. Unarchive it **on the
  device that archived it** (in Claudian there, or with `codex unarchive`) and it catches up
  with what the other devices added — as long as that device had synced it before archiving;
  if both sides added turns, you get a conflict with both versions kept. With shared
  records, the archived state shows on every device, but only the device that archived it
  moves the file, and restoring it elsewhere does not move it back: if Codex on that device
  then says the session is archived, archive and restore it there once. The plugin never
  writes to or syncs from the archive folder, and its restore and conflict screens will not
  put a copy beside an archived one. If an older version of this plugin already copied an
  archived conversation back, that copy stays and keeps syncing, and unarchiving it later can
  raise a conflict.

Codex can **compress** a session left untouched for a week into `<name>.jsonl.zst` beside it,
in the active folder and in the archive (when its experimental compression switch is on, and
whenever a Codex client sends the experimental `rollout/compress` request, which does not need
the switch). This version does not sync compressed files, and reads only a compressed file's
18-byte header, never its contents. A compressed conversation is left compressed: the plugin
does not copy the sync folder's version back beside it (`compressed-here` in the report),
except when that version is exactly what was compressed plus turns another device added — the
header's recorded length (or, for files from Codex before 0.152, the modification time Codex
copies onto them) shows what was compressed. Then it lands next to it, Codex reads it from then
on, and the older compressed copy, which Codex no longer uses, can be deleted. When it cannot
tell, it holds back and names the conversation: open it in Codex once and quit without sending,
let the next sync run, then continue — sending first can split it into two versions. Resuming a
compressed conversation turns it back into a plain file, which syncs as usual; a compressed one
your other devices never had stays on this device until you do. An archived session Codex has
compressed still counts as archived. Restoring an older version over a compressed conversation
is refused, and so is resolving a conflict on one, until it has been opened in Codex once.

Claudian's **DeepSeek** provider (2.3.17) is not supported: the records provider carries
its records, but its sessions are not synced.

### What the sync folder still holds

Deletions are never propagated, so the sync folder only grows: a conversation deleted on
every device still has its session files there, and a new device still receives them. The
command **Audit the sync folder (read-only)** shows what that amounts to, in three lists:
conversations this device keeps off itself (deleted here, or removed by an older Claudian's
deletion marker), with the session files their records name and their size; sessions in the
sync folder that no Claudian record in this vault names, in any field Claudian builds a
conversation's history from; and records left only in the old `.claude/sessions` folder,
with the session id a terminal can resume them by. It changes nothing, and it has no delete
button on purpose. A session with no record here may have been deleted — or its record has
not arrived yet, sits in another device's folder this vault has not received, or was never
made because the session started in a terminal — and nothing on disk tells those apart.
Removing files from the sync folder by hand also does less, or more, than it looks: remove a
few and any device that still has those sessions copies them straight back; remove more than
a few (more than three files and more than a tenth of them, or more than a quarter of the
bytes) and every device that had seen them stops syncing and writes nothing until the files
are put back by hand. And a device that has not received a session yet loses its only copy.

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
| **Reads** | the session files of the providers *you* switch on (all off by default), Claudian's conversation records inside your vault, and the `manifest.json` files in the vault's plugins folder (only to learn which Claudian version is installed). With the Claudian records provider on, it also checks whether a deleted Claude conversation's session file exists in this vault's Claude project folder — existence only, never the contents, and even when the Claude Code provider is off — to tell your delete from Claudian's own. *Audit the sync folder* lists the sync folder, reads the vault's records (both record folders, every device's), and checks which of the sync folder's sessions exist on this machine (Codex's archive folder included) — for the providers you switched on, and only when you run it |
| **Writes** | your sync folder, those same session files when pulling a conversation from another machine, and its own state under `~/.claudian-session-sync` |
| **Never** | anything else. Every path is resolved segment by segment and rejected if it escapes a known root or passes through a symlink; files it does not recognise are reported and left alone; credentials (`auth.json`, `config.toml`, `.credentials.json`) are excluded by name and never read. The one exception to the symlink rule is reading Claudian's `manifest.json`, which follows a linked plugin folder the way Obsidian does, because a plugin installed from a working copy is usually linked there |

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
- Files larger than *Maximum file size* (default 64 MB) are skipped and reported.
- Each sync reads at most `maxFilesPerPass` files that need reading (default 200; change it
  in the plugin's `data.json` while Obsidian is closed — it is not on the settings screen).
  Sessions answered from the cache do not count, except when a periodic full check re-reads
  them (each file at least daily); files over *Maximum file size* are skipped without being
  read. A session turned away five syncs in a row gets through on a separate allowance of 20
  files per sync, longest-waiting first, and the report says so when that queue is backing up.
  A conversation record deleted on this device is always judged in the sync that finds it
  gone, whatever the limit.
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
npm run verify   # typecheck, lint, secret/docs gates, ~1400 tests, build, bundle checks
```

Design documents (Chinese): [architecture](docs/zh-CN/architecture.md) ·
[testing & acceptance](docs/zh-CN/testing.md) · [measured findings](docs/zh-CN/findings/).
Every behavioural claim above traces to a decision record (ADR 1–84) and, where it
matters, to a real-machine measurement.

## License

[MIT](LICENSE)

---

## 简体中文摘要

在多台电脑之间同步 AI agent CLI(Claude Code、Codex 等)的**原始会话文件**,让你在
A 机器上的对话能在 B 机器上 `resume` 继续。桌面端专用;不接任何网盘 API,只认你指定
的本地同步文件夹(Dropbox / OneDrive / Syncthing 均可)。

- **只同步本 vault 的 Claudian 有记录的会话**;纯终端起的会话、没有 session id 的旧记录
  不同步。在 Claudian 里删除的会话不再有新会话从本机上传,但已在同步目录里的会话文件照常
  双向收敛(包括你在本机终端里继续写的内容)——本插件从不传播删除。开着「Claudian records」时,在本机删掉的对话留在删掉的状态,可用命令
  「Bring back conversations deleted on this device」取回。在本机归档的 Codex 对话留在
  Codex 的归档目录里,不会被拉回活动目录;被 Codex 压缩(`.jsonl.zst`)的对话同样不会被拉回,
  除非同步目录里那份正是压缩内容加上别的机器新增的内容(凭压缩文件头里记的原长判断,不解压)。
  压缩的文件本身不同步,在 Codex 里续接一次即恢复;插件说「无法判断」时,先在 Codex 里打开一次、
  不发送就退出,等下一轮同步后再继续。
- **历史没到之前别在对话里发送**:Claude 对话的会话文件还在同步目录里、没落到本机时发送,Claudian
  会删掉或重置这条对话;共享的对话,这个改动会随 vault 同步到你的其他机器。每轮同步后插件会检查这种状态,
  在报告里点名;Obsidian 启动后的第一轮、或同一条对话下一轮仍在等时,弹窗按标题点名。命令
  「Audit the sync folder (read-only)」只读地列出同步目录里还留着什么(本机不再列出的对话及其文件大小、
  本 vault 没有记录的会话、只在旧 `.claude/sessions` 里的记录),**不提供删除**。
- **合并只做前缀快进**,从不信时间戳;双机分叉 = 冲突,两个版本都保留,由你选择。
  覆盖前必备份;不认识的文件永远原地不动;不传播删除。
- **请勿把 `.claudian/` 排除在你的 vault 同步之外**——Claudian 的会话列表靠它;
  注意 Obsidian 官方同步不带隐藏文件夹(`.obsidian` 除外)。
- **Grok 已通过两机验收**(2026-08-26,双向),同步的是会话本体(记录 + 历史),其余文件由
  对端 CLI 自行重建;和所有 provider 一样**默认关闭**,首次打开会先跑一轮 dry-run 让你先看
  范围——**那一轮什么都不写**。
- 本插件与 Claudian 项目**无隶属关系**。

设置与安全细节见上文英文说明;设计文档在 [docs/zh-CN/](docs/zh-CN/)。
