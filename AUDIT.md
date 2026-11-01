# 问题清单与修复记录

- 审计对象：`dsh-quick-adb@0.2.0`（原 `dsh-android-adb@0.1.0`）
- 审计时间：2026-11-01
- 状态：**27 项全部关闭**（25 项修复 + 2 项按设计保留并文档化）
- 自检方法与可信度：见 [docs/VERIFICATION.md](docs/VERIFICATION.md)
- 回归入口：`node scripts/selftest.mjs`（64 项；装进 dsh 后 80 项）

> **口径更正**：上一版汇总写「P2 × 10、P3 × 8」，与实际条目数（各 11 条）不符，本版按实际条目计。

---

## 1. 修复总表

| ID | 严重度 | 问题 | 状态 | 修复要点 | 回归用例 |
|---|---|---|---|---|---|
| P0-1 | 安全 | `adb_app` 的 package/activity 未转义，可注入设备 shell | 已修复 | 包名/Activity 白名单正则 + `shQuote` 双保险，非法即拒且零 ADB 调用 | §10 |
| P0-2 | 安全 | `adb_batch` 的 `shell` 步骤绕过 `allowShell` | 已修复 | 抽 `assertShellAllowed()`，`adb_shell` 与 batch 共用 | §9 |
| P1-1 | 正确性 | batch 在 `verify:false` 后不失效缓存，下一步吃旧树 | 已修复 | batch 记录 `lastDumpOk`/`mutated`，未拿到新树即 `invalidate` | §8 |
| P1-2 | 正确性 | `nth` 越界被静默钳制到最后一个匹配 | 已修复 | 越界返回 `ok:false + reason='nth-out-of-range'`，错误文案给匹配数 | §2、§15 |
| P1-3 | 正确性 | `adb_screen` 的 `find` 未进渲染文本，功能空转 | 已修复 | `screenRender` 输出「定位命中 + 坐标」或候选 | §15 |
| P2-1 | 边界 | `input text` 的 `%s`/`%` 歧义导致文本被改写 | 已修复 | 含 `%` 或非 ASCII 时明确告警；装了 ADBKeyboard 走 base64 | §15 |
| P2-2 | 边界 | `wait` 超时溢出（700ms 实测 1562ms） | 已修复 | 截止前预留解析预算，剩余不足即停；实测 307ms | §11 |
| P2-3 | 健壮性 | 一次 dump 超时就永久关闭 `--compressed` | 已修复 | 只有设备明确报 Unknown option 才永久降级 | §12 |
| P2-4 | 边界 | 字符串坐标被误判为「缺参数」 | 已修复 | 先 `Number()` 再判有限值，错误文案区分类型与缺失 | §5 |
| P2-5 | 边界 | `maxTexts: 0` 仍返回 1 条 | 已修复 | `max <= 0` 提前返回 | §15 |
| P2-6 | 正确性 | `cache.note()` 更新第一个槽而非当前设备 | 已修复 | `note(kind, serial)` 精确到槽位 | §3、§4 |
| P2-7 | 指标 | 命中率把付费的 `cache-verified` 算作命中 | 已修复 | 拆 `hitRate` / `hitRateExact`，报告分列 | §14 |
| P2-8 | 健壮性 | `app` 用 `slice(indexOf(...))`，找不到取末字符 | 已修复 | 改走统一 `absorb`，找不到即判 `settle:failed` | §10 |
| P2-9 | 并发 | `timing.clear()` 与在途写入竞争 | 已修复 | 先 `await this.queue` 再截断 | §14 |
| P2-10 | 资源 | 截图无清理，磁盘无界增长 | 已修复 | 新增 `maxShots`（默认 50），按 mtime 清理 | §13 |
| P2-11 | 稳定性 | 批处理累计 sleep 可能撞上超时被 kill | 已修复 | 按累计时长切段（预算 `actionTimeoutMs × 0.6`） | §7 |
| P3-1 | 可维护 | `engine.js` 836 行混五类职责 | 已修复 | 拆出 `perceive.js`、`actions.js`；engine 只做编排 | 全量 |
| P3-2 | 可维护 | 四个动作各写一遍「settle+dump+absorb+invalidate」 | 已修复 | 统一为 `runAction()` 唯一出口（也是 P1-1 的根因） | §5–§8 |
| P3-3 | 可维护 | `dumpScript()` 与 `dumpScriptFor()` 重复且无调用 | 已修复 | 删除 `dumpScript()` | — |
| P3-4 | 可维护 | `status()` 无入口 | 已修复 | 暴露为 `adb_app {action:"status"}` | §15 |
| P3-5 | 风格 | batch 用裸 `setTimeout` | 已修复 | 统一 `util.sleep` | — |
| P3-6 | 配置 | 读 `config.logLevel` 但未在 schema 中定义 | 已修复 | 加入 DEFAULTS + schema（debug/info/warn/error） | — |
| P3-7 | 依赖 | `inject` 把 systemPrompt 声明为硬依赖又做可选保护 | 已修复 | `inject` 收窄为 `['tools']`，systemPrompt 经 `ctx.get` 可选获取 | 入口冒烟 |
| P3-8 | 打包 | `files` 不含 scripts/fixtures，README 却让装完就跑 | 已修复 | `files` 纳入 lib/scripts/fixtures/docs | — |
| P3-9 | 可读性 | 中文表头用 `padEnd` 对齐错位 | 已修复 | 新增 `displayWidth`/`padDisplay`（CJK 按 2 宽） | 人工核对输出 |
| P3-10 | 一致性 | `adb_swipe` 无视觉兜底，`adb_input` 未暴露 `allowVision` | 已修复 | 三者统一 `allowVision` 语义 | §15 |
| P3-11 | 体积 | `screen` 同时返回 `targets` 数组与同内容的 `text` | 已修复 | 改为 `targetCount` + `text`，不再重复负载 | §15 |

