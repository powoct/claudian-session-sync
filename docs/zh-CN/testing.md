# Claudian Session Sync — 测试策略与验收方法

> **文档状态**：设计稿（pre-implementation）。测试要求先于实现确定，实现时按本文建脚手架。
> **最后更新**：2026-08-06（第 2 版，已吸收 [review/1_architecture-and-testing-review.md](../../review/1_architecture-and-testing-review.md) 的审核意见）
> **配套文档**：[architecture.md](./architecture.md)（系统结构、边界、数据流；与本文冲突时以架构文档为准）

---

## 1. 测试的第一原则

这个插件唯一不可接受的失败是**丢用户的对话记录**。功能不工作，用户骂一句手动拷文件；覆盖错了，几十轮对话没了且不可恢复。

所以测试的组织方式不是"按模块凑覆盖率"，而是**围绕下面这组形式化不变量构建**，任何一条被破坏都是 P0：

| 不变量 | 陈述 | 编码位置 |
|---|---|---|
| **I1 有序字节流可恢复性** | pass 前存在的每个不同文件版本，pass 后要么是某个 live 文件的**字节前缀**（含相等），要么以**完全相同的 hash** 存在于 backup 或 quarantine | `assertRecoverable()`，§1.1 |
| **I2a 无分叉收敛** | 无分叉、因果有序的历史，最终四处 canonical 字节一致，且此后每次 pass 全 `NOOP` | §7.3.1 |
| **I2b 任意历史终态可判定** | 任意历史最终进入 `CONVERGED` 或 `STABLE_CONFLICT`；稳定冲突必须保存**所有极大分支**的 hash，且重复 pass 不产生新的隔离文件 | §7.3.2 |
| **I2c 解决后可收敛** | 显式 resolve 之后 `resolve → flush → pass` 必须恢复 `CONVERGED`，且被放弃的分支仍可恢复 | §7.3.3 |
| **I3 不破坏 resume** | 落地文件对 CLI 仍然可用：字节级完整、无半截记录、不改行尾、不加 BOM、编码不变 | 二进制搬运 + 字节级断言 + §9 真机验收 |
| **I4 不越界** | 一次 pass 期间所有文件系统读写的路径必须落在声明的 root 集合内；异常输入一律 fail closed | `assertNoOutOfScopeIo()`，§8 |

每写一个测试都要能回答："它守的是哪一条？"守不住任何一条、也不是明确的回归防护，就是低价值测试。

### 1.1 I1 的精确形式与断言编码

**为什么废弃"行集合不缩小"**：集合忽略顺序与重复次数。把 `[a,b,c]` 重排成 `[c,b,a]`、把 `[a,a,b]` 去重成 `[a,b]`，"行集合"都没缩小，但 session 已经损坏且 CLI 无法 resume。jsonl 的语义是**有序字节流**，不变量必须建立在字节上。

```ts
type Sha256 = `sha256:${string}`;
type Loc = `${MachineName}:${"local" | "replica" | "backup" | "backup-remote" | "quarantine"}:${string}`;

interface Version { hash: Sha256; size: number; read(): Buffer; }

interface WorldSnapshot {
  /** CLI 与插件都可见的现役文件：本机 provider 目录 + 本机看到的 sync replica */
  live: Map<Loc, Version>;
  /** 归档：backup 区（含 remote/ 子目录）+ quarantine 区 */
  archive: Map<Loc, Version>;
}

export function assertRecoverable(before: WorldSnapshot, after: WorldSnapshot): void {
  const versions = new Map<Sha256, { origin: Loc; v: Version }>();
  for (const [loc, v] of before.live) if (!versions.has(v.hash)) versions.set(v.hash, { origin: loc, v });

  const liveAfter = [...after.live.values()];
  const archiveAfter = [...after.archive.values()];
  const failures: RecoveryFailure[] = [];

  for (const [hash, { origin, v }] of versions) {
    const bytes = v.read();
    // 条件 1：某个 live 文件以 v 的完整字节为前缀（允许相等）
    const survivesAsPrefix = liveAfter.some(w => w.size >= v.size && w.read().subarray(0, v.size).equals(bytes));
    // 条件 2：v 的完整字节仍在 archive 中且 hash 一致（字节级复核，不只信 hash）
    const survivesInArchive = archiveAfter.some(a => a.hash === hash && a.size === v.size && a.read().equals(bytes));
    if (!survivesAsPrefix && !survivesInArchive)
      failures.push({ origin, hash, size: v.size, nearestLive: diagnose(bytes, liveAfter) });
  }
  if (failures.length) throw new Error(formatRecoveryFailures(failures, before, after));
}
```

要点：

- **必须是字节前缀，不是行前缀**。行级比较会放过"最后一行被改写但行数不变"这类损坏。
- **允许相等**（`w.size >= v.size`）：NOOP 与幂等重跑不应违反 I1。
- 失败信息必须打印 `nearestLive`（最长公共前缀字节数 + 首个分歧字节的偏移与上下文），否则 property test 失败时无法定位。
- `read()` 全读只在测试规模成立；property test 里单文件上限 256 KB，由 world 的 `maxSyntheticFileBytes` 强制。
- `archive` 必须包含 `backups/<ws>/<provider>/remote/`（[架构 §9.3.2](./architecture.md)）——`PUSH_OVERWRITE` 被覆盖的远端版本存在那里，它是 I1 在 push 方向上唯一的退路。

### 1.2 I1 的三条附则

| 附则 | 陈述 | 断言 |
|---|---|---|
| **I1-a 覆盖必有备份** | `PassReport` 里每个 `*_OVERWRITE`，必须能在 backup 区找到 hash 等于**覆盖前**目标文件 hash 的条目，且 Action 上带 `backupPath` | `assertEveryOverwriteBacked(report, after)` |
| **I1-b 冲突时两侧 primary 冻结** | 判为 `CONFLICT` 的 logicalId，两台机器的 local 与 replica primary 文件字节在 pass 前后**完全不变** | `assertConflictFrozen(before, after, logicalId)` |
| **I1-c 隔离不改变 inventory** | 生成隔离副本的 pass，前后版本 hash inventory 必须满足 `inventory(after) ⊇ inventory(before)`，新增 hash 只能来自 quarantine 复制 | `assertInventoryPreserved(before, after)` |

```ts
const inventoryOf = (s: WorldSnapshot): Set<Sha256> =>
  new Set([...s.live.values(), ...s.archive.values()].map(v => v.hash));

export function assertInventoryPreserved(before: WorldSnapshot, after: WorldSnapshot): void {
  const missing = [...inventoryOf(before)].filter(h => !inventoryOf(after).has(h));
  // 允许消失的唯一情形：该版本是某个 after.live 文件的严格前缀（被合法延长了）
  const illegal = missing.filter(h => !isPrefixOfSomeLive(h, before, after));
  expect(illegal, "隔离/合并过程中有版本从世界上消失").toEqual([]);
}
```

**"冲突隔离"不是 I1 的例外**：隔离动作本身要满足 I1——被复制进 quarantine 的版本必须与源字节完全一致，且源不得被删除。

### 1.3 I1 对备份轮转的约束

`keep = 3` 的轮转会**删除**备份版本，这是插件唯一主动销毁字节的地方，因此必须受 I1 管辖（对应[架构 §9.3.3](./architecture.md)）：

> 删除某个备份版本 `b` 之前，必须验证 `b` 仍可由某个 live 文件按前缀规则恢复。不满足时**跳过本次轮转**（保留超额备份），并在 `PassReport` 里记 `backup-rotation-deferred`。

L1 用例：`keep=3`，第 4 份写入时最旧一份是"当前 live 文件的严格前缀" → 正常删除；构造一份**不是任何 live 文件前缀**的旧备份（分叉后被放弃的分支）→ 断言它**不被删除**且报告出现 `backup-rotation-deferred`。

---

## 2. 测试分层

```
L3  真机跨平台验收    Mac ↔ Windows 真实 CLI resume     人工，每个里程碑一轮，归档
L2  双机模拟          双 replica + 可编程 transport      自动，最有价值的一层
L1  文件系统集成      真实 tmpdir + 真实 rename/mtime    自动
L0  纯函数单测        Planner / MergePolicy / Stability / PathSafety   自动，穷举决策表
```

**投入分配**：L0 约 40%、L2 约 35%、L1 约 20%、L3 约 5%（但 L3 是唯一能证明"真的能 resume"的一层，不能省）。

### 2.1 为什么 L2 是重点

单元测试证明"决策表实现对了"，真机验收证明"整体能用"，中间有一大片真实缺陷区：文件在两台机器之间来回搬 5 轮后是否还收敛？pull 到一半崩了下次能不能自愈？manifest 先到而 session 后到会不会误判？这些只有 L2 能覆盖，而且它跑得快、可在 CI 里跑几百个随机场景。

### 2.2 为什么默认用真实 tmpdir 而不是 memfs

`rename` 覆盖语义、mtime 精度、大小写敏感性、权限错误——恰恰是本插件最容易出问题的地方，而内存文件系统对它们的模拟都不可信。因此：**默认真实临时目录**（`fs.mkdtemp`，测试结束清理）；**例外**是错误注入用 `FsGateway` 装饰器（§6），而不是换文件系统实现。

### 2.3 安全测试组不是新的一层

§8 横跨 L0（路径与标识符解析的纯函数）与 L1（真实 fs 上的 symlink / junction / 权限 / 保留名）。单独成节是因为它有统一的断言基础设施（`assertNoOutOfScopeIo`、sentinel 扫描）和统一的判定原则（**fail closed**），按分层打散会丢掉这个整体性。

### 2.4 L2 的传输必须是双 replica

原方案让两台机器共用一个 `syncDir`，这时 `transport.flush()` 没有任何真实语义——文件本来就"已经在对面了"，延迟、乱序、截断全都无法表达。新模型见 §7.1。

---

## 3. 可测试性对实现的硬性要求

这些不是"建议"，是让上述分层与不变量能成立的前提（对应[架构 §4.1](./architecture.md) 与 [§6.2](./architecture.md)）：

1. `domain/` 下任何文件不得 import `obsidian` / `fs` / `path` / `os`。`domain/path-safety.ts` 的字符串校验自己 `split("/")`，不借 `path`。CI 用 ESLint `no-restricted-imports` 强制。
2. **所有环境依赖经单一入口 `RuntimeEnv` 注入**：`sys`（`SystemInfo`：platform / homedir / hostname / 路径长度上限）、`fs`、`clock`、`ids`、`log`、`machine`、`paths`。测试只需要一个 `makeTestEnv(overrides)` 工厂。
3. **领域层允许持有 `SystemInfo`（纯数据快照）与 `nowMs: number` 参数，但不得持有 `RuntimeEnv` 本身**（lint 规则：`domain/` 禁止出现标识符 `RuntimeEnv`）。
4. 所有文件系统访问经 `FsGateway`；所有时间读取经 `Clock`；所有随机与 UUID 经 `IdGen`（测试可固定）。
5. **`FsGateway` 的写方法只接受 branded 的 `SafeAbsolutePath`**。"忘了校验路径"必须是编译错误——typecheck 因此成为安全门禁的一部分。
6. **`PlanInput` 中不得存在任何 manifest 派生的 hash 字段**。Planner 只接受"本次实际观察到的文件事实"——实现为 `SideFacts`：`observedHash` / `size` / `stable` / `tail` / `isPlaceholder`（`observedHash` 这个命名承担了全部说明责任：它只能是本次读到的字节的 hash）。唯一例外是布尔量 `remoteHadNonZeroSize`（由 manifest 的 size 历史派生，[架构 §5.3.2 规则 EV-1](./architecture.md)），它被隔离在 `PlanInput.hints: DeferOnlyHints` 里，且该对象**只装 manifest 派生值**——本机 ledger 的观察计数（如 `truncatedTailPasses`）住在另一个字段 `history: LocalHistory`。两者影响决策的方式相同（只能推向更保守），但来源一个是别的机器写的不可信文本、一个是本机事实，混在一起迟早会有人把远端字符串喂进稳定性判定。这是用类型系统消灭[审核 4.2](../../review/1_architecture-and-testing-review.md) 那一类 bug 的唯一可靠办法——反例见 §5.2.5 U-18。
7. **`SyncEngine` 在每个关键点调用 `await this.barrier(point, ctx)`**（`point` 取自 §7.4 的枚举）。生产实现是同步返回的 no-op；没有这组 barrier，竞态与崩溃点测试无法编写。
8. **`FsGateway` 可被装饰以记录全部调用**（方法名 + resolved 绝对路径 + 读/写）。这是 I4 越界断言与 dry-run 无写入断言的基础。
9. **`SyncEngine` 不得有 catch-all**。测试注入的 `CrashSignal`（不继承 `Error` 的特殊对象）必须能穿透到测试代码；单 action 的可捕获错误只能针对**已知 errno 集合**捕获。
10. 三处状态（vault / home / sync-dir，[架构 §5.6](./architecture.md)）各自由独立的 store 读写，测试可分别指向不同 tmpdir，从而能构造"data.json 同步过去了但 home 没有"这类真实场景。
11. `SyncEngine.runPass()` 返回结构化 `PassReport`（每个 Action + 决策依据四元组 + 结果 + `violations[]` + 每个 overwrite 的 `backupPath`），测试断言这个对象，而不是解析日志。
12. **`PassReport` 及其嵌套类型不得声明任何承载文件内容的字段**（`content` / `buffer` / `bytes` / `lines: string[]` / `sample` / `head` / `tail`）——内容安全的类型级防线（[架构 §11.2](./architecture.md)）。
13. `Logger` 的签名为 `(code: string, fields: Record<string, string | number | boolean>)`，不接受自由文本模板。
14. 所有用户可见副作用（Notice / 状态栏 / 报告）经 `Reporter` 接口，测试可断言消息内容。

---

## 4. 工具链

| 用途 | 选型 | 说明 |
|---|---|---|
| 测试运行器 | **vitest** | 与 esbuild/TS 生态一致，watch 快，内置 coverage |
| 属性测试 | **fast-check** | I1/I2a/I2b/I2c 与 round-trip 不变量 |
| 类型断言 | `expectTypeOf`（vitest 内置） | U-18a 之类的类型级安全断言 |
| 类型检查 | `tsc --noEmit` | CI 必跑，是安全门禁的一部分（要求 5） |
| 构建校验 | `esbuild --metafile` | 产出 `main.js` + `dist/meta.json`，供 §12.2 的 bundle 合同测试 |
| Obsidian API | 手写最小 stub（`tests/helpers/obsidian-stub.ts`） | 只 stub 实际用到的部分，并记录所有注册调用供断言 |

不引入 E2E 框架跑真实 Obsidian——收益低、维护重。表现层靠 §12.2 的 stub smoke 与人工验收。

---

## 5. L0 纯函数单测

### 5.1 路径转义（`providers/claude-code/path-escape.ts`）

**规则已三平台实证 ✅**（OQ-3，2026-08-06；原始样本见 [findings](./findings/2026-08-06-spike-conclusions.md)）：`escape(p) = realpath(p) 逐字符映射`，保留 `[A-Za-z0-9-]`，其余任何字符各替换为一个 `-`。

已验证样本（全部进 `path-escape-cases.json` 且 `verified: true`）：

| 输入路径（= realpath） | 目录名 | 平台 |
|---|---|---|
| `/home/code-server/projects/claudian-session-sync` | `-home-code-server-projects-claudian-session-sync` | Linux ✅ |
| `/Users/<u>/aiss-probe/plain` | `-Users-<u>-aiss-probe-plain` | macOS ✅ |
| `/Users/<u>/aiss-probe/with space` | `-Users-<u>-aiss-probe-with-space` | macOS ✅ |
| `/Users/<u>/aiss-probe/my.vault` | `-Users-<u>-aiss-probe-my-vault` | macOS ✅ |
| `/Users/<u>/aiss-probe/中文目录` | `-Users-<u>-aiss-probe-----`（每个非 ASCII → 一个 `-`） | macOS ✅ |
| `/Users/<u>/aiss-probe/a_b (c)` | `-Users-<u>-aiss-probe-a-b--c-` | macOS ✅ |
| `/Users/<u>/aiss-probe/UPPER-Case` | `-Users-<u>-aiss-probe-UPPER-Case`（大小写保留） | macOS ✅ |
| `/tmp/aiss-probe-outside` | `-private-tmp-aiss-probe-outside`（**realpath 证据**） | macOS ✅ |
| `C:\Users\<u>\aiss-probe\plain` | `C--Users-<u>-aiss-probe-plain` | Windows ✅ |
| `C:\Users\<u>\aiss-probe\my.vault` | `C--Users-<u>-aiss-probe-my-vault` | Windows ✅ |
| `C:\Users\<u>\aiss-probe\中文目录` | `C--Users-<u>-aiss-probe-----` | Windows ✅ |
| `D:\aiss-probe\plain` | `D--aiss-probe-plain` | Windows ✅ |

