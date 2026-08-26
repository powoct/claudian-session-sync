# HANDOFF — 交接说明

> 更新时间：**2026-08-24**（M1/M2/M4 已完成并发布 0.1.0；M3 主体交付：备份恢复 UI、`.aiss/prev` 否决、**Grok 接入**）。本文描述**当前进度快照**，供下一个会话（或下一个人）接手。
> 读本文前先读 [CLAUDE.md](CLAUDE.md)（产品边界）→ [docs/zh-CN/architecture.md](docs/zh-CN/architecture.md)（实现规范）→ [docs/zh-CN/testing.md](docs/zh-CN/testing.md)（测试与验收）。

## 当前状态（2026-08-24）

| 里程碑 | 状态 |
|---|---|
| **M0 / M1** | ✅ 完成，M1 Exit 达成（2026-08-11 步骤 8 复验通过） |
| **M2** | ✅ 完成：provider 抽象 + **Codex 接入**（Tier A，2026-08-15 两机验收后已摘 experimental）；OpenCode 判定为结构上不可同步并移出范围 |
| **M4** | ✅ 完成：README / LICENSE(MIT, 2026, powoct) / release workflow / 仓库转 public / **0.1.0 已发布** |
| **M3** | 🟡 主体已交付：冲突 UI（M1 即有）、**备份恢复 UI**（ADR-49/50）、`.aiss/prev` **评估后否决**（ADR-51）、`claudian` provider（ADR-48）、**Grok 接入并通过两机验收**（ADR-52…55）。剩：孤立 aux 清理命令、Pi（无数据） |

**Grok 已于 2026-08-26 通过两机九步验收，`experimental` 已摘**（默认仍关闭，那是 ADR-39，与 Tier 无关）。
摘要：[findings/2026-08-26-grok-acceptance.md](docs/zh-CN/findings/2026-08-26-grok-acceptance.md)。
验收另抓出两条「文档承诺了、代码没做」并已修（ADR-55）：首次启用的 dry-run 闸门、冲突面板认不出是哪个文件。

**唯一待办的人类动作**：装上新构建后，在 B 机打开冲突面板确认那条**有意留着没解**的
`chat_history.jsonl` 冲突现在能认出来、一次点击能收敛（详见 findings 结尾）。然后就可以发 0.2.0。

## 历史状态：步骤 8 复验通过，M1 Exit 达成

**2026-08-10 首轮真机验收已执行**（Mac ↔ Windows，记录在验收机器的
`tmp/acceptance/out/`，脱敏摘要入库为
[findings/2026-08-10-m1-acceptance.md](docs/zh-CN/findings/2026-08-10-m1-acceptance.md)）。
核心断言（跨机按 ID resume）通过，会话数据 I1 全程成立；**M1 Exit 首轮判定不通过**，
唯一阻塞是 D-3：非发起方机器上冲突解决被 stale 守卫锁死。

**2026-08-11 批次（本批）**：修复 D-3（隔离目录机器中立化，ADR-40）、D-1（manifest
静默 pass 不重写，ADR-41）、D-2（隔离 meta 字节稳定）、D-4（状态栏冲突计数与文案，
ADR-42）、D-5（轮转补 pruned 索引行）；D-6 裁决为 by design 并改剧本；同批完成
**改名 Claudian Session Sync**（ADR-43：插件 id / home 目录 / vault 身份目录随名，
`.aiss/` 与 root.json 的 magic 不动）。

**2026-08-11 晚：步骤 8 复验已执行并通过**（记录在验收机 `tmp/acceptance/out_r2/`，
脱敏摘要与 R2-1/R2-2 判定已并入 findings/2026-08-10-m1-acceptance.md 文末）。两轮
分叉均完整闭环收敛，D-1/2/3/4 回归全绿，迁移无损。**M1 Exit（testing.md §9.5）判定：
通过**。复验暴露的 R2-1（resolve 被同步工具瞬时锁打成无声空操作 + DEFER 轮计数归零）
已在本批修复（ADR-44，注入验证）；R2-2（备份轮转删最老份）裁决为按设计、I1 无损。
R2-1 的修复无需专门再跑一轮验收——日常使用中任意一次冲突解决顺手确认"一次点击即
收敛，或收到明确的『文件忙请重试』提示"即可。

**调查 Claudian 机制的本地资源**：用户已把 Claudian fork 后 clone 到开发机的
`~/projects/claudian/`。R-1（ai-title
写 session 文件的行为）与 M2 的 `.claudian/sessions` provider 评估（写入模式：
`conv-*.meta.json` / `.inputs.json` 是否改写、是否原子写）可以直接读源码求证，
不必全靠真机黑盒探测。

| 阶段 | 状态 | 产物 |
|---|---|---|
| 架构与测试设计（第 1 版） | ✅ | architecture.md / testing.md 初稿 |
| 第三方设计审核 | ✅ | [review/1_architecture-and-testing-review.md](review/1_architecture-and-testing-review.md)（28 项 finding） |
| 按审核意见改版（第 2 版） | ✅ | 全部 finding 已落实或显式拒绝（拒绝理由见 testing.md 附录 A）；两轮独立核查（覆盖率 + 一致性）报出的 31 处问题已修完 |
| 真机探测套件 | ✅ | `tmp/probe/`（不入库）；经安全审查修掉 3 个泄漏级 bug 后交付 |
| **macOS + Windows 真机探测** | ✅ | 原始报告与逐条判定归档在 [docs/zh-CN/findings/](docs/zh-CN/findings/)；结论已回填两份文档 |
| **M0 脚手架** | ✅ **完成** | G-01…G-11 全部交付并自检；`npm run verify` 本地全绿（`npm test` 102 条 + `check:bundle` 20 条）。落地清单见 [testing.md §12.7](docs/zh-CN/testing.md) |
| **M1 批 1 · 领域层** | ✅ **完成** | 5 个模块，230 条 m1 用例，domain 覆盖率 98%；[review/2](review/2_m1-batch1-domain-review.md) 的建议已处理（见下） |
| **M1 批 2 · infra** | ✅ **完成** | FsGateway / PathGuard / Clock / 三处 store / 备份 |
| **M1 批 3 · SyncEngine + L2** | ✅ **完成** | 九阶段 pass、双 replica world、冲突隔离、就绪状态机、崩溃矩阵、manifest、锁；541 条 m1 用例 |
| **[review/3](review/3_m1-batch2-batch3-review.md) 整改** | ✅ **完成** | §3.1/§3.2/§3.3 三个正确性问题 + §4.1/§4.2/§4.4/§4.5 的覆盖与门禁欠账（见下） |
| **M1 批 4a · 状态落盘门面** | ✅ **完成** | json-file / home-store / sync-dir-store / backup-writer / lock-file / state-adapters / pass-runner；S-08、S-16…S-20 首次有端到端证据 |
| **M1 批 4b · Obsidian UI** | ✅ **完成** | plugin-runtime（无 Obsidian 类型）+ 设置面板 / 报告 / 冲突面板 / 8 条命令；S-04c 三种解决方式全绿 |
| **[review/4](review/4_m1-batch4-review.md) 整改** | ✅ **完成** | 2 条中低危讨论点已处理；写验收脚本时另抓到一个 dry-run 违反 ADR-27 的真 bug |
| **M1 真机十步验收（首轮）** | ✅ 已执行（2026-08-10）：9/10 过，D-3 阻塞 | [findings/2026-08-10-m1-acceptance.md](docs/zh-CN/findings/2026-08-10-m1-acceptance.md)；原始记录在验收机 `tmp/acceptance/out/` |
| **验收缺陷整改 + 改名（2026-08-11）** | ✅ **完成**：D-1/2/3/4/5 修复、D-6 裁决、ADR-40…43、改名 Claudian Session Sync | 本批 commit；剧本与套件已同步更新 |
| **步骤 8 复验（迁移后）** | ✅ 通过（2026-08-11）：两轮闭环收敛，D-1/2/3/4 回归绿；暴露 R2-1（已修，ADR-44）、R2-2（裁决按设计） | 验收机 `tmp/acceptance/out_r2/`；findings 文末复验章节 |
| **M1 Exit** | ✅ **达成**（testing.md §9.5：十步全过 + 门禁全绿） | 下一步 M2 或 M4（README + BRAT）由用户定 |

### M0 交付了什么