---

## 2. 按设计保留（2 项）

| 项 | 说明 | 缓解 |
|---|---|---|
| `visionCommand` 以 `shell:true` 执行 | 这是「接入任意外部视觉能力」的唯一通用方式，改成 argv 数组会牺牲可用性 | 默认空（禁用）；README 安全边界明确写「配置即代码执行，只填可信命令」 |
| 同 Activity 内 L2 可能复用陈旧树 | 没有额外往返就无法证明界面未变；强校验会把 L2 变成 L3 | 任何动作立即 `dirty`；L2 只允许「无动作 + ≤ hardTtl + 包名/Activity 一致」 |

---

## 3. 修复过程中新发现并修复的 3 个问题

这 3 个不在原审计清单里，是在改代码/补测试时暴露的：

1. **`adb_batch` 没先解析设备**：`engine.batch` 直接在未 `device()` 的情况下发命令，多设备环境下会命中 adb 的「more than one device」，或串到错误设备。已在 `runBatch` 前补 `await this.device()`。
2. **`includeScreenInAction` 是死配置**：schema 和 README 都写了，代码从未读取，关不掉界面回传。已接入 `screenResult()`。
3. **批处理预算单位错误**：`ensureRoom(sleepCost("sleep 200"))` 把「200 毫秒」当成 200 秒，导致所有含 `wait` 的批处理被强制切段。该 bug 是 §7「3 步 1 次往返」断言先红后暴露的——正好说明断言收紧的价值。

---

## 4. 复现方式

```bash
node scripts/selftest.mjs                     # 64 项，无需真机与 dsh
DSH_ADB_SELFTEST_VERBOSE=1 node scripts/selftest.mjs   # 额外打印计时表
node scripts/bench.mjs --steps 5              # 单步耗时对比
node scripts/bench.mjs --real --serial <id>   # 真机 A/B
```

`scripts/mock-device.mjs` 支持故障注入（`faults: { unsupportedCompressed, emptyDumps, dumpErrors, badPng, probePkg }`），原审计指出「错误分支零覆盖」已由这些注入点补齐。