另两条**行为**样本（测 realpath，不是测字符映射，单独建用例）：symlink 目录里开会话落进 realpath 对应目录、不产生新目录（macOS ✅）；小写盘符 / 正斜杠拼写归一化到磁盘真实大小写、不产生新目录（Windows ✅）。UNC ⚠️ 未测——**不进样本表**，UNC vault 按不支持处理（`parseNeutralRel` 与 root 校验本来就拒 UNC）。

必须覆盖（表驱动，样本表 `tests/fixtures/path-escape-cases.json`）：

- POSIX：普通路径、含空格、含 `.`（如 `/Users/ct/my.vault`）、含连字符、含中文、结尾带 `/`
- Windows：盘符大小写、`\` 与 `/` 混用、UNC `\\server\share\vault`、驱动器根 `C:\`
- **幂等性表述统一为"第二次调用必须拒绝"**：`escape()` 只接受绝对路径，`escape(escape(p))` 的第二次输入是目录名（非绝对路径），必须抛 `InvalidInputError`，**不得返回任何字符串**。
  ```ts
  expect(() => escape(escape("/Users/ct/vault"))).toThrow(InvalidInputError);
  ```
  原文"既要求幂等、又要求非绝对路径抛错"自相矛盾。二者只能取一，"拒绝"严格更安全——它让"把已转义的名字再喂一次"这个真实 bug 在第一次发生时就炸掉，而不是静默产出一个看起来正确的目录名，进而往错误目录写用户对话。
- **反转义只做诊断**：`unescape()` 对 `-` 的歧义（原本是 `/` 还是 `.`）必须返回 `{ certain: false, candidates: [...] }`，而不是猜一个字符串；用 `expectTypeOf` 断言其返回类型**不能**直接赋给落位函数的参数类型。

> ✅ OQ-3 已实测，上表全部条目 `verified: true, source: "measured"`，**`EXPECTED_UNVERIFIED = 0` 从 M0 起即可成立**。机制保留（`verified` 字段 + `EXPECTED_UNVERIFIED` meta 测试），供未来 CLI 版本变更或新 provider 的未验证样本使用。

### 5.2 决策表（`domain/planner.ts`）

> 用例编号与[架构 §7.2](./architecture.md) 的决策表对应。Action 名称以架构为准，用例语义不变。

#### 5.2.1 基础逐格

| 用例 | L（本机） | R（sync replica） | 期望 Action | 守护 |
|---|---|---|---|---|
| U-01 | 100 行 | 不存在 | `PUSH_NEW` | — |
| U-02 | 不存在 | 100 行 | `PULL_NEW` | — |
| U-03 | 100 行 | 同内容 100 行 | `NOOP` | I2a |
| U-04 | 120 行（前 100 行字节 == R） | 100 行 | `PUSH_OVERWRITE` | — |
| U-05 | 100 行 | 120 行（前 100 行字节 == L） | `PULL_OVERWRITE` | — |
| U-06 | 100 行 | 100 行，第 50 行不同 | `CONFLICT` | **I1** |
| **U-07** | **108 行**（第 5 行后分叉） | **115 行**（第 5 行后分叉） | `CONFLICT` | **I1（核心用例 1/2）** |
| U-08 | 100 行，观察到不稳定 | 120 行 | `DEFER` | I1 |
| U-09 | 120 行 | 100 行，观察到不稳定 | `DEFER` | I1 |
| U-10 | 25 MB | 不存在 | `SKIP_TOO_LARGE` | — |
| U-13 | 100 行 | 100 行，且对应的确定性隔离目录已存在 | `NOOP` | 防重复堆积 |
| U-14 | 空目录 | 空目录 | 空 Action 列表，不报错 | — |

**U-07 与 U-18 是这个项目最重要的两条测试**。U-07 守的是"行数多的赢"退化成丢数据的具体形态（[ADR-3](./architecture.md)）；U-18 守的是"用缓存 hash 做覆盖决定"的具体形态。有人为了"简化"删掉前缀校验或重新引入 manifest hash 时，必须是这两条先红。

#### 5.2.2 尾行完整性（U-11）

**合法 JSON 文本可以没有末尾 LF**，把"无末尾换行"直接等同于"不完整"会把正常文件永久 DEFER。分档（对应[架构 §7.4.1](./architecture.md)）：

| 用例 | 末行状态 | 稳定性 | 期望 |
|---|---|---|---|
| U-11a | 可 `JSON.parse` 且是 object，无末尾 LF，首次观察 | 未稳定 | `DEFER` |
| U-11b | 同上，连续两次观察签名不变 | 稳定 | `complete-no-lf`，全部字节参与比较，正常决策 |
| U-11c | `JSON.parse` 失败（半截行） | 任意 | `truncated` → `DEFER`；比较时丢弃末段，**该侧禁止作为覆盖源** |
| U-11d | 同 U-11c 且连续 5 次 pass 都失败 | 稳定的坏文件 | 报告 `MALFORMED_TAIL` + Notice，仍不覆盖任何一方（不是 DEFER 死循环，要让用户看见） |

#### 5.2.3 0 字节文件（U-12）

原 testing.md 判 `PULL_NEW`、原 architecture.md 判"一律跳过"，两者冲突。裁决：**0 字节从来不是"不存在"**——它是任意字节串的合法前缀，因此走 OVERWRITE 分支；但在稳定之前一律保守。

| 用例 | L | R | 期望 | 理由 |
|---|---|---|---|---|
| U-12a | 0 字节，首次观察 | 100 行 | `DEFER` | 可能是传输中/占位符/CLI 刚创建 |
| U-12b | 0 字节，稳定 | 100 行 | `PULL_OVERWRITE`，**且断言备份区存在那份 0 字节备份** | 规则不开洞：0 字节也要备份 |
| U-12c | 100 行 | 0 字节，首次观察 | `DEFER`，**绝不 PUSH_OVERWRITE** | R 极可能正在传输 |
| U-12d | 100 行 | 0 字节，稳定，manifest 无 `size>0` 历史 | `PUSH_OVERWRITE`，且 R 的 0 字节版本进 `backups/remote/` | 统一规则 |
| U-12e | 100 行 | 0 字节，稳定，**manifest 记录过 `size>0`** | `DEFER` + `remoteRegression`，并喂给就绪状态机 | 远端退化是同步工具异常的强信号 |
| U-12f | 0 字节 | 0 字节 | `NOOP_EMPTY` + 报告列出 | 无信息可搬 |
| U-12g | **0 字节**，稳定 | 不存在 | `SKIP_EMPTY` | 不把空文件推上远端（= 架构 #10） |
| U-12h | 100 行 | 0 字节且带云端占位符标记 | `SKIP_PLACEHOLDER` + Notice 指引"始终保留在此设备" | 对齐 OQ-4 |

与架构决策表的映射：U-12a↔#12、U-12b↔#11、U-12c↔#16、U-12d↔#13、U-12e↔#14、U-12f↔#15、U-12g↔#10；**U-12h 不在 #10–16 内**，它走优先级 4（云端占位符）。

另加一条纯逻辑断言：**0 字节文件永不产出 `CONFLICT`**（对全部组合成立）。

#### 5.2.4 远端就绪（对应[架构 §9.6](./architecture.md)）

| 用例 | 前置 | 期望 |
|---|---|---|
| U-15 | 本机记录 remote 曾成功初始化，但本次 `root.json` 缺失 | 整个 pass `NOT_READY`：所有 Action 降级为 `SKIP_REMOTE_NOT_READY`，**一次 push 都不发生**，状态栏黄标 |
| U-16 | 本机无初始化记录且 sync-dir 完全为空 | 进入 `AWAIT_INIT`：对 sync-dir 零写入（连 `root.json` 也不写）、对本机 provider 目录零写入，设置面板出现初始化按钮 |
| U-17 | workspace 子树文件数从 40 骤降到 2 | `NOT_READY`，禁止 push，且**不得**把"远端没有"解释成"远端删了" |
| U-18r | `root.json` 的 `formatVersion` 高于本插件支持 | 完全只读 + Notice 提示升级，**不写任何东西**（含 manifest） |
| U-19 | `rootId` 与本机记录不符 | `NOT_READY`，且**不自动恢复**（必须用户确认） |

**U-15 / U-17 是防"云盘目录已创建但未水合 → 插件把本机全量当新文件推上去 → 与对端真实内容打架"的唯一防线**，必须在 M1 就有。

#### 5.2.5 同 size 同 mtime 内容不同（U-18）

> **与 U-07 并列为项目最重要的测试。**

复现路径：manifest 缓存了远端 `R0` 的 hash → 外部同步工具以**相同 size、相同 mtime** 的发散内容 `R1` 替换该文件 → 本机 `L` 是 `R0` 的延长版 → 若 Planner 复用缓存 hash，会误以为 `R1` 仍是 `L` 的前缀 → `PUSH_OVERWRITE` 静默吞掉 `R1`。分三层守：

| 用例 | 层 | 构造 | 断言 |
|---|---|---|---|
| **U-18a** | L0 类型级 | 尝试给 `PlanInput` 传 manifest 派生的 hash | `expectTypeOf<PlanInput>().not.toHaveProperty("manifestHash")`；typecheck 阶段失败 |
| **U-18b** | L1/L2 | 真实 tmpdir：写 `R0` → 记 `size/mtimeMs` → 写等长的 `R1` → `fs.utimes` 还原 mtime → 跑 pass | Action 必须是 `CONFLICT`；`R0`/`R1`/`L` 三个 hash 全在 inventory；`R1` 字节在 replica 或 quarantine 完好 |
| **U-18c** | scrub | 让某 entry 连续 `NOOP` 超过 scrub 阈值（`FakeClock` 推进或 T6 抽样） | 断言该次 pass **确实重新读了文件内容**（`FsGateway` 调用记录里出现该路径的 `readStream`），并记 `scrubMismatch` |

```ts
const st = await fs.stat(p);
await fs.writeFile(p, r1Bytes);           // 与 r0Bytes 等长、内容不同
await fs.utimes(p, st.atime, st.mtime);   // 还原 mtime
const st2 = await fs.stat(p);
expect(st2.size).toBe(st.size);
expect(st2.mtimeMs).toBe(st.mtimeMs);     // 不能精确还原的平台改用 FakeFsGateway 伪造 stat
```

#### 5.2.6 冲突终态与自愈（对应[架构 §8.1](./architecture.md)）

| 用例 | 前置 | 期望 |
|---|---|---|
| U-20 | 已产生冲突并生成隔离副本，**然后删掉整个 manifest** | 后续 pass 仍判 `NOOP`（靠 `(logicalId, hashL, hashR)` 派生的确定性隔离路径已存在来识别），**不新增隔离文件** |
| U-21 | 冲突后用户手工把两侧改成相同内容（或一侧成为另一侧的严格前缀） | 冲突状态**自动解除**（新 conflictId 算不出来），正常 `NOOP` / `*_OVERWRITE` |
| U-22 | 冲突后用户执行 `Keep local` | 本机版本上行；被放弃的远端版本仍在 `backups/remote/` 与 quarantine 可恢复 |
| U-23 | 外部同步工具的冲突副本（`*.sync-conflict-*.jsonl` 等） | **复制/记录后忽略**：不当作 session、不落地、**不删除也不移动源文件** |

#### 5.2.7 全组合穷举与优先级

逐格用例只覆盖对角线，真实 bug 在组合处。用笛卡尔积生成全部条件组合：

```ts
const dims = {
  remote:   ["ready", "not-ready", "unsupported-format"] as const,
  lExists:  [true, false],
  rExists:  [true, false],
  relation: ["equal", "l-extends-r", "r-extends-l", "divergent", "n/a"] as const,
  lStable:  [true, false],
  rStable:  [true, false],
  size:     ["ok", "l-too-large", "r-too-large"] as const,
  zeroByte: ["none", "l-zero", "r-zero", "both-zero"] as const,
  tail:     ["lf", "no-lf", "truncated"] as const,
  conflictKnown: [true, false],
};
// 过滤掉不可能的组合（如 !lExists && relation !== "n/a"）后逐个跑 planner
```

对每个组合断言三件事：

1. **恰好产出一个 Action**（不是 0 个、不是 2 个）。
2. **绝不出现"用一个非前缀的版本覆盖另一方"**：若 `relation === "divergent"`，Action ∉ {`PUSH_OVERWRITE`, `PULL_OVERWRITE`}。这条是纯安全断言，与优先级无关，必须对**全部**组合成立。
3. 结果与[架构 §7.2](./architecture.md) 的优先级表一致（1 格式版本 → 2 就绪 → 3 体积 → 4 占位符 → 5 稳定性 → 6 已知冲突 → 7 hash 相同 → 8 发散 → 9 前缀 → 10 单侧存在）。

三条显式回归（写成独立 `it()`，最容易被优先级重构搞错）：

- 不稳定 + 发散 → `DEFER`（**不是** `CONFLICT`）：不稳定的观察不足以断言发散
- 超大 + 发散 → `SKIP_TOO_LARGE`（**不是** `CONFLICT`）：没读全文就不该下发散结论
- `NOT_READY` + 本机有新 session → `SKIP_REMOTE_NOT_READY`（**不是** `PUSH_NEW`）
- **快速通道**：`!lExists && rExists && !rStable` 且满足[架构 §9.1.3](./architecture.md) 全部条件 → `PULL_NEW`（**唯一**允许 unstable 产出写动作的格子，是优先级 5 的显式例外，写成独立 `it()`）

### 5.3 前缀与尾段（`domain/merge-policy.ts`）

- 完全相同 / 一方为空 / 严格前缀 / 首行即不同 / 仅最后一行不同
- **行尾差异 `\n` vs `\r\n` 必须判为不同**（不做归一化——归一化就改了字节，违反 I3）
- 末尾有无换行符的两个文件：`complete-no-lf` 与 `lf-terminated` 之间是严格前缀关系，走正常 OVERWRITE 收敛
- `isPrefix` 在 short 末字节不是 LF 时返回 `not-line-aligned`；首个差异字节 offset 被正确记录
- 含 Unicode（emoji、CJK、代理对）内容的行
- `tailState()` 三态判定：空末段 / 可 parse 的 object / 不可 parse；顶层标量（`123`）不应被误判为 object
- **删除**原"checkpoint 加速路径与全文比较路径结果必须一致"——M1 无 checkpoint 路径（[架构 §7.4](./architecture.md)）

### 5.4 manifest（`domain/manifest.ts`）

测试目标只有一个：**证明它永远不能成为破坏性决定的依据**。

| 用例 | 输入 | 期望 |
|---|---|---|
| M-01 | 正常 manifest | round-trip 语义等价 |
| M-02 | 截断 JSON / 空文件 / 非 JSON / 非对象根 | `{ status: "rebuild" }`，不抛未捕获异常 |
| **M-03** | **`schemaVersion` 高于当前支持** | `{ usable: false, writable: false, reason: "newer-schema" }` → 本次 pass **仍可搬文件**（全量扫描），但**断言 manifest 文件字节完全未变**。旧客户端绝不能重建覆盖新格式 |
| M-04 | `schemaVersion` 低于当前 | `{ status: "migrate" }`；迁移幂等（跑两次结果相同） |
| M-05 | 未知顶层字段 / 未知 entry 字段 | 读 → 改一个 entry → 写之后未知字段仍在（前向兼容） |
| M-06 | entry key 非法（`..`、绝对路径、workspaceId 不匹配） | **只丢弃该 entry**，其余可用，报告列出被丢弃的 key |
| M-07 | E0 全等命中（size/mtime/ctime/ino/tailHash） | 只允许影响两个决定："要不要重新 hash"、以及"远端 0 字节是否降级为 `DEFER`"（`remoteHadNonZeroSize`）；`PlanInput` 上不存在任何 manifest 派生的 **hash** 字段（配合 U-18a） |
| M-08 | 连续 `NOOP` 超过 scrub 阈值 | 强制全量 rehash（配合 U-18c） |

### 5.5 稳定性判定（`domain/stability.ts`）

纯函数，输入 `(观察历史, 本机 nowMs, 阈值)`，输出 `stable | unstable` + 原因：

- 签名相同但 ledger 时长不足 → unstable
- 签名不同 → unstable 并重置 `firstSeenMs`
- **未来 mtime**（`mtime > now + 容差`）→ 剔除 mtime 分量后仍能判 stable，报告标 `futureMtime`，**不得永久 DEFER**
- **负 age**、时钟回拨 → 同上
- **粗粒度时间戳**（1 s / 2 s 精度）：mtime 相同但 size 或 tailHash 变化 → 必须判为变化
- `touch`（mtime 变、size/tail 不变）→ 保守视为变化
- ledger 缺失 → 一律 unstable（fail-safe，对应[架构 §5.5](./architecture.md)）

---

## 6. L1 文件系统集成测试

跑在真实 tmpdir 上，验证 infra 层。

| 用例 | 断言 |
|---|---|
| 原子写正常路径 | 目标内容正确；临时文件已消失 |
| 原子写中途失败（写完 tmp 抛错） | 目标文件**保持原样**；tmp 被清理 |
| rename 遇 `EPERM`（模拟 Windows 占用） | 退避重试 3 次；仍失败则报错且目标未被破坏；**绝不出现"先删后写"** |
| `ENOSPC` | 报错、原文件完好、备份保留 |
| 只读目录 | 报错信息可读，pass 继续处理其他文件 |
| 备份命名 | stamp 格式 `YYYYMMDDTHHMMSS-mmmZ` 不含 `:`；同毫秒碰撞时 `seq` 递增；字典序 == 时间序 |
| 备份轮转 keep=3 | 第 4 份写入后最旧一份被删；**受 I1 约束**（§1.3）：非前缀的旧备份不被删除并记 `backup-rotation-deferred` |
| 备份失败 | 覆盖操作取消（断言目标文件未变），整个 group 取消 |
| `backups/remote/` | `PUSH_OVERWRITE` 前远端旧版本被完整复制到该目录，hash 一致 |
| preflight 清理 | 只删"位于写入目录内 ∧ 名字精确匹配 ∧ lstat 是普通文件 ∧ mtime > 1 h"的残留；四条缺一不可（各构造一个反例断言不被删） |
| 大文件流式统计 | 20 MB 文件的 `lineCount`/`hash`/`tailState` 正确且峰值内存有界 |
| 忽略名单 | `.syncthing.*`、`*.partial`、`* (conflicted copy 1).jsonl` 等不被当作 session |
| 锁 epoch | 抢占陈旧锁后，**原持有者的写必须被拒**（写前重新校验 epoch） |

错误注入方式：`FaultyFsGateway` 装饰真实 gateway，按"第 N 次调用某方法"注入指定 errno。不换文件系统实现。

---

## 7. L2 双机模拟测试（重点）

### 7.1 world 模型：双 replica + 可编程 transport

```text
A.local  <->  A.replica  <--[transport 事件队列]-->  B.replica  <->  B.local
 (CLI)      (机器 A 看到的 sync-dir)              (机器 B 看到的 sync-dir)   (CLI)