工具链 exact pin（Node 20.20.2 / TS 5.9.3 / vitest 4.1.10 / esbuild 0.28.1 / ESLint 10.8.0 / fast-check 4.9.0），三平台 CI，六个 `check:*` 门禁（五个是 `scripts/check-*.mjs`，`check:bundle` 是一份独立 vitest 配置），bundle 三层合同测试，覆盖率强制，`.gitattributes` 行尾锁定。

**M0 的核心不是"配置文件写好了"，而是每条门禁都被喂过应当拦下的输入**——lint 规则、门禁脚本、覆盖率门槛、反例产物各有一组自检（[tests/README.md](tests/README.md)）。一条从未见过它报错的门禁，和一条条件写反了的门禁，长得一模一样。

本地一条命令跑完 CI 的全部步骤：

```bash
npm run verify      # check:pinned-deps → typecheck → lint → check:secrets → check:docs
                    # → test → build → check:bundle → check:manifest → check:no-skip
```

> ⚠️ 开发机（Linux remote-ssh）自带 Node 18，跑不动 vitest 4 与 ESLint 10。**需要 Node ≥ 20.19**（`.nvmrc` 写的是 20.20.2）。

## 关键事实（已实测，写代码前必须知道）

1. **OQ-8 PASS，无需降级**：Claude Code 的 session jsonl 在 compact / fork / retry / 强杀 / 跨版本（2.1.211–2.1.223）下全部**严格追加**。前缀安全合并的地基成立。compact 和 fork 都不产生新文件、不换 sessionId。
2. **转义规则 = `realpath(p)` 逐字符映射**：保留 `[A-Za-z0-9-]`，其余任何字符各变一个 `-`。**输入是 realpath 不是 cwd 字符串**——adapter 落位前必须 `fs.realpathSync.native`。规则不可逆（反转义只做诊断）。
3. **OQ-1 通过**：跨平台 resume 不受 `cwd` 影响，`toNeutral`/`fromNeutral` 保持 **identity**。
4. **Codex 是 Tier A 候选**（不是原设想的 Tier B）：0.146.0 靠扫目录发现会话，只拷 rollout 文件即可见；sqlite 索引不用碰。M2 接入。
5. **picker 陷阱（F-1）**：`claude --resume` 列表只显示交互式来源的会话；同步验证一律**按 ID resume**。
6. 空会话不落盘（CLI 永不产生 0 字节 jsonl）；末尾恒 LF；Windows 目录 fsync 返回 EPERM（FsGateway 需跳过）。
7. 其余计划外发现 F-1…F-9 见 [findings/2026-08-06-spike-conclusions.md](docs/zh-CN/findings/2026-08-06-spike-conclusions.md)。

## 下一步：M1（依据 review §9 与两份文档）

- ✅ **批 1 · 领域层纯函数（已完成）**：`path-escape` / `path-safety` / `merge-policy` / `stability` / `planner`，230 条 m1 用例，domain 覆盖率 98%
  - **U-07**（分叉 → CONFLICT，不是覆盖）在 `planner.test.ts` 与 `merge-policy.test.ts` 各有一条
  - **U-18** 三层俱全：类型级（`PlanInput` 上不存在任何 hash 缓存字段，`expectTypeOf` 断言）、等长不同内容 → CONFLICT、`observedHash` 命名本身表明只接受本次观察
  - §5.2.7 笛卡尔积穷举 1000+ 组合，四条与优先级无关的纯安全断言（发散不覆盖 / NOT_READY 不写 / 未读全不判发散 / 0 字节不冲突）
