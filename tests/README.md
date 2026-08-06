# tests/ — 目录约定

分层见 [testing.md §2](../docs/zh-CN/testing.md)，本文只讲**哪个目录受哪条门禁约束**——这决定了新测试该放哪。

| 目录 | 内容 | 受 `check:no-skip` 约束 | 备注 |
|---|---|---|---|
| `m1/` | M1 阻塞测试（L0 决策表、L1 文件系统、L2 双 replica、安全组） | ✅ **是** | 出现 `pending` / `todo` / `skipped` 即 CI 红（[§12.4](../docs/zh-CN/testing.md)）。`.only` 会把兄弟用例变成 skipped，因此同一检查也挡住它 |
| `m1/property/` | fast-check 属性测试（I1 / I2a / I2b / I2c） | ✅ 是 | 同时被 `test:nightly` 挑出来跑 5000 轮；失败产物落 `artifacts/` |
| `m1/regression/` | 由 nightly 反例转成的固定用例 | ✅ 是 | 骨架由 `artifacts/fc-*.json` 的 `regressionSnippet` 直接粘贴 |
| `m2/` | M2 及以后 | ❌ 否 | 可以先写着 skip |
| `posix/` | 平台条件测试（POSIX 权限位等） | ❌ 否 | Windows 上跳过是预期行为（[§11](../docs/zh-CN/testing.md)） |
| `pending/` | 等 Spike 结论的测试 | ❌ 否 | 另受 `EXPECTED_UNVERIFIED` 常量约束，M1 Exit 时必须为 0（[§5.1](../docs/zh-CN/testing.md)） |
| `build/` | 脚手架自检：bundle 合同、门禁脚本、lint 规则、覆盖率强制 | ❌ 否 | 见下 |
| `helpers/` | `obsidian-stub.ts`、`fast-check.ts` 等 | — | 不是测试文件，不被 include 匹配 |
| `fixtures/` | 合成测试数据 | — | **禁止真实对话内容**；路径一律用 `testuser`（[§14](../docs/zh-CN/testing.md)），`check:secrets` 会扫 |

## `build/` 的两组文件跑在不同命令下

`artifact-*.test.ts` 需要先 `npm run build`（它们断言的是产物 `main.js` / `dist/meta.json`），所以从 `npm test` 里排除，由 `npm run check:bundle` 单独跑。其余文件是纯脚手架自检，跟着 `npm test` 走。

这组自检存在的理由：**一条从未见过它报错的门禁，和一条条件写反了的门禁，长得一模一样**。所以每条门禁都同时被喂过应当通过的输入和应当拦下的输入。

## 新增测试时

参照 [testing.md §16 Definition of Done](../docs/zh-CN/testing.md)：说得清它守的是 I1 / I2a / I2b / I2c / I3 / I4 中的哪一条，或是明确的回归防护。