```

四个位置全部是**真实 tmpdir 子树**，`flush` 用真实文件复制实现（可控制 mtime）。这样 `rename` 语义、大小写敏感性、权限都仍然真实，只有"传输"是被程序控制的。

```ts
export interface World {
  readonly transport: Transport;
  machine(name: MachineName, opts?: MachineOptions): Machine;
  snapshot(): Promise<WorldSnapshot>;              // §1.1 的四位置 + 归档全量快照
  quarantineListing(): Promise<QuarantineListing>;
  advanceClockAll(ms: number): void;
  readonly recorder: Recorder;                     // 记录观察过的版本、外部覆盖事件
  dispose(): Promise<void>;                        // 支持 `await using`
}

export interface MachineOptions {
  platform: "darwin" | "win32" | "linux";
  vault: string;                                   // 本机 vault 绝对路径（fake，仅参与转义）
  homedir?: string;
  clockSkewMs?: number;                            // 相对 world 时钟的偏移
  workspaceId?: string;
  supportedFormatVersion?: number;                 // X-01 用
  supportedSchemaVersion?: number;                 // X-03 用
  settings?: Partial<PortableSettings>;
}

export interface Machine {
  readonly name: MachineName;
  readonly localRoot: string; readonly replicaRoot: string; readonly backupRoot: string;
  readonly cli: FakeCli;
  pass(opts?: { dryRun?: boolean }): Promise<PassReport>;
  passWithHooks(hooks: Partial<PassHooks>): Promise<PassReport>;
  crashDuringPass(at: HookPoint, opts?: { nth?: number }): Promise<CrashOutcome>;
  restart(): Promise<void>;                        // 丢弃进程内状态（锁、缓存），模拟 Obsidian 重启
  advanceClock(ms: number): void;
  resolveConflict(logicalId: string, keep: "local" | "remote"): Promise<void>;
  lastReport(): PassReport;
}

export interface FakeCli {
  startSession(id: string): FakeSession;
  session(id: string): FakeSession;
  list(): string[];                                // 模拟 CLI 扫目录能看到哪些 session（守 I3 的可见性）
}

export interface FakeSession {
  append(lines: number, opts?: { tail?: "lf" | "no-lf" | "half-line" }): this;
  appendRaw(bytes: Buffer): this;
  truncateTo(lines: number): this;
  hold(): OpenHandle;                              // 保持写句柄打开（POSIX rename 后写旧 inode 的场景）
  bytes(): Buffer; hash(): Sha256; lineCount(): number;
}
```

**Transport** 必须能独立控制：两个方向、按 kind（`session` / `manifest` / `meta` / `quarantine`）选择性投递、mtime 策略（`preserve` / `rewrite-now` / `future` / 固定值）、`truncateBytes` 截断、以同步工具临时名或冲突副本名落地、0 字节占位符、`delayPasses` 延迟、`times` 重复投递、`reorder` / `drop` / `partition` / `deleteAt` / `inject`。

`InjectSpec` 支持 `raw` / `truncated` / `zero-byte` / `placeholder` / `symlink` / `junction`（非 Windows 自动降级为 symlink 目录）/ `conflict-copy`。

**断言 helper**：

```ts
assertCanonicalConverged(w, logicalId, opts?)   // 无冲突时比较四个位置的 canonical 字节
assertBranchesPreserved(w, logicalId, hashes)   // 有冲突时比较分支 hash inventory 的超集关系
assertRecoverable(before, after)                // §1.1
assertInventoryPreserved(before, after)         // §1.2
assertConflictFrozen(before, after, logicalId)  // §1.2
assertEveryOverwriteBacked(report, after)       // §1.2
assertQuarantineStable(a, b)                    // 隔离目录文件名 + hash 在多次 pass 间完全一致
assertNoOutOfScopeIo(w, fn)                     // I4
assertNoWrites(w, fn, allow?)                   // dry-run
```

用法示例：

```ts
it("S-01 · A 写 → 同步 → B 读 → B 续写 → 同步 → A 读", async () => {
  await using w = await makeWorld({ seed: 1 });
  const A = w.machine("A", { platform: "darwin", vault: "/Users/testuser/vault" });
  const B = w.machine("B", { platform: "win32",  vault: "C:\\Users\\testuser\\vault" });

  A.cli.startSession("s1").append(20);
  w.advanceClockAll(60_000);                       // 越过稳定窗口
  await A.pass();                                  // A.local -> A.replica
  await w.transport.flush({ dir: "A->B" });        // A.replica -> B.replica
  await B.pass();                                  // B.replica -> B.local

  expect(B.cli.session("s1").lineCount()).toBe(20);
  expect(B.cli.list()).toContain("s1");            // CLI 真的能看见（I3）

  B.cli.session("s1").append(10);
  w.advanceClockAll(60_000);
  await B.pass();
  await w.transport.flush({ dir: "B->A" });
  await A.pass();

  await assertCanonicalConverged(w, "s1");
});
```

### 7.2 必测场景

| # | 场景 | 断言 | 里程碑 |
|---|---|---|---|
| S-01 | A 写 → 同步 → B 读 → B 续写 → 同步 → A 读 | 四处 canonical 一致；B 的 `cli.list()` 能看见 | M1 |
| S-02 | A 与 B 交替续写 5 轮（每轮完整 handover） | 全程无 CONFLICT，最终收敛（I2a） | M1 |
| S-03 | A、B 从同一基线各自分叉 | `CONFLICT`；**两侧 primary 字节都未变**（I1-b）；两分支 hash 都在 inventory（I1-c） | M1 |
| S-04 | S-03 之后再跑 3 轮 | `assertQuarantineStable`：隔离文件名与 hash 完全不变 | M1 |
| S-04b | S-03 之后**删掉两侧 manifest**，再跑 3 轮 | 行为与 S-04 **完全一致**（冲突状态不依赖 manifest） | M1 |
| S-04c | S-03 之后 `resolveConflict("s1","local")` → flush → pass | 恢复收敛（I2c）；被放弃分支仍在 backup/quarantine 可恢复 | M1 |
| S-05 | pass 期间 CLI 仍在写（观察不稳定） | 该文件 `DEFER`；下一次 pass 正常处理 | M1 |
| S-06 | 传输延迟：A push 后 B 连跑 3 次 pass 才拿到 | 无副作用；拿到后正常落地 | M1 |
| S-06b | **manifest 先到、session 后到**（反向亦然） | 不因 manifest 做任何破坏性动作（断言无 `*_OVERWRITE`）；session 到达后正常收敛 | M1 |
| S-06c | 乱序 + 重复投递同一文件 3 次 | 结果与投递一次相同 | M1 |
| S-07 | replica 里 manifest 被删 | 自动重建，结果与未删时**逐字节一致** | M1 |
| S-08 | replica 不可达（chmod 000 或改名） | pass 失败但**本机文件零改动**；`assertNoWrites` 对本机 provider 目录成立 | M1 |
| S-09a | apply 阶段**可捕获**的单 action 失败（第 3 个 `EACCES`） | 前 2 个已落地；manifest 只记成功项；报告列失败项；重跑补齐（= R-12） | M1 |
| S-09b | apply 阶段**真崩溃** | commit 未执行；`restart()` 后靠真实文件重建，与正常路径逐字节收敛（= R-13） | M1 |
| S-10 | 一对 replica 服务两个 workspace | 互不干扰；`assertNoOutOfScopeIo` 证明没读到另一个 workspace 子树 | M1 |
| S-11 | B 上该 provider 未安装 | 跳过并报告，其他 provider 正常 | M1 |
| S-12 | 传输中文件被截断 | 末段不可解析 → `DEFER` + 告警；**不覆盖本机好文件**；恢复完整投递后收敛 | M1 |
| S-13 | 外部工具生成 `sync-conflict` / `conflicted copy` | 记录后忽略，不当 session、不落地、**不删除也不移动源文件** | M1 |
| S-14 | 时钟差 2 小时 + `mtime: "future"` 投递 | 见下方 S-14 三条子用例 | M1 |
| S-15 | A 删除某 session 文件 | 下次 pass 从 replica 拉回（M1–M2 不做删除传播），报告中说明 | M1 |
| S-16 | 首次连接一个**空的** sync-dir | 进入 `AWAIT_INIT`：对 sync-dir **零写入**（连 `root.json` 也不写）、对本机 provider 目录零写入；仅允许写本机 `observations.json`。用户点初始化后走 `PROBING → READY` | M1 |
| S-17 | 远端 workspace 子树被外部工具清空 | `NOT_READY`：不 push、不把本机当"新文件"重推；本机零改动 | M1 |
| S-18 | S-17 之后文件数恢复 | 连续 `probes` 次后自动回 `READY`，并触发一次全量 scrub | M1 |
| S-19 | `rootId` 变化 | `NOT_READY` 且**不自动恢复**，必须用户确认 | M1 |
| S-20 | `observations.json` 丢失 | 本次 pass 退化为只读观察：对**本机 provider 目录、replica 全树、备份区**零写入；`observations.json` 本身按[架构 §7.1 P8](./architecture.md) 被重建（这是下一轮能恢复的前提）；下一次 pass 恢复正常 | M1 |
| S-21 | ~~一侧 compact 产生新 logicalId~~ **已退役**：OQ-8 实测 compact/fork 均为**同文件追加**、不产生新 logicalId（PASS，非 D1），该场景在实测版本上不存在。保留编号防错引 | —（退役） |
| S-22 | opaque-file：两侧同一 aux 内容不同 | `CONFLICT`；两侧原文件字节均未变；各留隔离副本；重复 pass 不新增 | M2 |
| S-23 | `derived` 文件在两机不同 | 每轮 Action 恒为 `REBUILD_LOCAL`（**不是** `NOOP`）；该文件**从未出现在 replica 中**；本机文件未被改写（M1 无 derived provider；adapter 重建为空操作时断言 `report.changed === 0`） | M2 |
| S-24 | session group：required aux 写入失败（注入 `EACCES`） | **primary 未落地**，session 对 CLI 不可见；已 rename 的 aux 保留；staging 残留；下次 pass 完整补齐 | M2 |
| S-25 | session group：commit 阶段在 primary rename 前崩溃 | 同 S-24 终态；重跑后 group 完整且 hash 正确 | M2 |
| S-26 | Tier B：文件已落地、`reconcileLocalIndex` 抛错 | pending journal 有该条目；下次 pass 自动重试并成功；连续 5 次失败后条目**仍在**且出现在报告中 | M2 |
| S-27 | Tier B：连续调用 `reconcileLocalIndex` 两次 | 第二次 `report.changed === 0`（幂等） | M2 |
| S-28 | replica 里出现 `<uuid>-DESKTOP-ABC.jsonl` | 归类为 `UNKNOWN_FILE`（不匹配 `logicalIdPattern`）；**不落地、不删除、不移动**；报告列出 | M1 |
| S-29 | replica 里出现合法 UUID 名但内容是垃圾的 `.jsonl` | 白名单通过 → 走决策表；末段不完整 → `DEFER`；**不得 crash** | M1 |
| S-30 | 1000 个候选 + `maxFilesPerPass = 50`，连跑 25 次 pass | 每个候选**至少被处理一次**，且首次被处理的轮次 ≤ `ceil(1000/50) = 20`（正是[架构 §12.2](./architecture.md) 的公平性陈述）；不存在"处理过一次之后再也不被处理"的饥饿 | M1 |
| S-30b | 50 个候选 + `maxFilesPerPass = 5` + `starvationPasses = 5` | 饥饿提升生效：任一候选的 `skippedForBudgetPasses` 峰值 ≤ `starvationPasses + ceil(K / retryBudget)` | M1 |
| X-01 | A 支持 `formatVersion=1`、B 支持 `=2`（B 已升级布局） | A 进入**完全只读**：replica 与 A 本机字节零改动 + Notice；B 正常；A 升级后能读到 B 期间产生的全部 session | M2 |
| X-02 | 迁移中途崩溃（`migration` 已写、文件未搬完） | 重跑迁移收敛到同一结果；恢复点存在；无 session 丢失 | M2 |
| X-03 | manifest `schemaVersion` 高于本插件 | 文件仍正常搬运（全量扫描）；**manifest 文件字节未变**（与 L0 的 M-03 是同一语义的两层，故同属 M1） | M1 |

#### M1 引擎级覆盖现状（批 3 收尾，2026-08-08）

`describe` 名字里的编号就是本表的编号——**测试名与本表不一致视为缺陷**（review/3 §4.2 的教训：编号漂移让"S 矩阵已覆盖"无法被第三方核对）。

| 编号 | 状态 | 落点 |
|---|---|---|
| S-01 / S-02 / S-03 | ✅ | `sync-engine.test.ts`（S-03 兼 U-07） |
| S-04 / S-04b | ✅ | `quarantine.test.ts` |
| S-05 | ✅ | `sync-engine.test.ts`（外部工具重写后先复观察再信任） |
| S-06 / S-06c | ✅ | `sync-engine.test.ts` |
| S-06b / S-07 | ✅ | `evidence-tiers.test.ts` |
| S-09b | ✅ | `crash-points.test.ts`（R-06） |
| S-12 | ✅ | `sync-engine.test.ts`（含"补齐后收敛"下半场） |
| X-03 | ✅ | `evidence-tiers.test.ts`（引擎级）+ `manifest.test.ts` M-03（L0） |
| U-11d / U-12b / U-12c / U-14 | ✅ | `sync-engine.test.ts` |
| U-16 / U-17 | ✅ | `readiness.test.ts` |
| U-18b / R-01 / R-04b / R-05 / R-06 / R-09 / R-10 | ✅ | `sync-engine.test.ts` / `crash-points.test.ts` / `lock.test.ts` |
| S-08 / S-16 / S-17 / S-18 / S-19 / S-20 | ✅ | `wired-pass.test.ts`——跑真实组合根 `runWorkspacePass`，状态全部落盘 |
| R-10 落盘形态 | ✅ | `lock.test.ts` 尾部：两实例共用一个锁文件，含陈旧抢占与 epoch 失效 |
| S-04c | ✅ | `conflict-commands.test.ts`——三种解决方式各一条，且都断言"没被选中的那支仍然可达" |
| UI 层（设置面板 / 报告 / 冲突面板） | ✅ | `ui.test.ts`——经 vitest alias 把 `obsidian` 指向 stub；断言的是"每一次拒绝都带着理由到达屏幕"，不是渲染出了节点 |
| 组合根（首次运行三步、机器身份、设置钳制） | ✅ | `plugin-runtime.test.ts` |
| §8.6 dry-run 五棵树零变化（ADR-27） | ✅ | `plugin-runtime.test.ts`——真机验收脚本写到步骤 1 时才发现当时还不成立：可写探测与就绪记录都在 dry-run 里写了 |
| S-09a / R-12 | ⏳ 批 4 | 需要 `FaultyFsGateway`（按 errno 注入单文件失败） |
| S-10 | ⏳ 批 4 | 需要 world 支持一对 replica 服务两个 workspace |
| S-11 | ⏳ 批 4 | 需要第二个 adapter 替身；另注：当前 `healthCheck` 把"项目目录不存在"当作 provider 不可用，而这恰恰是**新机器该拉取**的情形，接组合根时一并校正 |
| S-13 / S-28 / S-29 | ⏳ 批 4 | `classifyFileName` 的 L0 覆盖已全，缺引擎级"记录后忽略且不动源文件"的端到端断言 |
| S-14a/b/c / S-15 / S-30 / S-30b | ⏳ M1 收尾 | 时钟差、删除不传播、公平性与饥饿提升 |
| R-02 / R-03 / R-07 / R-08 / R-11 / R-13 | ⏳ M1 收尾 | 竞态矩阵的后半段；R-08 的残余窗口断言尤其要按"不断言无损"的口径写 |
| S-21 | — | 已退役（OQ-8 实测） |
| S-22…S-27 / X-01 / X-02 / R-14 | — | M2 |

#### S-14：时钟差的正确断言

原断言"两小时时钟差下决策结果**完全一致**"与"活跃判定依赖 `now - mtime`"自相矛盾。改为：

> **内容方向的决策**（`PUSH_*` / `PULL_*` / `CONFLICT` / `NOOP`）不依赖任何绝对时钟；**时序类降级**（`DEFER`）允许因时钟差而不同，但只能沿"更保守"方向变化——时钟差只能把 Action 变成 `DEFER`，不能把 `DEFER` 变成覆盖，也不能改变覆盖方向。

| 用例 | 构造 | 断言 |
|---|---|---|
| S-14a | 同一场景跑两遍：无时差 vs B 时钟 +2h | 两次的**内容方向决策序列**相同（把 `DEFER` 归一化后比较） |
| S-14b | 投递时 `mtime: "future"`（超前 2h，`now - mtime < 0`） | **不得**因负 age 而无限 `DEFER`；replica 侧稳定性必须用本机观察账本而非文件 mtime 年龄 |
| S-14c | 投递时 `mtime: { fixedMs: 0 }`（极旧）+ 内容仍在变化 | 不得因"看起来很旧"就当稳定文件覆盖对方；连续两次观察签名不同 → 仍 `DEFER` |

### 7.3 属性测试（fast-check）

四组 property，分文件放 `tests/m1/property/`。**每一步 mutation 都套 I1**：

```ts
export async function step(w: World, fn: () => Promise<unknown>, opts?: { external?: boolean }) {
  const before = await w.snapshot();
  await fn();
  const after = await w.snapshot();
  if (opts?.external) {
    // transport 覆盖 replica 是外部同步工具的行为，不受 I1 管辖；但要记账，供 I2b 豁免
    w.recorder.noteExternalOverwrite(before, after);
  } else {
    assertRecoverable(before, after);
    assertInventoryPreserved(before, after);
  }
}