- 🔄 **批 2 · infra（进行中）**：
  - ✅ `infra/clock.ts`——`Clock` / `IdGen` 接口 + 系统实现 + 可钉死的测试替身
  - ✅ `infra/fs-gateway.ts` + `node-fs-gateway.ts`——原子写（同目录 tmp → fsync → rename）、win32 跳过目录 fsync、`retryOnTransient` 退避、`renameNoReplace`（link+unlink 拿到"目标已存在则失败"的原子语义）
  - ✅ `infra/path-guard.ts`——逐级 lstat containment、四 root 重叠、凭证名单、大小写敏感性运行时探测；**唯一铸造 `SafeAbsolutePath` 的地方**
  - ✅ `infra/state-store.ts`——observations ledger 解析（丢失/指纹不符/更高 schema 一律 fail-safe 归零）、machineId 漂移检测与轮换、workspace 身份 preflight（W-1/2/4/5）、可移植设置的机器相关值检测
  - ✅ `infra/backup-store.ts`——命名（去掉 Windows 非法字符且字典序 == 时间序）、同毫秒碰撞降级、**I1 管辖的轮转**（不可由幸存者复原的版本一律不删）
  - ⬜ 把这些接起来的 store I/O 门面（读写 machine.json / workspaces/*.json / observations.json 的实际落盘路径）——纯逻辑与格式已就绪，剩下的是 FsGateway 调用编排，可与批 3 的 SyncEngine 一起做
  - 批 1 已经把接口形状定下来了：`FsGateway` 的写方法只收 `SafeAbsolutePath`（`src/domain/types.ts`），`PathGuard` 是**唯一**能铸造它的地方（lint 已强制，见 `eslint-rules.test.ts` 的 branded-path 组）
  - E0 签名按**分量**存进 ledger，不要只存 sha256——未来 mtime 的降级路径需要"剔除 mtime 后重算"，只有摘要就做不到（`src/domain/stability.ts` 顶部有说明）
- 🔄 **批 3 · SyncEngine + L2（进行中）**：
  - ✅ `orchestration/pass-report.ts`——报告类型（**类型上没有任何能装文件内容的字段**）、`HookPoint` 屏障点、`CrashSignal`（刻意不继承 Error）
  - ✅ `orchestration/sync-engine.ts`——P0–P8 九阶段、稳定性闸门前置于读字节、A6 备份 / A8 最后一眼 / A10 写回快照、`mintWritePath` 强制 adapter 输出过 PathGuard
  - ✅ `providers/provider-adapter.ts` + `claude-code/adapter.ts`——白名单分类（安全边界）、Tier A 扫目录发现
  - ✅ `tests/helpers/world.ts`——双 replica L2 world + 可编程 transport（truncate / zero-byte / mtime 策略 / drop）
  - ✅ `tests/helpers/invariants.ts`——`assertRecoverable`（I1，字节前缀语义）、I1-a/b/c
  - ✅ **U-18b 集成形态已落地**（等长 + 还原 mtime + 发散 → CONFLICT，两侧冻结）、U-07 引擎级、S-01/02/03/08/10、I2a 收敛
  - ✅ `domain/conflict.ts` + 引擎落盘——内容派生的 `conflictId`、`.quarantine/<ws>/<provider>/<id>/`、meta.json；U-13/U-20/U-21 全绿
  - ✅ `domain/readiness.ts`——NR-1…NR-9 全表 + `AWAIT_INIT` 歧义处理；U-15/16/17 全绿
  - ✅ 崩溃点矩阵——`crashDuringPass` 注入 `CrashSignal`（不可捕获），六个注入点各断言"重启后与从未崩溃的对照组逐字节一致"
  - ✅ I1/I2a/I2b 属性测试（`tests/m1/property/`，nightly job 已能挑到）
  - ✅ `domain/manifest.ts`——M-01…M-08 全覆盖；E0/E1/E2 证据分级 + `mayAuthoriseWrite` 类型收窄（E2 才能授权写）；更高 schemaVersion 绝不重写；未知字段读改写后仍在；坏 entry 只丢那一条
  - ✅ `orchestration/lock.ts` + 引擎接线——R-09（同实例重叠 pass 立即 `ALREADY_RUNNING`，零写入）、R-10（陈旧锁可抢占 + **epoch 让被抢者的写入失效**）
  - ✅ 三条冲突命令与锁的落盘实现——都在批 4 里补齐了

### 批 4（2026-08-08）

**4a 落盘门面**：`json-file` / `home-store` / `sync-dir-store` / `backup-writer`（infra）+ `lock-file` / `state-adapters` / `pass-runner`（orchestration）。写这批的测试抓到两个真 bug：

- **坏锁文件是永久的**。"没有文件"和"文件读不懂"都归 null，于是获取锁时对着那个刚被判定忽略的文件做独占创建、失败、报 `LOCK_HELD`——插件从此再也不同步。这正是 `parseLockFile` 把垃圾当"无人持有"要避免的结果。两种情形现已分开。
- **NR-5 在每次 push 之后有一轮盲区**。就绪扫描在 pass 之前跑，所以记下的计数从不包含我们刚写进去的东西；那一轮里被清空的 sync 目录读起来就是"这里从来什么都没有"。写过的 pass 在 commit 时补一次扫描。

**4b UI**：`plugin-runtime`（**不含任何 Obsidian 类型**，lint 强制）承载全部行为，`src/ui/**` 只做渲染。测试经 vitest alias 把 `obsidian` 指到 stub，因此表现层能在纯 Node 下跑。接 UI 时又抓到一个：

- **原子写从不建目标目录**。world 的 `mintWritePath` 替身顺手 `mkdir` 了，把它盖了一路；换成真 PathGuard 后每次 `PUSH_NEW` 都 `FAILED_IO`。现在归 `stageTemp`（ADR-37）。

三处刻意的偏差都记在了架构文档里：ledger 多存 `verifiedSig` 与 `remoteHadNonZeroSize`（§5.5 表格）、`local` 用 neutralRel 做 key（同处）、设置分两处（ADR-38）。

### review/4 整改（2026-08-09）

[review/4](review/4_m1-batch4-review.md) 报了 **0 Blocker、0 高危**，两条中低危讨论点都已处理：

| 项 | 处理 |
|---|---|
| §3.1 E1 分支跳过 `conflictKnown` | 在 `sync-engine.ts` 的分支上方与 ADR-35 各补了推论：**这条分支只在两侧 hash 相等时可达，内容相同就没有需要"已知"的分歧**；曾冲突过的一对在内容一致后旧 conflictId 自然不再被算出（U-21） |
| §3.2 `remote-not-ready` 文案 | `describeOutcome` 补一句"只有保留本机版本才写 sync 目录，保留对方版本写本机、仍然可用"——两个按钮在用户眼里对称，只说一个不能用会读成"冲突没法解决" |

**写真机验收脚本时抓到的 bug（review/4 未发现）**：**dry-run 违反 ADR-27**。写到步骤 1 的「五棵树字节零变化」时去核对代码，发现两处：

1. 就绪的**可写探测**会建一个 `.aiss/.probe-<id>` 再删掉——没有净变化，但仍然是一次写；
2. **`remote.json` 无条件写回**——文件内容确实变了，而且它改变的是*下一次* pass 的判断。

ADR-27 说"dry-run 绝对只读"的价值就在于这句话**没有需要记住的例外**。现在 dry-run 不探测（改用上一次真实 pass 证明过的可写性）、不写 remote.json，并有用例 `plugin-runtime.test.ts` 的「leaves all five trees byte-identical」把五棵树逐字节钉死——去掉修复它就红。

顺带把 `conflict-commands.test.ts` 与 `ui.test.ts` 里跑双机多轮 pass 的用例标了显式 `SLOW = 30_000`：它们在覆盖率插桩下会超过 vitest 5 秒默认值，而那个默认值本身值得保留在全局。

### 验收缺陷整改 + 改名（2026-08-11）

首轮验收（2026-08-10）的缺陷全部处置完毕，判定与修复对照见
[findings/2026-08-10-m1-acceptance.md](docs/zh-CN/findings/2026-08-10-m1-acceptance.md)。要点：

- **D-3 的根因不是守卫太严，而是共享目录里的视角标签**：conflictId 对双方对称（设计如此），
  但副本叫 `local-*`/`remote-*`、meta 存 local/remote 字段——第二台检出同一冲突的机器往
  同一目录写入镜像的一对，`readEntry` 用 `find()` 各取第一个，把同一分支同时当两侧，
  解决从此永远 `branch-moved`。修法（ADR-40）：副本按内容哈希命名（`branch-<hash8>`，
  双机写出的字节与文件名全同）、meta v2 无侧标签、no-replace 写入；解决命令在点击当下
  哈希活文件判定视角，只校验**被保留侧**等于某个隔离分支——被覆盖侧无论持有什么都先
  备份，所以不校验它不损失安全（这同时解开了 Claudian ai-title 追加造成的锁死，R-1）。
  回归：B 机场景 + 旧版 4 副本目录各一条端到端用例。
- **quarantineConflict 的注释一直声称 exclusive create，代码用的却是 `writeFileAtomic`**
  ——D-2（meta 每轮重写）就藏在这句谎里。教训与 review/3 的「死 gate」同款：
  声称的性质要有一条会红的测试钉住（现在有：meta 字节级稳定，拨钟后注入覆盖式写会红）。
- **D-1**（ADR-41）：entry 内容与签名全等就不改写、无变化不保存 manifest。验证手段
  同样是注入（把保存条件改回无条件，quiet-manifest 用例红）。
- **D-4**（ADR-42）：冲突计数改取 pass 报告的去重会话数；`summarise` 不再把 CONFLICT
  计入 change；解决落地后自动补跑一轮 pass，计数即时归零。
- **改名 Claudian Session Sync**（ADR-43）：改 id / 显示名 / `~/.claudian-session-sync` /
  vault 内 `.claudian-session-sync/`；**不改** `.aiss/` 与 root.json 的
  `magic: "ai-session-sync"`（wire format，改了会把已初始化目录判成 NR-2）。
  真机迁移步骤在验收套件 AGENTS.md §3 P0（三个 mv + 重装，保 machineId 与备份）。
- 注意：**测试里对未提交修复做 `git checkout <file>` 会连修复一起洗掉**——本批注入
  验证时发生过一次，靠"注入后测试红得不对劲"发现。注入验证请用可逆的 sed/patch。

### M2 开工（2026-08-12）

**做了什么**

1. **Claudian 源码调查完成**（本机 clone `~/projects/claudian`，HEAD `033eed12` = 2.1.3），
   结论入库为 [findings/2026-08-12-claudian-source-survey.md](docs/zh-CN/findings/2026-08-12-claudian-source-survey.md)。
   四条对路线有直接影响：
   - **R-1 归因错了并已更正**：`ai-title` 记录**不是 Claudian 写的**，是 Claude Code CLI 自己写的
     （Claudian 源码 + 全部 git 历史零命中；未装 Claudian 的本开发机上 17 个 session 有 6 个含该记录）。
     于是它落在 OQ-8 已实测的 append-only 模型**之内**，不再是第三方写入者风险。
   - **OpenCode 不可同步**：会话全在单个 SQLite `opencode.db`，无 per-session 文件、无官方
     export/import。**Tier C 且无升级路径**——已从 M2 范围删除（§15）。
   - **Codex 可做，但 OQ-11 是前提**：`~/.codex/sessions/` 是全局目录，没有按项目分区，
     不加限定会把本机**所有** Codex 对话推进本 vault 的 workspace。
   - **OQ-12 有结论**：只同步 rollout ⇒ `codex` CLI 可 resume，但 **Claudian UI 里没有入口**
     （Claudian 按 vault 内 `.claudian/sessions/<id>.json` 的 threadId 找文件，从不扫盘枚举）。
2. **修掉一个 M1 现网缺陷（commit `78e4c79`，ADR-45）**：§8.2 白名单**在远端侧从未被调用**。
   实测三种成品冲突副本（Syncthing / 英文区 Dropbox / OneDrive `-<hostname>`）会被当作
   session 拉进 CLI 目录。2026-08-10 验收没暴露它，只因为 Dropbox 当时写的是中文名、
   被 `SEGMENT_CHARSET` 挡了——**是运气不是边界**。同一处另有两个只在多 adapter 下发作的
   错误：远端文件一律归给 `adapters[0]`（跨 provider 误写）、远端只列一层目录（日期分层
   provider 完全不可见）。修法是把 §6.2 早就写了却没实现的 `classifyNeutral` 补上。
   新增 `tests/helpers/fake-providers.ts`（嵌套形状的第二个 adapter）与 World 的
   `extraAdapters` 选项——这是 M2 多 provider 测试的地基。

**M2 已交付的部分**（同日晚批）

| # | 事项 | 状态 |
|---|---|---|
| 1 | **OQ-11 已决（ADR-46）**：Codex 的 workspace 归属源 = vault 内 Claudian 的会话记录 `<vault>/.claudian/sessions/*.meta.json`。它在 vault 里，所以「属于这个 vault」是构造性质——不读 rollout 内容、不猜 `cwd`。**只取 `sessionId`，绝不使用记录里的绝对路径**（那是写入方机器的）。归属只作用于 push 侧；pull 侧只校形状 | ✅ `e831596` |
| 2 | Codex adapter + 注册表 + 设置项（experimental 标签 + 归属说明） | ✅ `e831596`，29 条用例，注入验证过 |
| 3 | `ConflictMeta` v3 存 `neutralRel`（v2 目录仍按旧法重建，对唯一写过它的 provider 正确） | ✅ `03ad03e` |
| 4 | mode 守卫：primary mode ≠ `append-jsonl` ⇒ `SKIPPED_POLICY` + notice，不进 append-jsonl 决策表 | ✅ `03ad03e` |
| 5 | 真机探测套件 `tmp/probe-m2/`（P1 Codex 布局 / P2 生命周期 / P3 vault 记录 / P4 Grok+Pi / P5 规模） | ✅ 已建，本机烟测通过 |

**2026-08-12 追加批：记录准入推广为统一规则（ADR-47，用户拍板「M2 现在切」）**

- **Claude Code 从「目录准入」切到「记录准入」**：`listSessions` 只列 vault 内
  `.claudian/sessions/*.meta.json`（Claudian 拼法 `providerId:"claude"`）里出现的
  sessionId。纯终端起的会话不再被准入；已同步的旧会话靠成员资格继续收敛（零迁移）。
- **成员资格与准入分离已被测试钉住**（`043774c` + `multi-provider.test.ts`）：replica
  里的文件无论 adapter 列不列都双向收敛——对端没有记录也能推回续写。这是整个模型的
  承重墙，别拆。
- **墓碑排除**：Claudian 的 markDeleted 只写 `<convId>.deleted.json`、meta 原地保留，
  准入读取端按墓碑排除（两个 adapter 共用 `src/providers/vault-scope.ts`）。**只终止
  准入，不删 sync-dir 副本**——删除传播仍是 ADR-10 排除项，M3 再议（复活竞态）。
- 样本实证（用户提供，形状记录在 §6.4/ADR-46）：`sessionId` 可为 null（此时连
  providerState 都没有，reader 天然跳过）；Claude 记录的 providerState 字段名是
  `providerSessionId`（Codex 是 `threadId`），reader 三选一读取。
- **两个测试 harness 现在自动种记录**：`FakeCli.session()` / `RuntimeHarness.appendSession`
  = 「经 Claudian 发起的会话」；要造纯终端会话用 `FakeCli.terminalSession()`，删除用
  `FakeCli.tombstone()`。**下次真机验收前剧本要改**：造会话一律改为在 Claudian 里发起
  （两台机器都装了 Claudian，保真度反而更高）。
- `.claudian/sessions` 本身的同步（对端 UI 入口那半）**M3 再做**：Obsidian Sync 官方
  文档证实点目录一律不同步（除 `.obsidian`）；技术形状 = §7.2b opaque 模式，正好同批。

**2026-08-13:probe-m2 已跑完并回填**（[findings/2026-08-13-m2-probe.md](docs/zh-CN/findings/2026-08-13-m2-probe.md)）：

- **Codex Tier A 成立**:双平台(0.146.0/0.146.1)PREFIX_VIOLATION 0——exec/resume/
  强杀/杀后恢复/静置/fork 全部符合预期,文件名不变,只读 resume 零写入。
  **唯 compact 未测(OQ-13,发布阻塞)**:0.146.x 无非交互入口,需人工 TUI 补测一次
  (Mac 上套件还在:resume 测试会话 → `/compact` → `snap` → `report`,约 5 分钟)。
- **OQ-7 关闭**(当前规模):全量 hash 亚秒级。顺手修了一个实测暴露的问题:
  最大常规 rollout 23 MiB > 旧默认 `maxFileSizeMB=20` 会被 SKIP_TOO_LARGE,
  **默认已调 64**。注意:已保存过设置的 vault 里存的还是 20,**要么在设置里手动调,
  要么删掉 data.json 里的 maxFileSizeMB 让它吃新默认**。
- **P3 核对通过但有一个用户可见的坑**:vault 记录 78 条里 **25 条(32%)sessionId 为
  null**(codex 19/claude 6)——这些会话找不到 CLI 文件,不参与同步(fail-closed)。
  README 须写明;在 Claudian 里续聊一轮通常会补上 id。
- Grok 实测比源码调查更复杂(10+ 文件 + 4 对 .lock/会话),维持 Tier C,M3 需 group 原子性。
  Pi 两台机器都无数据,继续挂起。
- 计划外发现:**Codex subagent 线程的 rollout 在同一 sessions/ 树**,记录准入下不同步
  ——跨机 resume 用过 subagent 的会话,子线程历史对端缺失。下次验收列观察项。

**2026-08-13 晚:OQ-13 已闭**——用户人工在 TUI 对 fork 会话执行 `/compact`,快照 10
显示 **+4654B 严格前缀追加、0 违规**(compacted 历史以新条目落盘,与 Claude Code 的
compact 同构)。**Codex 生命周期无缺口,Tier A 完整成立,发布阻塞解除。**
experimental 标签保留到 M4 验收跑通一轮 Codex 跨机 resume(M1 步骤 4 的同构断言,
生命周期探测不能替代)。

**2026-08-13 深夜批:review/5 整改 + M4 交付物**

- review/5 三条测试缺口已补(M2-2 未注册 provider 子树不落地 / M2-3 adapter 白名单
  自洽表驱动 / M2-4 撕裂墓碑仍终止准入),全部注入验证过会红;M2-1/M2-6 注释已加,
  M2-5 记入下方 M3 项。
- **M4 交付物已入库**:`README.md`(英文主体 + 中文摘要,含全部 CLAUDE.md 要求的
  界限声明)、`.github/workflows/release.yml`(tag 触发,校验 tag == manifest 版本,
  verify 全绿才发布,产物 = main.js + manifest.json)、版本三处同步 bump 到 **0.1.0**、
  验收套件 M4 附录(Codex 跨机 resume 剧本 + subagent 观察项 + maxFileSizeMB 检查)。

**2026-08-15:M4 验收已跑完并归档**([findings/2026-08-15-m4-acceptance.md](docs/zh-CN/findings/2026-08-15-m4-acceptance.md)):

- **A 项(Codex 跨机 resume)通过**,连同 P2 生命周期,**experimental 已摘**(README
  provider 表同步更新)。B1/B2 观察符合预期:subagent 结论回传主线程、不影响续聊;
  `.claudian/` 经 git 互通时对端 UI 完整可用且 UI 续聊写同一 rollout。C 项 64 默认
  生效,零 SKIP_TOO_LARGE。两侧 I1 成立。
- **R3-1**:B 侧现场推断「拉动侧受记录准入约束」**已否证**——快照取证(replica 文件
  在 DEFER 窗口字节冻结)+ 两条全链路测试(`codex-pull-unrecorded.test.ts`,真实
  PluginRuntime,无记录/无库均正常落地)。现场 DEFER 的真实机制未定(report 未留存),
  若再现:先存「Show last sync report」的 Why 列。
- **套件缺口(下轮前修)**:验收套件 config.json 的快照树不含 codex 本地 root,
  R3-1 无法做本地侧取证正是因此。

**2026-08-15 晚:发布完成 + M3 第一块落地**

- **0.1.0 已发布**:LICENSE(MIT)入库 → 仓库转 public → tag `0.1.0` → release workflow
  全绿,产物 main.js + manifest.json 挂上。BRAT 地址 `powoct/claudian-session-sync` 生效。
- **M3 第一块(ADR-48)已实装**:§7.2b opaque 决策表 + **收敛基点快进**(`lastConvergedHash`
  存本机 ledger,只在本机亲历的收敛事件更新;基点缺失退化为 CONFLICT,fail-safe)+
  **`claudian` provider**(Tier R,vault 内 `.claudian/sessions/`,默认关闭,双传输警告)+
  preflight 为「vault 包含 provider:claudian」开唯一豁免。854 用例全绿;注入验证:
  去掉基点检查 5 红,去掉豁免 4 红。`.deleted.json` 随 provider 跨机 = 记录层删除传播
  免费获得(session 文件删除传播仍按 ADR-10 排除)。
- 边界文档已同步:CLAUDE.md 两处改为「默认不含」;README 加 provider 行与开关说明。

**2026-08-16:M3 第二块(备份恢复,ADR-49)已交付**

- `Restore an earlier version` 命令 + 模态框:列表只从目录重建(索引可丢),每行在点击前
  就说明「这次写入做什么」+「下一次同步会怎么处理」(**对比另一侧**、按 mode 分支)。
- 实现前先做了对抗评审(2 个 agent,数据安全 / 误导两个视角),抓到三条我漏掉的:
  轮转会删掉用户刚点的那份(keep=3 实测 ENOENT)、备份与写入之间缺 verify-then-swap
  (CLI 追加的行会进不了任何备份)、「什么都不在了」那一行**永远失败**。三条均已修 +
  注入验证会红。评审里「跨 provider 定位」一条经核实**不成立**(locator 按 provider 构建)。
- ~~恢复点击时重新探测 readiness / 与定时 pass 抢锁~~ ✅ **已修(ADR-50,一并覆盖 resolve)**。
- ~~"Show me the folder" 真正打开目录 + §9.3.4 的「打开备份目录」命令与设置按钮~~ ✅ **已交付**
  (2026-08-18):能力经 `RuntimeHost.openFolder` 注入(`main.ts` 是唯一 require electron 的
  地方),冲突弹窗的「Show me both」同样改为真的打开隔离目录;打不开时一律说"打不开"并给出
  路径,不复用成功文案。
- ~~列表惰性化~~ ✅ **已修**(2026-08-18):备份列表改为**有界页**——先按文件名里的时间戳
  排序(不读任何文件),只读要展示的那些;活文件两侧按 session 缓存一次而非按行读;
  `restoreBackup` 只重述那一份而非整个历史。原实现每次打开弹窗要读完每份备份与每个
  session 的两侧,按实测规模是几百 MB,在按需下载的网盘上还会顺带把 replica 侧全部水合。
- **未采纳但已记档的后续项**(评审提出,均非阻塞):
  (当前每次全量读取,P5 实测规模下可接受)、"Show me the folder" 真正打开目录 +
  §9.3.4 要求的「打开备份目录」命令、以及 export/"另存一份" 原语(评审认为对多数
  场景比 restore 更合适)。

**2026-08-18(新 VPS 6 vCPU/8 GB):M3 又交付两块 + 一条评估定案**

- **§9.3.4 的「找得到备份」已补齐**(commit `a018c7f`):`Open the backups folder` 命令 +
  设置面板按钮,两个弹窗的「打开目录」改为真的打开;打不开时说"打不开"并给路径。
- **`.aiss/prev` 评估完成 → 否决(ADR-51)**,M3 该交付项关闭。三份独立分析(正方/反方/
  证据基线)**一致**,连被要求做最强正方论证的那份也落在"不要建":决定性理由是**收益近乎
  为零**——append-jsonl 的 `PUSH_OVERWRITE` 只在本地严格包含远端时触发,被销毁的版本就是
  新文件的字节前缀、躺在同一个 sync 目录里;唯一不是前缀的情形早已由 `.quarantine/` 覆盖。
  廉价备选(**版本账本**:记 size/hash/lineCount,任何机器截断即可还原,~200 B/次)已记入
  ADR-51,**若将来出现真实需求再做**,不投机建设。
- 评估顺带抓到两件与新代码相关的事,均已修:① 备份列表的全量读取(见上);
  ② **Tier R provider 的轮转永不生效**(整份重写 ⇒ 旧版不是新版前缀 ⇒ 一律 defer),
  `backupKeep` 静默失效而本该说明的 `rotationDeferred` 被 `pass-runner` 丢弃——现已接到
  报告 notice,每轮按 provider 说一次。
- **测试稳定性**:新增的重用例(走 `RuntimeHarness.settle()` = 3 轮真实 pass)缺显式超时,
  在这台仍跑着别的服务的机器上会随机撞 5 秒默认值。按仓库既有约定逐条标注 30s/60s,
  并在夹具处写明理由——「把负载报成缺陷」是最坏的一类测试。

**2026-08-20:P6(Grok)探测任务已写好,并经对抗评审重写**

- 顺手修掉套件自身两个矛盾:白名单缺 `~/aiss-probe-m2`(说明书让你在那儿工作,工具却拒);
  `find-dir` 只认 Claude Code(现支持 `--provider grok|pi`,并显示解码回的工作目录)。
- **`red()` 的隐私漏洞已修**:Grok 项目目录名是 percent-encoded 的绝对路径,字面替换看不见它
  ——`%2Fhome%2Fu%2Fclients%2Facme` 里的客户名会原样进交付物。现按形状替换为
  `<encoded-path:Nsegs>`,已端到端验证交付物里无原始编码路径。
- **初稿经两个 agent 对抗评审后重写**(安全 5 blocker / 适配性 3 blocker),要点:
  ① 红线 R3 说「只读」却被正文的移文件实验推翻——现把例外写进红线本身并限定路径前缀;
  ② 备份与暂存原本放 `out/`,那是交付目录且 §8 自查会把唯一备份删掉——现移到 `~/aiss-probe-m2/`
  并新增红线 R8;③ 沙箱门禁原本「目录里有文件」即通过,而 grok 首次会先写配置——现要求出现
  `chat_history.jsonl` **且**真实目录会话数不变;④ 读侧隔离检查原本在最危险的步骤**之后**,
  且因 Grok 按 cwd 分目录而必然通过——现前移到 6b.0 并改用「第二个空沙箱列表必须为空」;
  ⑤ `export GROK_HOME` 在每条命令新起 shell 时不存活、引号里的 `~` 不展开——现每条命令自带
  前缀 + 守卫;⑥ R5 只禁了 `pkill` 没禁 `pgrep -f`,而 agent 自己的命令行就含 `grok`;
  ⑦ **最尖锐的是逻辑缺陷**:Grok 是否有外部索引从未被测,而 Codex 当年有两套——不查清则
  「移走所有文件还能看到」无法判定 G1;⑧ 跨 cwd 落位从未被测,而那正是同步能否成立的前提。

**下一步**

| # | 事项 | 说明 |
|---|---|---|
| **1** | **复验 F-4 的修复** —— B 机装新构建后打开冲突面板,确认那条留着没解的 `chat_history.jsonl` 冲突显示为 `Session 01a03d22 · chat_history.jsonl (grok)` 且一次点击收敛 | **用户动作**,两分钟。不必重跑九步 |
| 2 | **发 0.2.0**(claudian provider + Grok):bump 三处版本 → tag | 用户动作 |
| 3 | claudian provider 真机验收(两台都开,验证快进循环与 UI 入口;你的 vault 用 git 带 `.claudian/` 的话**别开**,或先在测试 vault 验) | 下轮真机 |
| 4 | M3 剩余:孤立 aux 清理命令(现在真的有多文件 group 了,这条才有对象) | 依次 |
| 5 | 补测 OQ-14(rewind / `/compact`)、OQ-16(稳定窗口)、**OQ-17(流式期间末行是否就地改写)** | 不阻塞,顺手。OQ-17 是验收 F-5 引出的:P6 的快照全取在 turn 之间,这个面从未测过 |

**旧的发布动作清单(已全部完成)**

| # | 事项 | 说明 |
|---|---|---|
| 1 | **仓库转 public** | BRAT 要求;转之前确认 tmp/ 不入库(已 gitignore)、无隐私残留(check:secrets 全绿) |
| 2 | **LICENSE** | 仓库还没有 LICENSE 文件;Obsidian 社区惯例 MIT,由用户定 |
| 3 | **打 tag 发布**:`git tag 0.1.0 && git push origin 0.1.0` | release workflow 自动 verify + 构建 + 挂产物;tag 名必须恰好等于 manifest 版本(无 v 前缀) |
| 4 | ~~M4 验收~~ ✅ 已完成并归档(2026-08-15);experimental 已摘 | — |
| 5 | M3 候选：`.claudian/sessions` 同步（§7.2b opaque 模式）+ replica 侧删除传播设计 + Grok group 原子性（含 review/5 M2-5：mode 守卫从逐 primary 提为逐 group——aux 与 primary 的 mode 可能不同,整组 DEFER 而非逐文件跳过） | M3 |

**本机烟测已经顺带回答的两件事**（开发机 Linux，Codex 0.146.0-alpha.9.2）：

- `~/.codex/sessions` 下 15 个 rollout **全部**是 `rollout-<prefix>-<uuid>.jsonl` 形态，
  **文件名里没有冒号、没有非 ASCII**——即 `SEGMENT_CHARSET` / `WINDOWS_ILLEGAL` 不会拒收它们
  （这条原本是「Windows 上可能整片会话无法同步」的疑虑）。
- 目录深度就是 `YYYY/MM/DD` 三层，与 adapter 的假设一致；首行 `session_meta.payload` 含
  `cwd` 与 `cli_version`。

### M3 · Grok 接入（2026-08-24，本批）

**输入**：用户在 macOS + Windows 两台真机上跑完了 `tmp/probe-m2/` 的 P6，产物在
`tmp/probe-m2/out_r2/`（38 张生命周期快照 + 两份平台小结，不入库）。
脱敏摘要入库为 [findings/2026-08-24-grok-probe.md](docs/zh-CN/findings/2026-08-24-grok-probe.md)。

**先做的事：不信小结，逐条对着原始快照复核。** 结果是两份小结在多处不准，其中一处
**改变了设计**：

- 两份小结对「缺 `summary.json` 时 resume 会怎样」给了互相矛盾且都错的描述。按快照复核，
  双平台的真实结果是——**目标会话零写入，用户的下一个 turn 被静默追加进了另一个会话**
  （macOS 是 g06 fork 出来的那个 +3 行、`prompt_history` +126 B；Windows 同形）。
  且 macOS 侧排除了「回落到最近使用的会话」这个解释。
- 于是 G1 的读法从「primary 落位前不可见」收紧为 **「primary 落位之前，这个会话目录不能
  对 CLI 存在」**——因为指向它的一次 resume 会污染**别人的**对话，而那些写入是合法纯追加，
  本插件会忠实地复制到所有机器。
- 其余修正：`announcement_state.json` 只变一次且是**机器作用域**（fork 连 mtime 都照抄）；
  `title_refresh_idx` 在 mac 上只从 `"0"` 变成 `"2"`（跳过 `"1"`），Windows 全程不变，
  **不是单调计数器**；「差异从偏移 0 开始」在本数据集**不成立**（快照只在 64 KB 整数倍存
  前缀 hash，而所有 JSON 状态文件都小于 64 KB，报的偏移只是「已证明相等的下界」）；
  强杀实验两平台**不是同一个实验**，不支持任何 OS 结论。

**交付**

| # | 事项 | 说明 |
|---|---|---|
| 1 | **引擎首次支持多文件 group** | 移除了 `if (file.role !== "primary") continue;`。三条安全规则：组内 **primary 最后落地**；`maxFilesPerPass` 按 **group** 分配（**带下限**：超预算的组独占一轮，否则永远不动）；**replica 里没有 primary 的 group 一个文件都不落**（`primary-not-in-replica`） |
| 2 | **Grok adapter**（ADR-52） | 逐文件分级：`summary.json` = primary 走 §7.2b opaque；`chat_history/updates/rewind_points` 走 §7.2 前缀表；其余不入白名单。中立路径 `grok/<uuid>/<member>`，落位按对端 vault 重算 `encodeURIComponent(realpath(vault))` |
| 3 | **`replicaOnly` 契约**（ADR-53） | 移除上面那行 `continue` 会让 Claude Code 的 `<sid>.origin.json` 被拉进 CLI 目录。**原测试抓不到**——那个 fake CLI 只列 `.jsonl`。先把断言改成读目录、复现变红，再用显式字段修 |
| 4 | **备份路径加 `<logicalId>` 层**（ADR-54，**阻塞级**） | 评审复现：Grok 是第一个**文件名在会话之间重复**的 provider，而备份按 basename 命名、恢复按 basename 定位 ⇒ **从会话 A 取的备份会覆盖会话 B 的对话，返回 `ok:true`**。顺带修好轮转（原本也按文件名圈候选集）。旧的扁平备份仍可列可恢复；**文件名有歧义时返回「定位不到」而不是猜** |
| 5 | 半落地告警 | 判定写成「**本机没有 primary 而 aux 落了**」，不是「primary 的写失败了」——最常见的撕裂根本没有错误（aux 先安静下来落地，primary 因不稳定 `DEFER`） |
| 6 | 注册表 | Grok **默认关闭 + `experimental`**，首次启用强制 dry-run |

**质量**：932 + 21 条测试全绿，`npm run verify` 六项门禁全 OK；**8 次注入验证**全部先红后绿
（组内顺序 / 组内预算 / 缺 primary 不组装 / notice 存在性 / 备份 logicalId 层 / 预算下限 /
notice 只认 FAILED_ / 旧扁平布局兼容）。

**开发机顺手关掉的半个闸门**：本机也装了 grok，在沙箱 `GROK_HOME` 里实测——
**只放 `summary.json` + `chat_history.jsonl` 的会话仍被 `sessions list` 列出**，
且全程没有 `session_search.sqlite`（比探测的推断更硬）。G1 充分性的**列表这一半已关闭**；
resume 那一半要登录态，留给真机。另发现 `grok export` 对一个没有 `updates.jsonl` 的会话报
`Session not found`，但 `sessions list` 列得出——**两条解析路径不同**，且抬高了
`updates.jsonl` 的地位（同步集本来就包含它）。

**还没测的东西**（findings §七有完整表，按后果排序）：⛔ 真两机往返（两次「跨 cwd」都在
同一台机器上做，**没有一个字节真的在两机之间走过**）、⛔ G1 充分性的 resume 那一半、
rewind 与 `/compact`（唯一可能就地重写历史的操作，最坏后果是多一次人工冲突）、
稳定窗口实测值、`$GROK_HOME` 顶层从未进快照。

## 真机验收怎么跑

套件在 **`tmp/acceptance/`**（`tmp/` 在 gitignore 里，所以它不入库，**要手工拷到两台机器**，和当年的探测套件一样）。

| 文件 | 干什么 |
|---|---|
| `README.md` | 给人看：先决条件、打包分发、跑不过时先看哪几条 |
| `AGENTS.md` | 给目标机器上的 agent 看：§0 安全红线 + 十步逐条的做法、期望、证据 |
| `evidence.mjs` | 证据工具（零依赖）：给「五棵树」拍快照、出 [testing.md §9.3](docs/zh-CN/testing.md) 的表格、`diff`、**`check`（验 I1，退出码非 0 就是最严重那类失败）** |
| `scripts/install-plugin.{sh,ps1}` | 把 `main.js` + `manifest.json` 装进 vault 的插件目录 |
| `templates/record.md` | §9.3 的验收记录模板 |

最短路径：

```bash
npm run verify && npm run build          # 开发机；记下 git rev-parse --short HEAD
tar czf aiss-acceptance.tgz -C tmp acceptance
mkdir -p ~/aiss-handoff && cp main.js manifest.json ~/aiss-handoff/
# 把这两样拷到 Mac 与 Windows，在目标机器上：
#   ./scripts/install-plugin.sh "<vault 绝对路径>" "<产物中转目录>"
#   node evidence.mjs config --vault "<vault 绝对路径>"
# 然后让 agent 读 AGENTS.md 往下走
```

**三个位置别搞混**（README §2.2 有表）：验收套件放 `~/aiss-acceptance/`（别放同步目录里）；
`main.js` + `manifest.json` 先放任意中转目录；**插件的最终位置是
`<vault>/.obsidian/plugins/claudian-session-sync/`，由 `install-plugin` 脚本搬进去，不用手动拷**。

**三个最容易浪费时间的点**（README 里都写了，这里再点一次）：

1. **workspace identity 只在机器 A 创建一次**，B 上手工拷 `<vault>/.claudian-session-sync/workspace.json` 过去。两边各点一次 Create 会生成两个 id、两棵互不可见的子树，而且**不报错**——ADR-20 要防的正是这个。
2. **就绪要等**：READY 需要连续 2 次 pass 且首末跨度 ≥ 90 秒。状态栏停在 `checking folder` 不是错误。
3. **B 上按 ID resume**，不要用 picker（F-1：picker 只列交互式来源的会话，同步过来的看不见）。

跑完把 `out/` 里除 `blobs/` 外的东西拿回来，按 §9.3 合成记录，归档到 `docs/zh-CN/findings/<日期>-m1-acceptance.md`。**`out/blobs/` 是对话原文，只在步骤 8 产生，跑完就删。**

### review/3 整改（2026-08-08）

[review/3](review/3_m1-batch2-batch3-review.md) 报了 1 高、1 中高、1 中和一批覆盖缺口，全部处理完：

| 项 | 处理 | 落点 |
|---|---|---|
| §3.1 高：`*_NEW` 用覆盖式 rename | `FsGateway.writeFileNoReplace`（stage tmp → `link`+`unlink`）；`target-exists` → `ABORTED_PRECONDITION`；无硬链接的文件系统退化前先做存在性检查并在报告标 `noReplaceUnavailable`（ADR-36） | `fs-gateway.ts` / `node-fs-gateway.ts` / `sync-engine.ts`；用例 **R-04b** |
| §3.2 中高：引擎绕过 E1/E2 分级 | P3 接上 `EvidenceCache`。**两侧 E1 命中且 hash 相等 → 不调用 `plan()`，直接 NOOP**——EV-1 由纪律变成控制流（ADR-35）。稳态 pass 现在 0 次全文读 | `sync-engine.ts` P3；用例 `evidence-tiers.test.ts`（含 S-06b / S-07 / X-03 与"伪造 manifest 的上限"） |
| §3.3 中：`sameSignature` 漏 `ino` | 改为复用 `stability.signaturesEqual`，引擎不再自己写一份比较 | `sync-engine.ts` |
| §4.1 U-12b / U-14 / `malformedTail`→Notice | 全部补齐；`truncatedTailPasses` 之前**从不递增**，U-11d 在引擎里根本不可达，已修 | `sync-engine.ts`；用例 U-11d / U-12b / U-14 |
| §4.2 S 编号漂移 | 测试名对齐 testing.md，并在 [testing.md §7.2](docs/zh-CN/testing.md) 加了一张**引擎级覆盖现状表**（含每条未覆盖项的原因） | 各 `tests/m1/*.test.ts` |
| §4.4 §11.2 字段禁令门禁 | 装上了；**第一版是死的**——`expectTypeOf().not.toHaveProperty(name)` 在 `name` 是联合类型时不判别，往 `ActionEntry` 加 `content` 也不红。改成逐条字面量后才真正拦得住 | `tests/m1/pass-report.test.ts` |
| §4.5 type-aware lint | `no-floating-promises` / `await-thenable` / `no-misused-promises` 已开（`projectService`）。虚拟路径的 lint 自检必须关掉这三条——project service 找不到磁盘上的文件会直接 fatal | `eslint.config.mjs` / `tests/build/eslint-rules.test.ts` |

**E1 的两个来源**（架构 §5.3.1 已补）：manifest 管 replica 侧（不可信），本机 `observations.json` 管本机侧（可信）。引擎刻意不区分——两者都只能授权 NOOP，信任度差别不改变它被允许做的事。由此得出恶意 manifest 的上限：它只能伪造一半，最坏结果是"本轮什么都不做"，`evidence-tiers.test.ts` 直接把这条断言了下来（并断言删掉 manifest 触发 T4 全量读后真相会浮出来）。

  **批 3 首批用例认领表**（来自 [review/2](review/2_m1-batch1-domain-review.md) §4，批 1 因分层归属写不了的那些，别漏）：

  | 用例 | 内容 | 状态 |
  |---|---|---|
  | **U-18b 集成形态** | 真实 tmpdir：写 `R0` → 等长 `R1` + `utimes` 还原 mtime → 跑 pass → 必须 `CONFLICT` | ✅ `sync-engine.test.ts` |
  | U-12b 备份断言 | 0 字节被 `PULL_OVERWRITE` 覆盖时，备份区确实有那份 0 字节备份 | ✅ `sync-engine.test.ts`（review/3 §4.1 补齐） |
  | `malformedTail` → Notice | planner 打 flag，报告层要真的渲染成 Notice | ✅ `sync-engine.test.ts` U-11d（连带修了"计数器从不递增"这个使它不可达的 bug） |
  | U-14 | 空目录 → 空 Action 列表，不报错 | ✅ `sync-engine.test.ts` |
  | U-16 / U-17 | `AWAIT_INIT` 零写入；文件数骤降 → `NOT_READY` 且不解释成"远端删了" | ✅ `readiness.test.ts` |
- **批 4 · Obsidian UI** → 真机十步验收（[testing.md §9.4](docs/zh-CN/testing.md)；两台机器的 `~/aiss-probe` 都还留着可复用）

批 1 从 `path-escape` 起步的具体理由：样本表已经全部实测（[testing.md §5.1](docs/zh-CN/testing.md) 12 条 `verified: true`），是唯一一个"输入输出都已知、可以纯表驱动写完"的模块，能顺带把 `tests/m1/` 建起来让 `check:no-skip` 从"M0 空跑"转成真门禁。

`src/main.ts` 仍然只做装配：8 条命令、ribbon、状态栏、设置页、定时 pass，全部转手给 `PluginRuntime`。三条约束别破：

- **`onload()` 不读文件系统**。`getRuntime()` 会 realpath vault 路径，所以设置页拿到的是**取值函数不是实例**；首次 pass 还要经 `setTimeout(…, 0)` 才排出去——从设置面板启用插件时 `onLayoutReady` 是**同步**回调，只"延到 layout-ready"并不够。
- `tests/build/artifact-smoke.test.ts` 的 `EXPECTED_COMMAND_IDS` 是**故意写死的字面量**，增删命令必须同步改。
- 那份 smoke 测试会把 `HOME` 指到临时目录再加载 bundle。别去掉：否则跑一次构建测试就会在开发者家目录里留下 `~/.claudian-session-sync/machine.json`。

## 阻塞项

代码侧无阻塞。唯一挡在 Grok 摘 `experimental` 前面的是**人类动作**（真机九步验收）。

| 项 | 性质 | 说明 |
|---|---|---|
| ~~OQ-15 Grok 两机往返 + G1 充分性~~ | ✅ **关闭（2026-08-26）** | 两机九步验收，G4/G7 双向 resume 历史完整 |
| **OQ-17 Grok 流式期间是否就地改写末行** | 非阻塞 | 验收 F-5：单机也判了 CONFLICT。已排除 Claudian 改写（源码零命中）；表现安全（两分支入隔离、一次点击解决），但说明稳定窗口对「正在出字的会话」偏短 |
| OQ-14 Grok rewind / `/compact` | 非阻塞 | grok 1.0.5 无 headless 入口。风险已封顶：若是截断 ⇒ 判 `CONFLICT`、两侧都留、不丢字节 |
| OQ-16 Grok 稳定窗口实测值 | 非阻塞 | 现有设计按观察判定；要精确值需 5 秒粒度专项探测 |
| ~~OQ-7 规模性能基准~~ | ✅ 关闭（2026-08-13） | 百文件/百 MiB 级：全量 hash 亚秒 |
| OQ-10 漫游 profile | 非阻塞 | `%USERPROFILE%\.claudian-session-sync` 是否被漫游同步 |
| ~~OQ-6 生命周期~~ | ✅ 关闭（2026-08-24） | OpenCode 结构上不可同步；**Grok 已接入**；Pi 两台机器都「装了但无会话」 |
| UNC 路径 | 非阻塞 | 未测（无权限），实测前按不支持处理 |
| `memory/` 子目录归属 | 非阻塞 | 白名单不同步它，记为已知限制（F-7） |
| **Windows 备份路径余量** | 非阻塞（有数字，需盯） | ADR-54 给备份路径加了 `<logicalId>` 一层，**Windows 上少了 37 字符余量**。按你真实 vault 路径实测最深一条（codex `remote/` 备份）= **239/259**，改动前 202。超限失败在安全方向（备份失败 ⇒ 取消覆盖 ⇒ 不丢字节，报告显示 `PATH_TOO_LONG`），但那个文件会停止同步。真撞上的修法：超长时回落到扁平位置（见 architecture §9.3.2 的注） |
| Grok 的 `resources_state.json` / `compaction*` / `plan*` / `terminal` / `web_fetch` | 非阻塞（已知限制） | 真实库里存在但沙箱从未产出，**不在白名单** ⇒ 不同步。刻意的：`announcement_state.json` 已被证明是机器作用域，「未知成员默认跟着走」会把 A 机的指纹移植到 B 机 |

## 交接说明

### 文件地图

```
CLAUDE.md                        产品边界与协作约定（会被 agent 自动注入；不含技术决策——刻意的，见其"文档去处"）
docs/zh-CN/architecture.md       唯一实现规范（normative）。§7.2 决策表、§9 写入安全、ADR 1–34 是核心
docs/zh-CN/testing.md            测试与验收。I1–I4 不变量、U/S/R/SEC 用例表、M0 门禁 §12（§12.7 是落地清单）、真机剧本 §9.4
docs/zh-CN/findings/             真机探测归档：两份原始报告 + spike-conclusions（逐条判定与回填映射）
review/                          第三方审核报告（设计决策的原始依据，已入库）

src/main.ts                      Obsidian 入口，纯装配骨架
scripts/                         构建脚本与五个门禁脚本；门禁都吃 --root 参数，好让自检指向临时目录
  build.mjs                        esbuild → main.js + dist/meta.json（--dev 进 watch）
  lib/gate.mjs                     门禁公共约定：退出码、违规汇总输出、--root/--report 解析
tests/README.md                  哪个目录受哪条门禁约束——加测试前先看这张表
tests/helpers/                   obsidian-stub.ts（记录型 stub）、fast-check.ts（fcAssert + 反例产物）
tests/build/                     脚手架自检：bundle 合同、门禁脚本、lint 规则、覆盖率强制
.github/workflows/ci.yml         三平台 job + nightly property job
.gitattributes                   eol=lf；fixtures 与 *.jsonl 完全不转换

tmp/probe/                       2026-08 的探测套件（gitignore；留作 CLI 大版本升级后的回归复测工具）
tmp/probe-results/               两台真机的原始产物（gitignore；报告已归档进 findings，原始 JSON 快照只在本地）
tmp/acceptance/                  **M1 真机十步验收套件**（gitignore，要手工拷到两台机器）——见上方「真机验收怎么跑」
```

### 必须遵守的约定（写代码时最容易违反的几条）

- **文档去处**：技术决策只写 architecture.md（改动要同步 ADR 表）；CLAUDE.md 不复述技术决策（CI 的 `check:docs` 会挡）
- **⚠️ 的效力**：仍标 ⚠️ 的假设不得作为破坏性写入的依据，依赖它的代码路径保持只读或 dry-run
- **manifest 只能授权 NOOP**（架构 §5.3.2 授权矩阵）；`PlanInput` 类型上不得出现 manifest 派生的 hash 字段。引擎层的形式是：E1 命中走的那条分支**不调用 `plan()`**（ADR-35）——别为了"复用代码"把缓存 hash 塞进 `SideFacts.observedHash`
- **`*_NEW` 只能用 `writeFileNoReplace`**（ADR-36）。它不备份，所以"目标不存在"这个前提出错就是无备份的销毁
- **备份不可关闭**；任何覆盖前必有备份（含 `PUSH_OVERWRITE` 前把远端旧版本存进本机 `backups/remote/`）
- 决策方向只由字节决定，**不读任何时间戳**；时钟只用于本机稳定性观察
- 代码 / 注释 / commit message 用英文；文档与沟通用中文

M0 新增的几条（违反了会在 CI 上以很难懂的方式炸掉）：

- **`package.json` 不写 `"type": "module"`**——Obsidian 按 CJS 加载 `main.js`。仓库工具链靠 `.mjs` / `.mts` 扩展名走 ESM
- **属性测试用 `fcAssert` 而不是 `fc.assert`**（lint 会挡），否则 nightly 失败不留反例产物
- **`domain/` 里不许出现 `RuntimeEnv` 这个标识符**（连类型位置都不行）、不许 `../` 任何路径、不许 `Date.now()` / `Math.random()`；领域层只收 `SystemInfo` 纯数据与 `nowMs`
- **不许 `as SafeAbsolutePath`**——只有 `infra/path-guard.*` 与 `domain/path-safety.*` 能铸造 branded 路径
- **改 `eslint.config.mjs` 时注意 flat config 的规则选项是替换不是合并**：同一个 rule id 在后面的 config 对象里再声明一次，前面的选项整个失效。加规则时把上一档的常量一起带上（`NETWORK_MODULES` / `REQUIRE_NODE_FS_BAN` / `DOMAIN_SYNTAX_RULES`），并让 `eslint-rules.test.ts` 跑一遍
- **tsconfig 的 `include` 不支持花括号展开**（ESLint 的 `files` 支持）。写成 `src/**/*.{ts,mts}` 会让 typecheck 检查空集合并"通过"；`toolchain.test.ts` 就是为此存在的
- **升 TypeScript 前先确认 typescript-eslint 的 peer 范围**（当前 `>=4.8.4 <6.1.0`，所以 TS 停在 5.9.3，不能跳 7.x）
- 加/删命令要同步改 `tests/build/artifact-smoke.test.ts` 的 `EXPECTED_COMMAND_IDS`

### 待做的杂项（非阻塞，顺手时处理）

- macOS 侧 OQ-1 Round 2（Windows 包落到 mac 再验一次反方向）——Windows→mac 方向已验过，此项只是对称补全，优先级低
- 探测套件的三个 F-8 修复（脱敏）已完成并验证；套件如再派发，直接用当前版本
- ✅ **三平台 CI 已全绿**（2026-08-07，run 31186382661）。此前从 M0 起连续 5 次 push 都是 Linux 绿、macOS/Windows 红而没人看——**推完记得看一眼 `gh run list`**，红了五次和红了一次的修复成本差很多
  - 三个 bug 都在测试侧，且**都朝着"看起来成功"的方向失败**：Windows 上 `split(path.sep)` 让四 root 重叠检测变成空转（找不到重叠 = 通过）；`tsc --listFiles` 在 Windows 输出正斜杠而 REPO_ROOT 是反斜杠，于是 toolchain 测试报"tsc 检查了空程序"；macOS 的 `/var` → `/private/var` 让 `resolveUnderRoot` 正确地拒绝了一切（参数就叫 realRoot，测试没给 realpath）
  - 教训已固化：`path-guard` 导出 `splitPathSegments`（两种分隔符都吃），别让每个调用方自己写一个
- 批 4 又红了三次，同一类：**Linux 绿、另外两个平台红，且都朝"看起来成功"的方向失败**。三条已固化的对策——
  - **临时目录必须 realpath**（用 `tests/helpers/fs-cleanup.ts` 的 `makeRealTmpDir`）。裸 `mkdtempSync` 在 macOS 给 `/var/folders/…`（真身是 `/private/var/…`）、在 Windows 给 8.3 短名，两边都会让 `resolveUnderRoot` 判 SYMLINK——看起来像 guard 有 bug。现在 `runWorkspacePass` 的 preflight 会先查一遍并报 `root-not-canonical`，把这一类变成一句话
  - **断言别对 JSON 原文做子串搜索**。Windows 路径在 JSON 里是转义的，`toContain` 会红（吵，但无害），`not.toContain` 会**假绿**——"vault 里不许出现绝对路径"这条正好是后者
  - **`tests/m1/` 里不许 `skipIf`**，`check:no-skip` 会拦。平台条件用例放 `tests/posix/`（testing.md §8.5 早就写了）
- ⚠️ **branch protection 在私有仓库上不生效**：已配 Rulesets，但 GitHub 提示私有仓库需 Team 组织账户才强制执行。在仓库转公开或升级前，**门禁的实际强制点是本地 `npm run verify` + 推完看 `gh run list`**，不是 GitHub

### M1 期间必须补上的门禁欠账

M0 的自检把"门禁本身能不能拦住东西"验完了，但下面几项**要等 M1 有代码/测试之后才能装**，别忘了：

| 项 | 什么时候装 | 说明 |
|---|---|---|
| ~~`check:no-skip --min`~~ | ✅ 已装（`--min 100`，当前 162 条） | 加测试时不必调它；只有**大幅**扩容后才值得提高下限 |
| Q-32 Windows 执行数 ≥ ubuntu 的 95% | M1 收尾 | 目前无任何实现；需要跨 job 比对 `reports/vitest.json` |
| ~~store / 锁 / manifest 的落盘门面~~ | ✅ 批 4a 完成 | S-08/S-16…S-20 现在跑在 `runWorkspacePass` 上 |
| ~~type-aware lint~~ | ✅ 已装 | `no-floating-promises` / `await-thenable` / `no-misused-promises`，靠 `projectService`。`eslint-rules.test.ts` 的虚拟路径必须 override 关掉它们，否则 project service 会 fatal；同文件底部有一条写真文件到 `src/` 再 lint 的自检，证明它真的会红 |
| ~~§11.2 `PassReport` 字段禁令~~ | ✅ 已装 | `tests/m1/pass-report.test.ts`。**逐条字面量写**——循环形式的 `not.toHaveProperty(name)` 永远通过 |
| ~~`src/ui/**` 覆盖率归属~~ | ✅ 已定 | 没有 exclude，改为单独门槛（lines 70 / functions 60 / branches 55），并真写了 `ui.test.ts`。全局门槛没动 |
| `src/ui/**` 覆盖率归属 | 批 4 | 现在 UI 落在全局 80% 门槛下，表现层按 §4 是靠 stub smoke + 人工验收的，落地时要么显式 exclude（照 `main.ts` 的先例）要么补测试——**别顺手调低全局门槛** |