/** 反复跑回合直到不动点 */
export async function driveToFixedPoint(w: World, maxRounds = 8): Promise<Terminal> {
  let prev = await w.quarantineListing();
  for (let i = 0; i < maxRounds; i++) {
    const reports = await round(w);                       // 双向各 push/pull 一轮
    const now = await w.quarantineListing();
    const allNoop = reports.every(r => r.actions.every(a => a.kind === "NOOP" && !a.conflictKnown));
    const stable = sameListing(prev, now);
    if (allNoop && stable) return { kind: "CONVERGED", rounds: i + 1 };
    if (stable && reports.every(r => r.actions.every(a => a.kind === "NOOP")))   // 其中至少一条带 conflictKnown
      return { kind: "STABLE_CONFLICT", rounds: i + 1, listing: now };
    prev = now;
  }
  throw new Error("未在 maxRounds 内到达不动点");           // 不收敛本身就是 bug
}
```

#### 7.3.1 I2a · 无分叉、因果有序历史

生成器只产生 `append`，且每次换机器前先 `handOver()`（跑完整回合并断言此时没有冲突——若有，说明生成器破坏了因果序，直接失败而不是静默跳过）。断言：`driveToFixedPoint()` 返回 `CONVERGED`；四处 canonical 字节一致；再跑两轮 Action 必须全是 `NOOP`。

#### 7.3.2 I2b · 任意历史

操作生成器：`append` / `pass` / `flush(方向, 选择器)` / `partition(on/off)` / `tick(1s | 45s | 2h)`，长度 5–60。终态前必须恢复连通。断言：

1. 终态 ∈ {`CONVERGED`, `STABLE_CONFLICT`}
2. `CONVERGED` → 四处 canonical 一致
3. `STABLE_CONFLICT` → **所有极大分支**都仍可恢复，且再跑 3 轮 `assertQuarantineStable`

> `recorder.maximalBranches(logicalId)` 的定义（写在 helper 里，不散在测试中）：所有在某台机器上作为 live primary 出现过的版本中，**不是任何其他观察版本的严格字节前缀**、且**未被 transport 的 last-writer-wins 外部覆盖**的那些版本的 hash 集合。这个定义把"外部同步工具自己丢的数据"排除在插件责任之外，同时不给插件任何逃逸口。

#### 7.3.3 I2c · 显式解决后恢复收敛

构造稳定冲突 → `resolveConflict(keep)` → `driveToFixedPoint()` 必须返回 `CONVERGED`，且**被放弃的那一支仍在 backup 或 quarantine 里字节完好**。对 `keep = local | remote` × `resolver = A | B` 四种组合都跑。

#### 7.3.4 转换 round-trip

```
∀ buf:  fromNeutral(toNeutral(buf)) 字节等于 buf
∀ buf:  toNeutral(fromNeutral(buf)) 字节等于 buf
∀ buf:  toNeutral_A(buf) 字节等于 toNeutral_B(buf)      // 两台不同 platform/vault 的 ctx
```

M1 的 transform 是 identity，这组测试当下平凡——但它必须**先存在**，将来有人为 OQ-1 引入 `cwd` 改写时，一旦破坏可逆性立刻红（[架构 §7.3](./architecture.md)）。

#### 7.3.5 seed 与规模

| 环境 | `numRuns` | seed |
|---|---|---|
| 本地 / PR CI | 200 | 固定（`SEED = 20260806`），保证可复现 |
| nightly | 5000 | 随机，失败时把 seed / path / 最小反例落成 artifact（§12.5） |

### 7.4 竞态与崩溃点矩阵

原 S-05 只覆盖"扫描前就已经活跃"的文件，随机操作也完全串行，掩盖了本插件最危险的一类 bug：**观察与写入之间世界变了**。

```ts
export type HookPoint =
  | "after-stat-before-hash"          // 拿到 stat、还没读内容
  | "during-hash"                     // 每读 chunkSize 字节回调一次
  | "during-copy"                     // 写 staging 的过程中
  | "after-backup-before-rename"      // 备份已落盘，还没替换目标
  | "after-rename-before-commit"      // 目标已替换，manifest 还没写
  | "after-commit-before-reconcile"   // manifest 已写，provider index 还没重建（Tier B）
  | "before-release-lock";
```

`machine.crashDuringPass(point)` 在该点抛 `CrashSignal`（不继承 `Error`，任何 `catch (e: Error)` 都拦不住），并让 world 丢弃该 engine 实例——commit 阶段永远不会执行。

| # | 注入点 | 注入动作 | 期望 | 里程碑 |
|---|---|---|---|---|
| R-01 | `after-stat-before-hash` | 本机 CLI 追加 5 行 | 该文件 `DEFER`，或 apply 前复查发现变化 → 取消。本机字节 == 追加后内容（I1） | M1 |
| R-02 | `during-hash` | 本机 CLI 追加 5 行 | hash 对应某个一致快照；O3/O5 复查失败 → 取消。**绝不产生 `PUSH_OVERWRITE`** | M1 |
| R-03 | `during-copy`（pull 写 staging 中） | 本机 CLI 追加 5 行 | 取消 action，清 staging；本机保留 CLI 内容；replica 未变 | M1 |
| R-04 | `after-backup-before-rename` | 本机 CLI 追加 5 行 | `ABORTED_PRECONDITION`；tmp 清理；备份保留（多余但无害）；本机文件 == CLI 最新内容 | M1 |
| R-05 | `after-backup-before-rename` | `crashDuringPass` | 目标未被替换；`restart()` 后下次 pass 正常处理；preflight 清 tmp | M1 |
| R-06 | `after-rename-before-commit` | `crashDuringPass` | 目标已替换但 manifest 未提交；`restart()` 后靠**真实文件**重建，与正常路径**逐字节收敛**；不产生重复隔离副本 | M1 |
| R-07 | `after-rename-before-commit` | transport 此刻投递新版本到 replica | 下次 pass 用真实文件重新判定；不因 manifest/内存状态陈旧而覆盖新版本 | M1 |
| R-08 | rename 时目标被 CLI 持有写句柄（`session.hold()`） | — | POSIX：落地后 `stat` 与写入不符 → 记 `postCheckMismatch` + Notice，rename 时刻的内容在 backup 中可恢复（这是**已声明的残余窗口**，不断言无损）。Windows：`EPERM` → 退避 3 次后跳过，目标未被破坏 | M1 |
| R-09 | 两个 `runPass()` 真正重叠（同一 engine） | — | 第二个立即返回 `ALREADY_RUNNING`，**零写入**；写调用计数 == 单次 pass | M1 |
| R-10 | 两个 engine 实例争锁（两个 Obsidian 窗口） | — | 只有一个拿到锁，另一个报 `LOCK_HELD`；陈旧锁可抢占；**抢占后原持有者的写必须被拒**（epoch 校验） | M1 |
| R-11 | 两台机器真正重叠（交错 pass 后同时 flush，last-writer-wins） | — | 最坏结果是 `CONFLICT` 或后写者赢；**任何一个极大分支都不得从 inventory 消失**——被覆盖的远端版本必须在覆盖方的 `backups/remote/`。这是[架构 §9.4.3](./architecture.md) 保证声明的可执行版本 | M1 |
| R-12 | apply 中第 3 个文件 `EACCES`（可捕获） | — | 前 2 个落地；manifest 只记成功项；报告列失败项；重跑补齐 | M1 |
| R-13 | apply 中第 3 个文件真崩溃 | — | commit 不执行；`restart()` 后从真实文件重建；最终收敛 | M1 |
| R-14 | `after-commit-before-reconcile` | `crashDuringPass` | 文件已落地但 provider index 未更新 → 重启后 `reconcileLocalIndex()` **仍会被调用**（不能因为文件是 `NOOP` 就跳过） | **M2** |

**R-14 归 M2 的理由**：M1 只有 Claude Code（**Tier A 候选**，按 Tier A 语义实现），本机没有任何外部索引需要 reconcile，这个注入点在 M1 的代码里根本不存在。矩阵保留该行，测试文件放 `tests/m2/`，不计入 M1 的 no-skip 门禁。

**S-09 的拆分**（两件性质完全不同的事）：

| 类型 | 语义 | 手段 | 期望 |
|---|---|---|---|
| 可捕获的单 action 失败（R-12） | engine 仍在跑，错误被针对已知 errno 捕获 | `FaultyFsGateway` 注入 | 其他文件继续；**commit 仍执行**，只记成功项 |
| 真正的进程崩溃（R-13） | engine 消失，commit 永不执行 | `CrashSignal` + 丢弃实例 + `restart()` | manifest 停在崩溃前状态；重启靠真实文件重建；不得依赖任何进程内状态 |

崩溃类用例必须断言 `restart()` 之后的结果与"从未崩溃"的对照组**逐字节一致**（跑一遍对照 world 做 golden）。

---

## 8. 安全与不可信输入测试组

sync-dir 的内容由外部同步工具搬运，插件对它没有任何控制权；**adapter 自身也可能因 CLI 结构变化而产出垃圾**。统一判定原则是 **fail closed**。

所有用例默认套 `assertNoOutOfScopeIo(w, fn)`：`FsGateway` 装饰器记录每次调用的 resolved 绝对路径，测试结束断言全部落在 allowlist roots 内。**发生一次越界读写就是 P0**，哪怕结果"看起来正确"。

### 8.1 路径解析纯函数（L0）

表驱动，全部期望 **reject** 且返回结构化 `reason`（不是抛裸异常）：

| 组 | 输入样例 | reason |
|---|---|---|
| 穿越 | `..`、`a/../../b`、`./../x`、`a/./../..` | `TRAVERSAL` |
| 绝对路径 | `/etc/passwd`、`\etc\passwd` | `ABSOLUTE` |
| 盘符 | `C:\Windows\x`、`C:x`（盘符相对）、`c:/x` | `DRIVE_LETTER` |
| UNC | `\\server\share\x`、`//server/share/x` | `UNC` |
| 分隔符 | 任何含 `\` 的输入（POSIX 上 `\` 是合法文件名字符，但跨平台语义不一致，**统一拒绝**） | `BACKSLASH_IN_REL` |
| 控制字符 | 含 `\0`、`\r`、`\n`、`\x01`–`\x1f` | `NUL_OR_CONTROL` |
| 空段/点段 | 空串、`a//b`、`a/`、`/`、`.`、`a/.` | `EMPTY_SEGMENT` / `DOT_SEGMENT` |
| Windows 保留名 | `CON`、`con`、`Con`、`CON.jsonl`、`NUL`、`AUX`、`PRN`、`COM1`–`COM9`、`LPT1`–`LPT9` | `RESERVED_NAME` |
| 尾随点/空格 | `a.`、`a `、`a. `、`dir /file` | `TRAILING_DOT_OR_SPACE` |
| 8.3 短名 | `PROGRA~1`、`ABCDEF~2.JSO` | `SHORTNAME_LIKE` |
| 长度 | 单段 > 255 字节、总长 > 200 | `SEGMENT_TOO_LONG` / `PATH_TOO_LONG` |
| 非 ASCII / 不可见 | 含 CJK、emoji、U+202E（RTL override）、U+200B | `SEGMENT_CHARSET`（中立层要求 NFC + ASCII） |
| 大小写碰撞 | 同目录下 `s1.jsonl` 与 `S1.jsonl` 同时存在 | 不 reject，但必须**检出并报告** `CASE_COLLISION`，两者都不落地 |
| Unicode 规范化 | 同名的 NFC 与 NFD 两份 | `NORMALIZATION_COLLISION`，都不落地 |

正向用例（必须 accept）：`abc.jsonl`、`a/b/c.jsonl`、含 `-` 与 `_` 的 UUID 文件名、以 `-` 开头的本机目录名（Claude Code 形态）。

### 8.2 标识符校验（L0）

| 标识符 | 规则 | 拒绝样例 |
|---|---|---|
| `workspaceId` / `machineId` | 严格小写 UUID v4 正则（**不做 toLowerCase 容错**） | 大写形式、带空格、`..`、超长、空串 |
| `logicalId` | 单段 + 匹配 provider 的 `logicalIdPattern`；不匹配 → **不当作 session**，记 `UNKNOWN_FILE`，不报错 | `../x`、`a/b`、`CON`、含 `\0` |
| `customDirName` | 单段，过 §8.1 全部规则 | 含分隔符、保留名、尾随点 |
| manifest entry key | 必须能解析成 `<workspaceId>/<provider>/<safeRel>` 且 workspaceId 与当前一致 | 其余**只丢弃该 entry**（M-06） |

**恶意 adapter 用例（关键）**：fixture 提供一个返回恶意 `neutralRel` 的 adapter：

```ts
const evilAdapter: ProviderAdapter = {
  ...baseAdapter,
  listSessions: async () => [{
    logicalId: "evil",
    files: [{ role: "primary", absPath: "…", neutralRel: "../../../.claude/.credentials.json", mode: "append-jsonl" }],
    lastModifiedMs: 0,
  }],
};
```

断言：engine 拒绝该 session、把该 adapter 标为 `unhealthy`、报告出现 `TRAVERSAL`，且 `assertNoOutOfScopeIo` 成立。**engine 不得信任 adapter 的输出**——adapter 是插件自己的代码，但版本容错意味着它可能因 CLI 结构变化而产出垃圾。

### 8.3 链接与 containment（L1，真实 fs）

| 用例 | 构造 | 期望 |
|---|---|---|
| SEC-01 | replica 里 `<sid>.jsonl` 是指向 `~/.claude/.credentials.json` 的 symlink | `lstat` 检出 → **拒绝，不解引用、不复制内容**；报告 `SYMLINK` |
| SEC-02 | 本机 session 目录里的 `<sid>.jsonl` 是 symlink | push 时同样拒绝，不跟随 |
| SEC-03 | replica 里 `<workspaceId>/claude-code` 整个是指向 vault 的 symlink 目录 | 逐级 `lstat` 检出 → 拒绝整棵子树 |
| SEC-04 | Windows junction / reparse point 指向 `%USERPROFILE%` | 同 SEC-03。**OQ-9 已实证 ✅**：`lstat().isSymbolicLink()` 对 junction（`mklink /J` 与 `fs.symlink(target, path, "junction")` 两种构造）都返回 true，因此断言直接用 lstat，无需 reparse tag 探测；非 Windows 用 symlink 目录代替并标注。**另注**：`realpath` 不展开 8.3 短名，字符串层的 `SHORTNAME_LIKE` 拒绝是唯一防线（见 §8.1） |
| SEC-05 | 本机 session 文件与凭证文件是**硬链接**（同 inode） | `nlink > 1` → 拒绝 push + 报 `HARDLINK_SUSPECT`；备份必须用 **copy 而非 link**，断言备份文件 inode 与源不同 |
| SEC-06 | 路径中间某级在 stat 之后被换成 symlink（TOCTOU） | 写入用 `O_NOFOLLOW`（POSIX）/ 打开后复核 `fstat` 的 dev+ino，不匹配则中止 |

**四 root 重叠矩阵**：`syncDir` / `providerLocalRoot` / `backupDir` / `vaultPath` 两两（6 组）× 四种关系（equal / ancestor / descendant / 经 symlink 等价）= **24 个用例**，全部断言 preflight 返回 `ROOT_OVERLAP` 且 **pass 完全不执行**（`assertNoWrites`）。"symlink 等价"用 `realpath` 检出：两个不同字符串路径指向同一物理目录也必须被拒。

### 8.4 凭证与敏感内容排除

| 用例 | 构造 | 断言 |
|---|---|---|
| SEC-10 | fakeHome 的 `~/.claude/.credentials.json` 内容含 `sk-TESTSENTINEL-0000` | (a) `FsGateway` 调用记录里**没有对该路径的读调用**；(b) 两个 replica 的全部字节不含该 sentinel；(c) backup / quarantine / tmp 中不含 |
| SEC-11 | session 内容含 `AISS-SENTINEL-…` / `sk-live-…` / `ghp_…` / 假 home 路径 `/Users/testuser/secret-vault` | 跑一次同时包含 `PUSH_NEW` / `PULL_OVERWRITE` / `CONFLICT` / 注入错误 / `PathViolation` 的 pass，断言 `JSON.stringify(passReport)`、`logLevel=debug` 的日志全文、**所有 Notice 文案**均不含任何 sentinel；但日志里应有 hash 前 8 位、行数等诊断信息。**CI 必跑，不允许 `.skip`** |
| SEC-12 | 名单内文件（`auth.json`、`*.sqlite`、`*-wal` 等）放进 replica 的 workspace 子树 | 不当作 session、不落地本机、报告列出 `DENYLISTED` |
| SEC-13 | 跑完整 L2 套件后递归读取所有 tmpdir 内容 | 不存在任何 sentinel 泄漏路径（`afterAll` 全局检查，成本低收益高） |

### 8.5 权限

| 用例 | 断言 | 平台 |
|---|---|---|
| SEC-20 | 落地文件 `mode & 0o777 === 0o600`（不放宽） | POSIX |
| SEC-21 | tmp 用 `O_CREAT \| O_EXCL, 0o600` 创建；同名已存在 → 报错而不是覆盖 | 全平台 |
| SEC-22 | backup 目录 `0700`、backup 文件 `0600`；quarantine 同；**`logs/` `0700`、日志文件 `0600`** | POSIX |
| SEC-23 | **`umask 0000` 下重跑 SEC-20/21/22**：证明代码显式设了权限，而不是碰巧靠 umask | POSIX |
| SEC-24 | 落地文件不带只读属性（否则 CLI 无法追加） | Windows |

**Windows 上不做 mode 断言**（放 `tests/posix/` 目录以避开 no-skip 门禁）。Node 在 Windows 上 `mode` 只有只读位有意义，真实权限由 ACL 继承自父目录；用 `chmod` 语义写的断言只会永远为真或永远为假，没有信息量。M1 不做 ACL 编程，README 说明"sync-dir 与 backup 目录的访问控制由用户负责"。

### 8.6 dry-run 无写入

```ts
it("dry-run 期间不得有任何写调用", async () => {
  await using w = await makeWorld();
  /* …制造一批待办 Action、tmp 残留、待 pull 的新文件、一个 CONFLICT、一个 PathViolation… */
  const before = await w.snapshot();
  await assertNoWrites(w, () => w.machine("A").pass({ dryRun: true }), { tmpCleanup: false });
  expect(await w.snapshot()).toEqual(before);   // 五棵树逐字节不变
});
```

五棵树 = 本机 provider root / replica 全树（含 `.aiss/`、`.quarantine/`）/ backup 区（含 `index.jsonl`）/ vault 内 `.claudian-session-sync/**` 与 `data.json` / 本机状态目录。比较维度：文件全集 + size + mtimeMs + sha256（不比较 atime），排除日志树。

场景至少覆盖：workspace 未初始化（断言只报 `WORKSPACE_NOT_INITIALIZED` 并列出将创建什么）、有 tmp 残留（断言**不清理**）、有待 pull 的新文件、有 CONFLICT、有 `PathViolation`、machineId 身份漂移（断言不写盘、只在报告里标注）。

---

## 9. L3 真机跨平台验收

自动化测试证明不了"CLI 真的能 resume"。每个里程碑跑一轮人工验收，结果归档到 `docs/zh-CN/findings/acceptance-<里程碑>-<日期>.md`。

### 9.1 通过标准

原文一处说"步骤 4、6、8、9 全部达成"即通过，另一处 Exit Criteria 又要求"剧本通过"。**统一为：M1 的十个步骤全部必过，无例外。** 被"豁免"的六步恰好覆盖 dry-run 安全性、路径转义正确性、启动同步、manifest 归属——每一条失败都意味着 M1 的某个承诺不成立。

### 9.2 证据规范

`wc -l` 不能证明 I3（行数相同、字节不同的文件照样 resume 失败）。**每一步的每个被关注文件，证据必须包含下列全部字段**，用统一脚本采集（跨平台，Windows 上没有 `sha256sum` / `wc`）：

```js
// scripts/evidence.mjs —— node scripts/evidence.mjs <file>...
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

const rows = process.argv.slice(2).map((p) => {
  const b = readFileSync(p), st = statSync(p);
  const records = b.toString("utf8").split("\n").filter((s) => s.length > 0);
  const parseFailures = [];
  records.forEach((s, i) => { try { JSON.parse(s); } catch { parseFailures.push(i + 1); } });
  return {
    path: p,
    sha256: "sha256:" + createHash("sha256").update(b).digest("hex"),
    bytes: b.length,
    records: records.length,
    trailingNewline: b.length > 0 && b[b.length - 1] === 0x0a,
    parseFailures,
    allRecordsParsed: parseFailures.length === 0,
    mtimeIso: st.mtime.toISOString(),
  };
});
console.log(JSON.stringify(rows, null, 2));
// 另外输出一张可直接粘进验收记录的 Markdown 表
```

### 9.3 验收记录模板

```markdown
# M1 真机验收记录 · <日期>

## 环境版本（缺一项即视为记录不完整）

| 项 | 机器 A | 机器 B |
|---|---|---|
| 操作系统与版本 | macOS 15.x (arm64) | Windows 11 26xxx |
| Claude Code 版本 | | |
| Obsidian 版本 | | |
| Claudian 版本 | | |
| 本插件 commit | | |
| 同步工具与版本 | | |
| 同步工具配置 | 版本控制策略、冲突策略、是否"始终保留在此设备" | |
| vault 绝对路径 | `/Users/…/vault` | `C:\Users\…\vault` |
| 转义后的项目目录名 | `-Users-…-vault` | `C--Users-…-vault` |
| workspaceId | | （必须与 A 相同） |
| machineId | | （必须与 A 不同） |

## 逐步记录

### 步骤 N · <操作>
- 期望：<从 §9.4 抄>
- 结果：通过 / 失败
- 证据（`node scripts/evidence.mjs …`）：

| path | sha256(前16) | bytes | records | 末尾LF | 全量解析 |
|---|---|---|---|---|---|

- PassReport（脱敏 JSON）：
- 截图 / CLI 输出：
- 备注（异常、重试、耗时）：

## 分叉验证（步骤 8）的分支 hash inventory

| 阶段 | 位置 | sha256 | bytes | records |
|---|---|---|---|---|
| 分叉前基线 | A.local | | | |
| 分叉后 | A.local（分支 α） | | | |
| 分叉后 | B.local（分支 β） | | | |
| 恢复同步后 | A.local / B.local | | | |
| 恢复同步后 | quarantine（α / β） | | | |
| 恢复同步后 | backup（覆盖前版本） | | | |

**判定**：α 与 β 的 sha256 必须都在"恢复同步后"的行里出现至少一次；两侧 primary 的 sha256 必须与分叉后完全相同（未被改动）。

## 连续 pass 稳定性（步骤 8 之后）

| 轮次 | quarantine 文件数 | 文件名列表 hash | 新增 Action |
|---|---|---|---|

**判定**：三轮的文件数与文件名列表 hash 必须完全相同。
```

### 9.4 M1 验收剧本（十步全过）

| 步 | 操作 | 期望 | 证据 |
|---|---|---|---|
| 1 | Mac：装插件，配 sync-dir，跑 dry-run | 报告列出本机 session；**五棵树字节零变化** | 报告 JSON + 前后 evidence 对比 |
| 2 | Mac：新建会话聊 3 轮，等 60 s，手动同步 | replica 出现 `<wsId>/claude-code/<sid>.jsonl` | 两侧 evidence 表，sha256 必须相同 |
| 3 | Win：等文件到达，手动同步 | 落地到 `%USERPROFILE%\.claude\projects\<转义目录>\<sid>.jsonl`；目录名与本机 vault 路径的转义结果一致 | 目录名截图（回填 OQ-3 样本表）+ evidence 表 |
| 4 | Win：`claude --resume <sessionId>` **按 ID** 进入该 session（F-1：picker 只显示交互式来源的会话，headless/sdk 来源不显示——picker 里看不到不代表没同步到） | **历史完整可见，能继续对话** | 截图 + CLI 输出 + resume 后 evidence |
| 5 | Win：继续聊 2 轮，等 60 s，手动同步 | replica 行数增加；`manifest.lastWriter` = Win 的 machineId | manifest 片段 + evidence |
| 6 | Mac：手动同步 | `PULL_OVERWRITE`；备份区有覆盖前副本（sha256 == 步骤 2 的值）；弹出"请重启该会话"Notice；resume 能看到 Win 的 2 轮 | 备份目录 evidence + 截图 |
| 7 | 双向再跑 2 轮 | 全程无 CONFLICT | PassReport ×4 |
| 8 | **分叉验证**：断开同步，两边各聊 2 轮，恢复同步；随后**每台续写过的机器各解决一次**（2026-08-10 实测补入） | `CONFLICT` + Notice（恢复后的第一轮 pass 是观察轮，冲突在下一轮检出，属设计）；两侧 primary 字节未变；两分支都在 inventory；隔离目录 = `branch-<hash8>` × 2 + `meta.json`，连续 3 轮**字节级**不变；A 解决后 B 检出自己的冲突、「保另一台」一次成功（若同步工具正锁着刚搬运的文件，会得到明确的「文件忙/暂时找不到」提示且**零写入**，几秒后重试即可——不算失败；被当成功的无声空操作才是缺陷，见 findings R2-1）；解决后双机收敛无 CONFLICT | §9.3 的两张表 |
| 9 | **回滚验证**：从备份手动恢复一份，resume | 恢复的文件 CLI 可正常加载；sha256 == 备份 sha256 | evidence + 截图 |
| 10 | 关掉 Obsidian 期间在 CLI 里聊，再开 Obsidian | 启动后**两轮 pass 之内**（启动观察轮 + 下一轮/一次手动同步）捕获到新内容（首轮只观察，属设计——2026-08-10 裁决） | PassReport + evidence |

### 9.6 Grok 验收剧本(摘 `experimental` 的闸门,OQ-15)

P6 证明了 Grok **能**同步;这一节证明它**同步对了**。两件事从未被测过,而它们恰好是
产品承诺本身:**没有一个字节真的在两台机器之间走过**(6b.2 的两个实验都在同一台机器上
换 cwd,同 `GROK_HOME`/同 OS/同构建/同登录态),以及**只放同步集能不能被 CLI 认出**
(移文件实验只测了必要性)。在这两条通过之前,设置面板的 `experimental` 标记不摘。

前置:两台机器都装了 Grok 且在 Claudian 里各自登录过;插件已配好同一个 sync 目录;
Grok provider 已启用(首次启用会强制 dry-run 确认)。

| 步 | 操作 | 期望 | 证据 |
|---|---|---|---|
| G1 | **A 机**:经 Claudian 起一个 Grok 会话,聊 3 轮,静置 90 s,手动同步 | replica 出现 `<wsId>/grok/<sid>/` 且**恰好三个文件**:`summary.json`、`chat_history.jsonl`、`updates.jsonl`。`prompt_context.json`/`system_prompt.txt`/`events.jsonl`/`*.lock` **不在里面** | replica `ls` + 两侧 sha256 |
| G2 | **B 机**(此前从未在本 vault 里用过 Grok,`~/.grok/sessions/<encodeURIComponent(vault)>` 不存在):等文件到达,手动同步 | 目录被创建;三个文件落地,sha256 与 A 机相同;`summary.json` 的 `info.id` == 目录名 | 目录名截图 + evidence 表 |
| G3 | **B 机**:`grok sessions list` | **列出这个会话** ← 这是 **G1 充分性**的第一半:只有同步集、没有 `system_prompt.txt`/`prompt_context.json`/`events.jsonl`,CLI 仍要认得它 | CLI 输出(只截会话数与 uuid,标题按红线不入档) |
| G4 | **B 机**:`grok --resume <sid> -p "..."` | 成功,**历史完整**(`grok export` 行数 ≥ A 机 G1 之后的行数);缺席的三个文件被 CLI 就地重建 | export 行数 + 重建后目录 `ls` |
| G5 | **B 机**:再聊 2 轮,静置 90 s,手动同步 | replica 的 `chat_history.jsonl` 纯追加变长;`summary.json` 走 `PUSH_OVERWRITE` + `remote-at-converged-base`(**不是** CONFLICT);备份区有覆盖前副本 | PassReport + 备份 evidence |
| G6 | **A 机**:手动同步,然后 resume | `chat_history.jsonl` `PULL_OVERWRITE`;`summary.json` 快进;A 机 resume 看得到 B 机那 2 轮 | PassReport + CLI 输出 |
| G7 | **反向重跑 G2–G4**(win → mac 与 mac → win 都要过一遍) | 同上 | 同上 |
| G8 | **半落地演练**:手动把 replica 里某个会话的 `summary.json` 移走,B 机同步 | 三个文件**一个都不落**;报告里是 `DEFER` + `primary-not-in-replica`;B 机的 `<sid>/` 目录不被创建 | PassReport + 目录 `ls` |
| G9 | **分叉**:断开同步,两机各聊 1 轮,恢复 | 三个 append 成员判 `CONFLICT`、每组两分支都在隔离区、**两侧原始文件字节未变**;冲突面板里每条都能**认出是哪个文件**(标题形如 `Session <id8> · chat_history.jsonl (grok)`),逐条解决后计数归零。⚠️ **`summary.json` 未必判 CONFLICT**:同步工具若用「保留一方 + 冲突副本」化解了文件级冲突,落败那台看到的就是「本机没动、远端动了」,§7.2b 按收敛基点快进——设计内,非缺陷(2026-08-26 实测) | §9.3 的两张表 |

**任何一步不过 ⇒ `experimental` 不摘。** G3/G4 不过则回到只读(说明同步集不够);
G8 不过是数据安全缺陷,优先级高于一切功能项——它防的是「turn 落进别人的对话」
(findings 2026-08-24 §三)。

顺带补测(不阻塞,回填 OQ-14):在沙箱 `GROK_HOME` 里对一个会话执行 rewind(TUI,
Esc Esc 选点)与 `/compact`,各看一次 `chat_history.jsonl` 是变短还是变长。

### 9.7 `claudian` provider 验收(七步)

0.2.0 里唯一没经过两机验收的 provider。它走的是 §7.2b 的 opaque 表 + 收敛基点快进
(ADR-48),与其余 provider 的前缀合并是**两条不同的代码路径**,而这一条至今只有单元测试。
逐步剧本在验收套件 `tmp/acceptance/AGENTS.md` 的 claudian 附录,这里只记判定与两条闸门。

**核心断言(C4)**:本机改了记录、对端还停在本机上次推的版本 ⇒ 必须是 `PUSH_OVERWRITE`
+ reason `remote-at-converged-base`。**这里出现 CONFLICT 就是不可用**——Claudian 每聊一句
都会重写 `meta.json`,那样它就是个冲突生成器。

**真分叉(C7)**:双机各改一次同一条记录 ⇒ `CONFLICT` + `opaque-divergent-both-moved`,
**两侧原文件字节都不变**,两个分支都进隔离区。**有一侧被改了就是数据安全缺陷**——
这是整份重写型 provider 唯一可能吞掉用户对话标题/会话绑定的路径。

⚠️ **在哪里跑,是这条验收最要紧的选择。** 该 provider 的设置文案明确说「vault 同步已经
带着 `.claudian/` 就别开」。若在这样的 vault 上跑(即便冻结 git):

- **首次接触会在真实记录上产生一批 `opaque-divergent-no-base` 冲突**(§7.2b #4c)——
  两台的 `.claudian/` 本来就由 vault 同步互通、conv id 重合,而 Claudian 打开记录时会把
  `providerState.sessionDirectory` 改写成本机路径,于是同一条记录两台字节不同。
  **这不是缺陷**,但它出现在用户真实的对话记录上,不该顺手在冲突面板里替他二选一。
- **收尾必须先关 provider 再解冻 vault 同步**,顺序反了就长期停在双传输配置里:
  此后任何一次把记录换回旧版本的操作(git restore / 网盘回滚)都会被按收敛基点**快进**
  推给对端,对端那条记录被静默改回旧版。

因此**默认建议在一个独立的测试 vault 上跑**;真实 vault 只在「就是要验自己的真实配置」
时才用,且必须照附录的额外要求执行。

### 9.8 Claudian 2.2.5 兼容性验收(四步,**0.3.0 的发布闸门**)

2.2.5 把新建对话的记录挪进 `devices/device-<64hex>/`,准入的单层扫描看不见它 ⇒
**不产生 report 行、不弹 Notice、状态栏照常「up to date」**。修复必须在真机上正面复验:
零 group 的缺陷正是自动化测试最容易假绿的形状(什么都没发生,断言什么都不违反)。
逐步剧本在 `tmp/acceptance/AGENTS.md` 的 2.2.5 附录,这里只记判定。

| 步 | 断言 | ADR |
|---|---|---|
| **A ⭐** | 2.2.5 新建的对话**被准入**:报告里有它那一行(`DEFER` 也算),**或**`diff` 证明它的文件进了 replica——0.2.0 下两者都是空的 | 65 |
| B | store 里放一个探针目录 ⇒ Notices 里点名它;`rmdir` 后消失 | 66 |
| **C ⭐** | 把会话文件按行截短 ⇒ `CONFLICT` / `local-shrank-below-converged`,**本机那份仍是截短后的大小**,两支都进隔离区 | 61 |
| **D ⭐** | 打开共享开关 ⇒ 记录**移入** flat 层(**设备层空掉**);对端可见且点得开;对端改名**回传到本机**;关掉**不撤回**、新会话**不再搬** | 69 |

**D 的三条各自都能单独失败**,必须分开记:「两层都还有」是搬运只完成一半;
「对端列出来但点开是空的」是会话文件没到(那是 A 的问题);「A 侧仍是原名」若改动确实送达了才是失败。

⚠️ **`claudian` provider 必须关闭**:它也覆盖 flat 层,开着就有两条通道送同一条记录,
D3 出问题时分不清是哪一段。

✅ **2026-09-01 四步全过**(Mac ↔ Windows,真实 vault + git + Dropbox),
[findings](./findings/2026-09-01-claudian-2.2.5-acceptance.md)。被测构建与 `main` 的本地构建逐字相同。

### 9.9 搬完的记录留不住(ADR-71,**0.3.1 的闸门**,单机)

ADR-69 假定搬进共享层的记录会留在那儿。上游每个 Obsidian 会话只推导一次写入层,
所以搬运之后它会按陈旧判断**在设备层重新写一份**,而它读取时设备层优先 ⇒ 共享那份冻结。
**这一整段只需要一台机器**:要验的是本机两层之间的对账。

| 步 | 断言 |
|---|---|
| **E1 ⭐** | 搬完后**不重启**再聊一轮(device 副本必然回来)⇒ 同步 ⇒ **flat 的 sha 变成 device 那份的 sha** |
| **E2 ⭐** | 删掉一条搬过的对话 ⇒ 同步 ⇒ flat 层也有墓碑 ⇒ **重启后侧栏里没有它** |
| **E3 ⭐** | 手工改 flat 冒充对端 ⇒ 同步后**改动还在**(没替人决定)⇒ 修复屏显示两侧字节与时间 ⇒ 点发布 ⇒ **备份里找得到被替换的那版** |
| E4 | 历史残留一条一条修掉,终态「in BOTH layers」= none |

**判据是 sha,不是字节数变大**:`usage` / `lastActivityAt` 的位数变化会让记录**变小**
(2026-09-04 实测 632 → 631)。

⚠️ **自动 pass 会抢在观察之前 FOLD**,E1 第 4 步很容易因此被误记成「未能复现前提」。
开跑前把 `Auto sync interval` 临时设为 0。

✅ **2026-09-04 E1/E2/E3 通过**(E4 无残留可修),
[findings](./findings/2026-09-04-sharing-reconciliation-acceptance.md)。
**该轮抓出两条阻塞级缺陷并已修**:修复屏的读取路径会写盘且不看开关(看一眼 = 搬了),
以及单条发布会带着整轮对账跑(点一条 = 动全部)。两条都在**验收之后**修的,
因此不在被测构建里。

### 9.5 各里程碑 Exit Criteria

| 里程碑 | 通过标准 |
|---|---|
| **M0** | §12 交付清单 G-01…G-11 全绿 |
| **M1** | §9.4 十步**全部**通过；§15 门禁全绿；`EXPECTED_UNVERIFIED === 0`。~~OQ-1/3/5/8/9 有结论~~ ✅ **已全部完成**（2026-08-06，见 §10 与 findings），Claude Code 已标 Tier A ✅ |
| **M2** | M1 剧本回归仍通过；OQ-2 有结论；Codex 或 OpenCode 至少一个达成 Tier B 双机 resume；S-22…S-27、R-14、X-01、X-02 落地；OQ-7 基准达标 |
| **M3** | 冲突解决 UI 走通 §9.4 步骤 8 的完整闭环；备份恢复 UI 可用；孤立 aux 清理命令可用；**Grok 接入**(逐文件分级 + 多文件 group)自动化测试全绿。**Grok 已于 2026-08-26 通过 §9.6 并摘掉 `experimental`**([findings](./findings/2026-08-26-grok-acceptance.md)) |
| **M4** | 干净机器按 README 从零配置成功；BRAT 安装验证；验收记录已归档 |
| **2.2.5 兼容** | §9.8 四步全过 ✅（2026-09-01）——0.3.0 的发布闸门 |
| **搬运对账** | §9.9 E1–E3 ✅（2026-09-04）——0.3.1 的发布闸门；E4 无残留未测 |

---

## 10. Spike 实验

每个 Spike 独立、有明确判定标准，结论写进 `docs/zh-CN/findings/<OQ-x>.md` 并回填[架构 §16](./architecture.md)。**Spike 未完成前，相关代码路径保持保守行为（只读 / 不改写）。**

> **执行方式**：需要 macOS / Windows 真机的 Spike（OQ-1/3/4/5/8/9 与 OQ-2/6 的一部分）由 `tmp/probe/` 下的探测套件承载——把该目录拷到目标机器，用 agent CLI 按其中的 `AGENTS.md` 执行，产出结构化报告后拿回来汇总。该目录是一次性交付物，不入库。

### OQ-8 · Claude Code 完整生命周期是否严格 append-only（~~阻塞 M1 发布~~ → ✅ **PASS**）

> **判定结果（2026-08-06，macOS + Windows 双平台）：PASS，无需任何降级。**
> 36 个快照零前缀违规。E1–E7 与补充步骤全部严格追加：`/compact` 追加 27–31 KB 到**同一文件**（旧字节不动，UI 只显示摘要之后）；fork（Esc×2 回退分叉）为**逻辑分叉、物理追加**（`logicalParentUuid` 指向历史节点）；retry 追加；`kill -9` 后末行完整且 resume 正常；跨版本（2.1.211↔2.1.220↔2.1.223）追加、`version` 字段逐行混存。Q2：文件名恒等于 `sessionId` ✅；Q3：末尾恒 LF ✅；Q4：空会话**不落盘**，CLI 自身永不产生 0 字节 jsonl ✅；Q5 = OQ-5 ✅；Q6：CLI 从不删除/重写 session ✅；Q7：`memory/` 子目录存在但归属未查明（M1 白名单不同步它）🟡；Q8：compact/fork 复用旧 logicalId ✅。
> 证据：[findings/2026-08-06-spike-conclusions.md](./findings/2026-08-06-spike-conclusions.md) 与两份原始报告的 §2。
> 下方实验设计保留，供未来 CLI 大版本升级后的**回归复测**。

这是整个项目的**地基假设**。[架构 §7.2](./architecture.md) 的前缀安全合并、§12.1 的前缀比较短路（size/hash 短路 + 分块 `Buffer.compare`）、Claude Code 的 Tier A 归属，全部建立在"同一个 session 文件只会在尾部追加、旧字节永不改变"之上。已有实测只证明了**目录形态与字段结构**，没有证明**时间维度上的不变性**。

**假设**：对同一 session 文件，任意 `t1 < t2` 的内容满足 `B2.slice(0, B1.length).equals(B1)`，且文件名恒定、恒等于 logicalId。

**方法**：在一次性项目目录下（不要用真实 vault），全程单进程串行操作。每个观测点采集：目录递归清单（含子目录）、每文件 sha256、每个 jsonl 的 `lineCount` / `endsWithLF` / 首行 `sessionId` / 每行的 `uuid`+`parentUuid` 序列、**完整字节归档**、`claude --version`。

| # | 操作 | 观测点 | 关注 |
|---|---|---|---|
| E1 | 新建 session，1 轮对话 | S1 | 出现 `<uuid>.jsonl`；首行 `sessionId` == 文件名 |
| E2 | `--resume` 再发 2 轮，重复 3 次 | S2–S4 | 每步 `assertStrictPrefix`；文件名不变；无新增/删除文件 |
| E3 | **`/compact`** 后再发 1 轮 | S5、S6 | **最危险的一步** |
| E4 | **fork / branch**（回退历史重新提问） | S7 | 产生新文件（好）还是就地重写（坏） |
| E5 | **retry**（对同一消息重新生成） | S8 | 是否删除了上一次的回答行 |
| E6 | **异常中止**：流式输出中途 `kill -9`，然后 `--resume` | S9、S10 | 中止瞬间是否留半截行；resume 时是**截断修复**旧文件（破坏前缀！）还是直接追加 |
| E7 | **跨版本**：升级/降级 CLI 后 resume 并发 1 轮 | S11 | `assertStrictPrefix(S10, S11)`；记录两个版本号 |
| E8 | 放入 `x.conflict` / `y.bak` / `z.jsonl.bak` / 0 字节 `<uuid>.jsonl` | S12 | **与 OQ-5 合并执行** |
| E9 | 新建 session 但不发任何消息就退出 | S13 | 0 字节文件是否出现、是否进 resume 列表 |

**必须回答**：Q1 旧文件是否恒为新文件的严格字节前缀（Tier A 的存亡）；Q2 文件名是否恒等于首行 `sessionId`；Q3 末行是否**始终**以 `\n` 结尾（决定 §5.2.2 的分档）；Q4 0 字节 jsonl 何时出现、CLI 认不认（决定 §5.2.3）；Q5 未知扩展名是否被扫描/报错（= OQ-5，决定隔离与 staging 目录能否与原文件同目录）；Q6 **CLI 会不会自己删除或重写 session 文件**（若会，"本机文件消失"不能一律当作用户删除）；Q7 `memory/` 等子目录归属哪个 session（决定 aux 角色）；Q8 compact/fork 是产生**新 logicalId** 还是复用旧的。

| 判定 | 条件 | 行动 |
|---|---|---|
| **PASS** | E1–E7 全部严格前缀，Q2 恒定，Q6 为否 | Claude Code 从"Tier A 候选 ⚠️"改为"Tier A ✅"，回填文档 |
| **D1** | compact/fork **产生新文件、旧文件字节不变** | 不需降级。补说明：compact/fork 在同步语义上就是"新增一个 session"；补场景 S-21 |
| **D2** | compact 或 fork **就地重写同一文件**，前缀被破坏 | 见下 |
| **D3** | **常规 resume**（E1/E2/E6）就会破坏前缀 | Claude Code 退回 **Tier C 只读**；M1 目标重新评估（可能退化为"单向备份 + 手动恢复"）。这是项目级坏消息，**立刻上报，不要继续写 M1 代码** |
| **D4** | Q3 为否（末行有时无 LF） | 已由 §5.2.2 的分档吸收；确认 `complete-no-lf` 分支的实际发生频率并调 `remoteQuietMs` 默认值 |

**D2 详述**：新增一条决策规则（插在[架构 §7.2](./architecture.md) 优先级 8 之前）——若 L 与 R 互不为前缀、**且**首行 `sessionId` 相同、**且**其中一方 `lineCount` 与 `size` 都更小 → 标 `possible-rewrite`，仍走 `CONFLICT`，但 Notice 文案改为"检测到一侧可能执行了 compact/fork，请选择保留哪一侧"，两侧均备份。明确**不做**"compact 侧自动赢"：compact 会丢弃历史细节，而另一侧可能在 compact 之后有全新的对话轮次，自动选边必然在某类场景下静默丢数据。D2 的代价必须写进 README：任一机器执行一次 compact/fork 必然产生一次需人工处理的 `CONFLICT`（因此三个解决命令必须在 M1 就可用）；且前缀短路失效——每次比较都要读满较短一侧的全部字节。

### 其余 Spike

> **2026-08-06 判定回填**：OQ-1 ✅ 通过（`cwd` 不影响，identity 保持；注意 F-1——验证一律按 ID resume）；OQ-2 ✅ 有结论（实测走了①：**扫目录即可见**，②③未执行也不需要；Codex 升 Tier A 候选）；OQ-3 ✅ 通过（样本已入 §5.1，UNC 未测按不支持）；OQ-4 ✅ 有结论（`OFFLINE`+`RECALL_ON_DATA_ACCESS`，`REPARSE_POINT` 不可用；实现留 M2）；OQ-5 ✅ 通过（异物全部无害）；OQ-9 ✅ 通过（lstat 识别 junction；realpath 不展开短名）。OQ-6 🟡 结构已摸清、生命周期未验；OQ-7 / OQ-10 ⏳ 留 M2。证据见 [findings](./findings/2026-08-06-spike-conclusions.md)。下表保留原实验设计供复测。

| # | 问题 | 方法 | 判定 |
|---|---|---|---|
| **OQ-1** | `cwd` 是否影响跨平台 resume（~~阻塞 M1~~ ✅） | Mac 上产生一个 session → 原样拷到 Windows 对应转义目录（`cwd` 保持 `/Users/...`）→ resume | 能正常 resume 且续写 → `toNeutral` 保持 identity；否则记录具体表现，启用 canonical 化方案并补 round-trip property test。附带观察 `gitBranch` / `version` / `entrypoint` 的影响 |
| **OQ-2** | Codex 的 session 发现机制（阻塞 M2）。已实测 ✅：`sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`、`session_index.jsonl`、`state_*.sqlite` 的 `threads` 表**三者共存**，后两者含本机绝对路径 | ① 把 rollout 拷到另一台机器对应位置、**不动任何索引** → 看 `codex resume` 列表；② 若没有：只追加一行 `session_index.jsonl` 再看；③ 仍没有：手工插入一行 `threads`（路径改写为本机）再看；④ 检查是否有官方 import/reindex 命令；⑤ 顺带验证 rollout 是否严格 append-only（复用 OQ-8 的快照工具） | ① 成立 → 可当 Tier A 简单处理；② 成立 → Tier B 但只需写 jsonl 索引（风险低得多）；仅 ③ 成立 → Tier B + `direct-write` 红线全套（WAL、`_sqlx_migrations` 版本、并发写）；都不成立 → 保持 Tier C。**红线**：任何情况下都不同步 `*.sqlite` / `*-wal` / `*-shm` / `session_index.jsonl` |
| **OQ-3** | Windows 路径转义规则（阻塞 M1） | 在 `C:\Users\<u>\vault`、`D:\我的 vault`、`C:\Users\<u>\my.vault`、含空格路径、UNC 下各跑一次 CLI，记录生成的目录名 | 得到确定规则 → 回填 §5.1 样本表并把 `verified` 置 true；规则不可预测 → 提供 `escapeStrategy: "custom"` + "从本机检测"按钮 |
| **OQ-4** | 网盘按需文件占位符（M2） | Windows + OneDrive/Dropbox 把 sync-dir 设为"仅在线"，观察 `fs.stat` 返回值与读取行为（是否触发下载、阻塞、报错） | 找到可靠检测手段（如 `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`）→ 实现 `SKIP_PLACEHOLDER`；找不到 → README 要求 sync-dir 设为"始终保留在此设备" |
| **OQ-5** | CLI 对未知扩展名的容忍度（阻塞 M1） | 与 OQ-8 的 E8 合并执行 | 被忽略 → 隔离副本与 staging 目录可与原文件同目录；否则一律放到 session 目录之外 |
| **OQ-6** | OpenCode / Grok / Pi 存储结构（M2/M3） | 各装一个、跑一个最小会话、记录落盘位置与结构、试 resume；填"provider 调研表"（存储根、logicalId 来源、是否 append-only、是否有外部索引、是否含绝对路径） | 满足 Tier A 条件 → 接入；否则留 Tier C |
| **OQ-7** | 规模性能基准（M2） | 合成 1000 个 session（p95 < 1 MB，最大 20 MB），量测无变更 pass、100 变更 pass、全量 scrub、manifest 重建、备份区体积增长 | 达到[架构 §12.3](./architecture.md) 的目标；不达标 → 引入持久化增量索引；备份膨胀明显 → 加总量上限 |
| **OQ-9** | Windows junction / 8.3 短名（阻塞 M1） | 构造 junction、reparse point、`PROGRA~1` 形态路径，观察 `fs.lstat().isSymbolicLink()` 与 `fs.realpath()` 的行为 | 若 `lstat` 不能识别 junction → 必须改用 `fs.readlink` 或读文件属性位补齐；`realpath` 若展开短名则字符串层的 `SHORTNAME_LIKE` 拒绝可放宽为告警 |
| **OQ-10** | 漫游 profile（M2） | 在企业域机器上观察 `%USERPROFILE%\.claudian-session-sync` 是否被漫游同步 | 若会 → M2 改用 `%LOCALAPPDATA%` |

---

## 11. 跨平台矩阵

| 关注点 | macOS | Windows | Linux | 覆盖方式 |
|---|---|---|---|---|
| 路径分隔符与转义 | `/` | `\` + 盘符 + UNC | `/` | L0 表驱动 + OQ-3 |
| 文件名大小写 | APFS 默认**不敏感** | 不敏感 | 敏感 | 标识符全用小写 UUID；运行时探测敏感性；L1 加同名不同大小写用例 |
| Unicode 规范化 | NFD | NFC | 原样 | 中立层要求 NFC + ASCII；L1 用带中文的 vault 名验证 workspaceId 不受影响 |
| `rename` 覆盖已打开文件 | 允许（旧 inode 风险，架构 §9.1.6） | 可能 `EPERM` | 允许 | L1 错误注入 + R-08 + CI 在 windows-latest 跑 |
| junction / reparse point | — | 有 | — | SEC-04 + OQ-9 |
| mtime 精度 | ns | 100 ns | ns | 稳定性判定不依赖高精度（含 tailHash 分量）；S-14 三条 |
| 行尾 | LF | 可能 CRLF | LF | **二进制搬运，绝不做行尾转换**；L0 断言 CRLF/LF 判为不同 |
| 路径长度上限 | 长 | 260（未开长路径） | 长 | 落地前检查，超限报错而非截断；不自动加 `\\?\` |
| 文件权限 | POSIX mode | ACL（`mode` 基本无效） | POSIX mode | SEC-20…23 仅 POSIX；Windows 用 SEC-24 |

---

## 12. M0 脚手架门禁

**M0 必须在写第一行 `src/` 代码之前完成。** 脚手架是后补最难、且补不上就永远靠人肉纪律的东西；本项目的核心承诺恰恰依赖"每次改动都被机器检查一遍"。

### 12.1 交付清单

| # | 交付 | 验收方式 |
|---|---|---|
| G-01 | `package.json` + `package-lock.json`（lockfileVersion 3） | `npm ci` 在三平台可复现安装 |
| G-02 | 版本固定：`.nvmrc`（Node 20.x）+ `engines.node`；`typescript` / `vitest` / `@vitest/coverage-v8` / `esbuild` / `eslint` / `fast-check` 全部 **exact pin**（无 `^` `~`） | CI 检查所有 devDependencies 版本串匹配 `/^\d+\.\d+\.\d+$/` |
| G-03 | scripts：`typecheck` / `lint` / `test` / `build` + `test:nightly` / `check:no-skip` / `check:manifest` / `check:bundle` / `check:secrets` / `check:pinned-deps` / `check:docs`（Q-01） | 本地与 CI 跑同一组命令，CI 里不写内联 npx。另有 `verify` 按 CI 顺序把它们串起来，便于推送前本地跑一遍 |
| G-04 | 三平台 workflow | §13 |
| G-05 | bundle 合同测试（**替代 `node -e "require('./main.js')"`**） | §12.2 |
| G-06 | `manifest.json` 合同测试 | §12.3 |
| G-07 | M1 blocker 测试无 `.skip` / `.only` / 未处理 `.todo` | §12.4 |
| G-08 | nightly 保存 fast-check seed / path / 最小反例 artifact | §12.5 |
| G-09 | coverage 门槛由配置**真正强制** | §12.6 |
| G-10 | ESLint：`domain/` 禁止 import `obsidian`/`fs`/`path`/`os`，禁止出现 `RuntimeEnv`；全仓禁止直接 `require("fs")` | `no-restricted-imports` + `--max-warnings=0` |
| G-11 | fixtures 密钥静态扫描（`sk-`、`ghp_`、`Bearer `、真实 home 路径片段） | 独立 script，CI 必跑 |

### 12.2 bundle 合同测试

**为什么 `node -e "require('./main.js')"` 证明不了任何事**：生产 bundle 把 `obsidian` 标为 external，裸 Node 下 `require("obsidian")` 直接 `MODULE_NOT_FOUND`；即便 try/catch 让它"不报错"，也只证明了"文件是合法 JS"。三层替代方案，全部必做：

**(a) metafile 静态断言**（不需要运行，最可靠）：external 集合恰好等于允许集（`obsidian`、`electron`、Node 内置及其 `node:` 前缀形式）；bundle 的 `inputs` 不含 `tests/` 与 `node_modules/{vitest,fast-check}`；`main.js` 体积 < 512 KB（防误打包 node_modules）；产物不含 sourcemap 注释与 `debugger`。

**(b) stub 加载 smoke test**：bundle 是 CJS 且 external 了 `obsidian`，vitest 的 `resolve.alias` 对它无效（alias 作用于源码解析），必须 hook `Module._load` 把 `obsidian` 换成 stub。断言：导出的是函数、原型链是 `stub.Plugin`、`onload()` 之后注册了预期的命令 ID / ribbon / 设置页 / 状态栏、`onunload()` 之后定时器计数归零（防泄漏）。

**(c) `onload()` 不得触发同步 I/O 阻塞**：断言 `onload()` 在 100 ms 内 resolve，且期间没有对 sync-dir 的读调用——首次 pass 必须异步排队，否则 Obsidian 启动会被网盘目录卡住。

### 12.3 `manifest.json` 合同测试

断言 `isDesktopOnly === true`（用了 Node API）、`id` 匹配 `/^[a-z0-9-]+$/` 且等于 `package.json` 的 `name`、`main === "main.js"`、`version` 是合法 semver 且与 `package.json` 一致、`minAppVersion` 合法、`name`/`description`/`author` 非空；BRAT 分发需要的 `versions.json` 中 `versions[m.version] === m.minAppVersion`。

### 12.4 no-skip 门禁

正则扫源码不可靠（`describe.each` 里的动态跳过扫不出来）。用 vitest 的 JSON reporter 断言**实际执行结果**：读 `reports/vitest.json`，筛出路径含 `/tests/m1/` 的文件，若有 `pending` / `todo` / `skipped` 的用例则退出码非 0。（`.only` 会让其他测试变成 skipped，因此同一检查也挡住了 `.only`。）

约定：`tests/m1/**` = M1 blocker，受门禁约束；`tests/m2/**`、`tests/posix/**`（平台条件）、`tests/pending/**`（等 Spike 结论）不受约束，但 `tests/pending/**` 受 §5.1 的 `EXPECTED_UNVERIFIED` 常量约束，M1 Exit 时必须为 0。

### 12.5 nightly 反例 artifact

失败时把 `{property, seed, counterexamplePath, numRuns, counterexample, error, regressionSnippet}` 写进 `artifacts/fc-<name>-<seed>.json`，CI 用 `actions/upload-artifact@v4`（`if: always()`）上传。`regressionSnippet` 是一段可直接粘进 `tests/m1/regression/` 的固定用例骨架。

落地方式是 `tests/helpers/fast-check.ts` 的 **`fcAssert(name, property, opts)` 包装**（`fc.check` → 失败则写产物 → 用 `fc.defaultReportMessage` 抛原样错误），不是 fast-check 的 `reporter` 参数：传 `reporter` 会整个接管错误格式化，得自己重新拼那段标准报错。属性测试一律走 `fcAssert` 而不是 `fc.assert`，否则失败不留产物。`FC_NUM_RUNS` / `FC_SEED` 由它读取（§13），G-08 自身由 `tests/build/fc-reporter.test.ts` 验证。

### 12.6 coverage 真正强制

```ts
// vitest.config.mts（片段）
coverage: {
  provider: "v8",
  reporter: ["text", "json-summary", "lcov"],
  reportOnFailure: true,
  include: ["src/**/*.ts"],      // 关键 ①
  exclude: ["src/**/*.d.ts", "src/main.ts"],       // main.ts 是纯装配，由 bundle smoke 覆盖
  thresholds: {
    autoUpdate: false,           // 关键 ②
    lines: 80, functions: 80, branches: 75, statements: 80,
    "src/domain/**":    { lines: 90, functions: 90, branches: 85, statements: 90 },
    "src/infra/**":     { lines: 80, functions: 80, branches: 70, statements: 80 },
    "src/providers/**": { lines: 70, functions: 70, branches: 60, statements: 70 },
  },
}
```

① **未被任何测试触及的源文件也必须计入**，否则删掉一个测试文件会让覆盖率**上升**（对应源文件不再计入），门槛形同虚设。vitest 3 用 `all: true` 表达这件事；**vitest 4 删掉了该字段**，把语义并进 `include`——显式列出 glob 即"匹配到的文件无论有没有被测都计入"。语义等价，但它现在挂在一个名字不再自我说明的选项上，因此 M0 用 `tests/build/coverage-gate.test.ts` 把这条行为钉死：一个临时工程里放一个没测试的源文件必须让门槛不达标、给它补上测试后必须通过。**升级 vitest 时这条测试变红就说明门槛失效了**，不要绕过它。② `autoUpdate: false` 否则 vitest 会把实际值写回配置，门槛一路下滑。门槛不达标时 `vitest run --coverage` 退出码非 0，CI 直接红——**不要**用 `|| true` 或单独的"报告 job"。

> M0 期间 `src/` 只有 `main.ts`（已被 exclude），覆盖率集合为空、门槛平凡通过。这不是问题，但也意味着**门槛本身在 M0 无信号**——`coverage-gate` 那条测试是这一阶段唯一的证据来源。

门槛用于挡回归，不作为质量目标——U-07 与 U-18 那两条测试比 10% 覆盖率值钱。

### 12.7 M0 实际落地（2026-08-06 完成）

工具链（全部 exact pin，见 `package.json`）：Node **20.20.2**（`.nvmrc`）、TypeScript 5.9.3、vitest 4.1.10、esbuild 0.28.1、ESLint 10.8.0 + typescript-eslint 8.66.0、fast-check 4.9.0、obsidian 1.13.1。

> TypeScript 停在 5.9.3 而不是 7.x：typescript-eslint 8.66 的 peer 范围是 `>=4.8.4 <6.1.0`，装 TS 7 会让 G-10 的 lint 门禁直接失效。**升 TS 前先确认 typescript-eslint 支持。**

门禁与其自检的对应关系——**每条门禁都有一条"喂它应当被拦下的输入"的测试**，理由见 `tests/README.md`：

| 门禁 | 实现 | 自检 |
|---|---|---|
| G-02 `check:pinned-deps` | `scripts/check-pinned-deps.mjs` | `tests/build/gate-scripts.test.ts`（caret 范围 / 错误 Node 大版本 / lockfile v2 / 缺必需 devDep） |
| G-05 bundle 三层 | `tests/build/artifact-metafile.test.ts`、`artifact-smoke.test.ts` | 自身即断言；`Module._load` 钩子换入 `tests/helpers/obsidian-stub.ts` 与**记录型 `fs`**，后者是 §12.2c "onload 期间零 fs 读"的实现手段 |
| G-06 `check:manifest` | `scripts/check-manifest.mjs` | 同上（isDesktopOnly / 版本漂移 / versions.json 不含该版本） |
| G-07 `check:no-skip` | `scripts/check-no-skip.mjs` | 同上（含 Windows 反斜杠路径与"m2/pending 不受管"两条） |
| G-08 反例产物 | `tests/helpers/fast-check.ts` | `tests/build/fc-reporter.test.ts` |
| G-09 覆盖率强制 | `vitest.config.mts` | `tests/build/coverage-gate.test.ts`（§12.6 ①） |
| G-10 lint 规则 | `eslint.config.mjs` | `tests/build/eslint-rules.test.ts`（43 条，见下"分层规则"） |
| G-11 `check:secrets` | `scripts/check-secrets.mjs` | 同 gate-scripts（token / 真实 home 路径 / UTF-16 / 超大文件 / 不误伤 `task-`、`Bearer of bad news` 这类词） |
| Q-01 `check:docs` | `scripts/check-docs.mjs` | 同 gate-scripts（含指针悬空） |
| 工具链指向 | `tsconfig.json` / `eslint.config.mjs` | `tests/build/toolchain.test.ts`（见下） |
| vitest 报告契约 | — | `tests/build/reporter-contract.test.ts`（见下） |

#### 分层规则（G-10 的实际形状）

按目录分档，从外到内逐层收紧。**allow-list 优于 blocklist**：domain 的层级规则不是"禁止 import infra/ui/providers"（那只挡住今天存在的目录，M1 新建一个 `src/util/` 就是一条无人看守的通道），而是**禁止任何爬出 `src/domain/` 的相对路径**。

| 范围 | 禁止 |
|---|---|
| 全仓 | 裸 `require("fs"/"os"/"child_process")` |
| `src/**` | 网络（`http`/`https`/`net`/`tls`/`dgram`、`fetch`/`XMLHttpRequest`/`WebSocket`）；`as SafeAbsolutePath` 之类的强转 |
| `src/{infra,providers,orchestration}/**` | 以上 + `obsidian`（只有 `src/ui/` 与 `src/main.ts` 可以） |
| `src/domain/**` | 以上 + 全部 Node 内置（含 `node:module`、`node:process`）+ 任何 `../` + `RuntimeEnv` 标识符 + `Date.now` / `new Date()` / `Math.random` + 内联 `eslint-disable`（`noInlineConfig`） |
| `tests/**` | `fc.assert`（必须走 `fcAssert`，否则失败不留反例产物） |

例外只有两个，且是**精确减一条**而不是整组关掉：`src/infra/path-guard.*` 与 `src/domain/path-safety.*` 可以做那一次 branded 强转——正是这一次强转让其他所有文件的禁令有意义。

> ⚠️ **flat config 的规则选项是"替换"不是"合并"**：同一个 rule id 被后面的 config 对象再次声明时，前面的选项**整个失效**。所以每一档都得把上一档的内容重新列一遍（代码里用 `NETWORK_MODULES` / `REQUIRE_NODE_FS_BAN` 这类常量组合）。M0 期间踩过两次：加 `src/**` 网络规则时静默弄丢了全仓的 `require("fs")` 禁令，两次都是被 `eslint-rules.test.ts` 当场抓到。

**四条 `no-restricted-imports` 完全看不见的逃逸路径**（另配 `no-restricted-syntax` / `no-restricted-globals`，各有用例）：`await import("node:fs")`、`createRequire(...)("fs")`、`export * from "node:fs"`、直接读 `process` 全局。

> 写这组自检的直接收益：初版的 esquery 选择器把 `fs/promises` 里的 `/` 直接写进正则，**选择器本身解析失败**——而 `npm run lint` 全绿，因为仓库里还没有 `src/domain/` 文件可供它作用。没有这组测试，G-10 会一直"绿着"直到 M1 有人往领域层 import 了 `fs` 也没人拦。选择器里的斜杠必须写成 unicode 转义（反斜杠 + `u002F`），因为 esquery 用斜杠作正则定界符。

#### 两条"门禁的门禁"

- **`toolchain.test.ts`**：断言 `tsc` 与 `eslint` 的**程序非空**且包含 `src/` 与 `tests/`。理由：两者对着空集都会打印成功。M0 期间把 tsconfig 的 include 写成 `src/**/*.{ts,mts}` 后，typecheck 只检查了 3 个配置文件、0.4 秒通过——**tsconfig 的 glob 不支持花括号展开**（ESLint 的支持），扩展名必须逐条列。修好当天就查出一个被掩盖的缺失 import。
- **`reporter-contract.test.ts`**：真跑一次含 `it.skip` / `it.todo` 的 vitest，断言落盘 JSON 里确实是 `testResults[].name`（绝对路径）与 `assertionResults[].status` 的 `"skipped"` / `"todo"`。G-07 的其余用例喂的都是本仓库自己拼的 JSON，只证明脚本逻辑对，不证明 vitest 还这么输出；升级后字段一改，门禁会永久变绿而所有旧用例照样通过。

#### `.only` 的实际覆盖范围

`check:no-skip` 只在 `.only` **留下了被跳过的兄弟用例**时才抓得到；`describe.only` 包住整个文件时不留痕迹。真正挡住 `.only` 的是 `vitest.config.mts` 里的 `allowOnly: false`（本地与 CI 行为一致），本门禁是第二道。此外 `--min <n>` 给 M1 用：没有下限时，"没有用例被跳过"和"整个 M1 套件不再被收集"是同一行绿字。

三处与原文不同的实现选择：`coverage.all` → `coverage.include`（§12.6 ①）、fast-check `reporter` → `fcAssert` 包装（§12.5）、§12.3 的 `main === "main.js"` 断在 `package.json` 上（Obsidian 的 manifest 没有 `main` 字段，入口恒为 main.js；manifest 里若出现该字段也一并校验）。

另外几条 M0 期间定下、后续容易踩的约定：

- **`package.json` 不能写 `"type": "module"`**。Obsidian 按 CommonJS 加载 `main.js`；带上该字段后 Node 把 `.js` 当 ESM，bundle smoke 直接 `module is not defined`。仓库工具链靠显式 `.mjs` / `.mts` 扩展名走 ESM。
- **`.gitattributes` 强制 `eol=lf`**，`tests/fixtures/**` 与 `*.jsonl` 标 `-text` 完全不转换。Windows 检出时被改写行尾会让每个字节级断言变成假冲突。
- **`useDefineForClassFields: false`**（tsconfig）。target 为 ES2022 时它默认为 true，此时 `Plugin` / `PluginSettingTab` 子类里"声明了但没初始化"的字段会编译成 `defineProperty(this, "x", undefined)`，把基类构造函数刚设好的值抹掉——Obsidian 插件的经典坑。
- **`check:secrets` 扫全仓**（除依赖与构建产物），只对 `docs/` 放行 home-path 类规则：§5.1 的转义样本与 findings **必须**逐字引用真实路径，那是证据本身；凭证类规则在 `docs/` 照常生效。安全测试要用的诱饵串（`sk-TESTSENTINEL-0000` 之类，§8.4 SEC-10/11）靠大写标记 `SENTINEL` / `EXAMPLE` / `FAKE` / `DUMMY` 识别放行——**真实密钥不会自报家门**。
- **M1 把 §5.1 样本表搬进 `tests/fixtures/` 时，用户名要换成 `testuser` 或 `<u>` 占位**（转义规则是逐字符映射，替换用户名不影响任何断言），否则 `check:secrets` 会拦。

---

## 13. CI

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
  schedule: [{ cron: "0 18 * * *" }]
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }

jobs:
  check:
    if: github.event_name != 'schedule'
    strategy:
      fail-fast: false
      matrix: { os: [ubuntu-latest, macos-latest, windows-latest] }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci --ignore-scripts
      - run: npm run check:pinned-deps      # G-02
      - run: npm run typecheck              # tsc --noEmit（安全门禁的一部分）
      - run: npm run lint                   # eslint . --max-warnings=0
      - run: npm run check:secrets          # G-11
      - run: npm run check:docs             # Q-01
      - run: npm test                       # vitest run --coverage（L0/L1/L2/安全组，门槛内建）
      - run: npm run build                  # esbuild → main.js + dist/meta.json
      - run: npm run check:bundle           # G-05
      - run: npm run check:manifest         # G-06
      - run: npm run check:no-skip          # G-07（读 reports/vitest.json）
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: reports-${{ matrix.os }}
          path: |
            reports/
            coverage/
            artifacts/

  nightly-property:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    env: { FC_NUM_RUNS: "5000", FC_SEED: "" }   # 空 = 随机 seed
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci --ignore-scripts
      - run: npm run test:nightly           # 只跑 tests/**/property/**
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: fast-check-counterexamples, path: artifacts/ }
```

要点：

- **windows-latest 必须跑**：`rename` 语义、保留名、尾随点空格、路径长度、junction 只有在那里才暴露。**macOS 必须跑**：APFS 大小写不敏感与 NFD 规范化。
- CI **不跑**真实 CLI、不跑真实网盘——那是 §9 人工验收的事。
- 三平台的 job 名必须进 branch protection 的 required checks，否则门禁不生效。
- nightly 失败时把 `regressionSnippet` 转成 `tests/m1/regression/` 里的固定用例。
- **驱动真实 pass 的用例必须自带显式超时**（约定 `const SLOW = 30_000` + `}, SLOW)`），
  vitest 的 5 s 默认值保持全局不动。一次 `settle()` 是三次真实 pass、真实文件系统、
  外加覆盖率插桩;windows-latest 是双核 runner,这类用例在**通过**的那些 run 里就已经
  跑到 3–4.9 s。到那个份上默认值报的不再是缺陷,而是机器有多忙——2026-08-29 的
  `plugin-runtime.test.ts > dry run > produces a report and changes nothing` 就是这么红的
  (6617 ms,同一用例上一次 run 只要 632 ms,代码没有任何相关改动)。
  判据很简单:用例里出现 `settle()` 或 `syncNow(` 就给它 `SLOW`,没有就说明它确实快。

---

## 14. 测试数据规范

- **禁止**把真实对话内容放进 fixtures。所有 jsonl 由 `makeSession()` 合成，文本为可识别的占位内容
- fixtures 里的路径统一用 `/Users/testuser/…`、`C:\Users\testuser\…`，不出现开发者真实用户名
- CI 静态检查：fixtures 与测试代码中不得出现 `sk-`、`ghp_`、`Bearer `、真实 home 路径片段（G-11）
- **sentinel 必测**：见 §8.4 SEC-11 / SEC-13，CI 必跑不允许 skip
- **dry-run 快照必测**：见 §8.6
- 需要用真实 session 复现 bug 时：脱敏后单独存 `tests/fixtures/redacted/`，并在 PR 里说明脱敏方式

---

## 15. M1 质量门禁清单

**每一项都必须有一个机器可执行的强制点或一份归档证据**，"靠 review 时注意"不算。

### 15.1 文档语义冻结

| # | 门禁 | 强制方式 |
|---|---|---|
| Q-01 | 前缀语义唯一：`CLAUDE.md` 不复述技术决策，且不出现已废弃规则 | **脚本化** `check:docs`（CI 必跑）：断言 `CLAUDE.md` 含指向 `docs/zh-CN/architecture.md` 的规范声明，且全文不出现 `行数多的赢` / `按 mtime 处理` / `mtime 距今` |
| Q-02 | Codex 统一为 Tier C 只读 | 单测断言 `registry.get("codex").tier === "C"` |
| Q-03 | I1 = 有序字节流可恢复性 | `assertRecoverable` 存在且被 property test 使用 |
| Q-04 | I2 拆成 I2a / I2b / I2c | 三个 property 文件独立存在 |
| Q-05 | 0 字节 / 高 schemaVersion / mtime / 备份开关语义统一 | §5.2.3 / M-03 / S-14 / Q-06 |
| Q-06 | 备份不可关闭 | 类型级：`expectTypeOf<PortableSettings["backup"]>().not.toHaveProperty("enabled")` |
| Q-07 | 并发保证已降为 best-effort 并写明不保证的情况 | 人工；R-11 是它的可执行版本 |
| Q-08 | 三处状态存储边界明确 | 单测：`machineId` 只从 `<homedir>/.claudian-session-sync/machine.json` 读，断言不从 `data.json` 读；`PortableSettings` 序列化后不含绝对路径（正则断言） |

### 15.2 M1 阻塞 Spike

| # | Spike | 完成判据 |
|---|---|---|
| Q-10 | OQ-1 `cwd` 是否影响 resume | ✅ 完成：findings 已归档，transform 定为 identity |
| Q-11 | OQ-3 Windows 路径转义 | ✅ 完成：§5.1 全表 `verified: true`，`EXPECTED_UNVERIFIED = 0` |
| Q-12 | OQ-5 CLI 对未知扩展名的行为 | ✅ 完成：隔离与 staging 可与原文件同目录 |
| Q-13 | **OQ-8 生命周期 append-only** | ✅ **PASS**（双平台 36 快照零违规，无需降级） |
| Q-14 | OQ-9 Windows junction / realpath | ✅ 完成：lstat 识别 junction → SEC-04 直接用 `lstat().isSymbolicLink()` 断言 |

**Q-13 是 M1 的真正地基**：整个前缀合并语义建立在"append-only"之上，若 compact 会重写历史，`PUSH_OVERWRITE` 会把 compact 前的完整历史当"发散"或直接覆盖。

### 15.3 自动化安全门禁

| # | 门禁 | 对应测试 |
|---|---|---|
| Q-20 | 决策表全部组合及优先级通过 | §5.2.7 笛卡尔积 + 优先级 + 三条显式回归 |
| Q-21 | **同 size / 同 mtime、内容不同的回归通过** | U-18a/b/c |
| Q-22 | 双 replica 的 L2 模型完成 | §7.1；S-01…S-21、S-28…S-30b、X-03 全绿 |
| Q-23 | I2a / I2b / I2c 分开通过 | §7.3 |
| Q-24 | TOCTOU、重叠 pass、锁、崩溃点矩阵通过 | R-01…R-13 |
| Q-25 | traversal / symlink / junction / 目录重叠 / 凭证排除通过 | §8.1–8.4，含 24 个 root 重叠用例 |
| Q-26 | 所有 M1 blocker 测试无 skip | `check:no-skip` |
| Q-27 | I1 在每一步 mutation 后都被断言 | §7.3 的 `step()`；见下方自检 |

**Q-27 的自检（mutation testing 的穷人版）**：M1 收尾时手工注入 5 个已知缺陷——删前缀校验、删备份、复用 manifest hash、忽略 `NOT_READY`、隔离时删源文件——逐个确认**至少有一条测试变红**，并记录是哪一条。测试套件本身也需要被验证。

### 15.4 三平台 CI

| # | 门禁 | 强制方式 |
|---|---|---|
| Q-30 | `npm ci` / typecheck / lint / L0-L1-L2 / build 三平台全绿 | §13，required checks |
| Q-31 | Obsidian stub smoke 与 manifest 合同通过 | §12.2 / §12.3 |
| Q-32 | Windows 的 rename / 路径 / 安全文件名测试**实际执行**（不是被条件跳过） | `check:no-skip` 在 windows-latest 同样跑；另加 meta 断言：Windows 上 `tests/m1/` 的执行数 ≥ ubuntu 的 95% |
| Q-33 | coverage 门槛真正强制 | §12.6；抽查：临时删一个 domain 测试文件，CI 必须红 |

### 15.5 真机验收

| # | 门禁 | 证据 |
|---|---|---|
| Q-40 | M1 十步剧本**全部**通过 | §9.3 模板逐步填写 |
| Q-41 | Mac → Windows → Mac 双向均有字节 hash 证据 | 步骤 2/3/5/6 的 evidence 表 sha256 逐一对齐 |
| Q-42 | 分叉后所有分支可恢复，连续 pass 不新增重复隔离副本 | §9.3 的两张表 |
| Q-43 | 备份恢复与启动同步通过 | 步骤 9、10 |
| Q-44 | 验收记录含完整版本与同步工具配置 | 环境版本表无空格 |

---

## 16. Definition of Done

一个功能/修复合入前：

- [ ] 说得清它守的是 I1 / I2a / I2b / I2c / I3 / I4 中的哪一条，或是明确的回归防护
- [ ] 涉及决策逻辑 → §5.2 用例表已更新（新增分支必须有新用例**并进入 §5.2.7 的组合维度**）
- [ ] 涉及写盘 → 有 L1 错误注入用例，且至少覆盖一个 §7.4 的注入点
- [ ] 涉及跨机语义 → 有 L2 场景用例（双 replica，不是共享目录）
- [ ] 涉及路径 / 标识符 / 外部输入 → 有 §8 的 fail-closed 用例，且套了 `assertNoOutOfScopeIo`
- [ ] 涉及 provider 存储假设 → 有实测证据（标 ✅）或明确标 ⚠️ 并降级为只读
- [ ] `typecheck` + `lint` + 三平台 CI + `check:no-skip` + `check:bundle` + `check:manifest` 全绿
- [ ] coverage 门槛未被下调（diff 里不得出现 `thresholds` 数值变更，除非 PR 标题写明理由）
- [ ] 若改动影响用户可见行为 → 架构文档相应章节已更新

**发布前（M4）额外**：§9.4 剧本在真机重跑一轮并归档；§15 全部门禁绿；README 写清"本插件负责什么、不负责什么"（尤其与 Claudian 的 CLI 检测问题划清界限）。

---

## 附录 A · 未采纳 / 修改采纳的审核意见

| 审核项 | 裁决 | 理由 |
|---|---|---|
| 4.9「Spike 通过前 Claude Code 应保持只读」 | **修改采纳** | 若读成"M1 开发期间只读"，M1 就没有可实现的内容。门禁从**开发时点**移到**发布时点**（[架构 §6.1.1](./architecture.md)）：按 Tier A 语义开发，但 UI 标实验性、首次启用强制 dry-run 确认、OQ-8 未过不打 tag。风险控制等价 |
| 4.4「或改用不可变 head/candidate 布局」 | **不采纳**（记录为 M3 选项） | head 指针文件本身又会变成两台机器写的同一路径，问题原地复现；M1 工作量翻倍且新失败模式更严重（[架构 §9.4.1](./architecture.md)）。改用"覆盖远端前把旧远端版本存进本机 `backups/remote/`"达到同等 I1 保证 |
| 5.4「文件落地后 provider index reconcile 前」注入点 | **修改采纳**：保留为 R-14，归入 M2 | M1 只有 Tier A 候选，本机无外部索引，该注入点在 M1 代码里不存在 |
| 5.5「temp/backup/session 权限不被放宽」在 Windows 上验证 | **部分不采纳**：Windows 不做 mode 断言 | Node 在 Windows 上 `mode` 只有只读位有效，真实权限走 ACL；用 chmod 语义写的断言永远为真或永远为假。改为断言"落地文件无只读属性" + "tmp 用 `O_EXCL` 创建" |
| 5.7「M1 blocker 测试不得出现 skip」 | **修改采纳** | 与 §5.1"未实测的转义期望值先标 skip"直接冲突。改为未验证条目**根本不注册为测试**，另用 `EXPECTED_UNVERIFIED` 常量 + M1 Exit 断言其为 0 |
| 5.7「stub smoke **或** bundle/manifest 合同测试」 | **加强采纳**：三层全做 | 静态 metafile 断言、stub 加载 smoke、manifest 合同各自能挡不同的故障，单独任何一层都不足以替代 `node -e require` |
| 5.6-3 时钟差「决策完全一致」 | **修改采纳** | 原措辞与稳定性判定不可兼容。改为"内容方向决策不依赖绝对时钟；时钟差只能沿更保守方向影响 `DEFER`" |
| 5.1「冲突隔离不能作为宽泛例外」 | **采纳并加强** | 进一步要求**备份轮转**也受 I1 管辖（§1.3），否则 `keep=3` 本身就是一条合法的丢数据路径 |
| 4.3「外部冲突文件应复制或记录后忽略，不宜直接移动」 | **采纳并推广** | 推广为通则：插件永不移动/删除 sync-dir 里它不认识的**任何**文件（[架构 §8.2](./architecture.md)） |
