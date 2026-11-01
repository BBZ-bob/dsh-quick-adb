# 问题清单与修复记录

- 审计对象：`dsh-quick-adb@0.2.0`（原 `dsh-android-adb@0.1.0`）
- 审计时间：2026-11-01
- 状态：**48 项全部关闭**（46 项修复 + 2 项按设计保留并文档化）
- 自检方法与可信度：见 [docs/VERIFICATION.md](docs/VERIFICATION.md)
- 回归入口：`node scripts/selftest.mjs`（95 项；装进 dsh 后 117 项）

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
node scripts/selftest.mjs                     # 95 项，无需真机与 dsh
DSH_ADB_SELFTEST_VERBOSE=1 node scripts/selftest.mjs   # 额外打印计时表
node scripts/bench.mjs --steps 5              # 单步耗时对比
node scripts/bench.mjs --real --serial <id>   # 真机 A/B
```

`scripts/mock-device.mjs` 支持故障注入（`faults: { unsupportedCompressed, emptyDumps, dumpErrors, badPng, probePkg }`），原审计指出「错误分支零覆盖」已由这些注入点补齐。

---

## 4. 实机复测发现的问题（2026-11-01，R1–R6）

使用者部署在云端的 dsh 实例（阿里云 Debian + 荣耀平板 Android 16 + easytier，RTT 125ms）经 QQ 通道驱动复测，在真实链路上暴露了 6 个 mock 测不出来的问题。注意这是**被测系统自测**——测量与执行是同一个 agent，存在自报口径偏差（见 VERIFICATION 局限）。

| ID | 严重度 | 问题 | 证据 | 修复 | 回归 |
|---|---|---|---|---|---|
| R1 | **严重（功能不可用）** | `adb_batch` 返回值含 `point: undefined`，被 dsh 判为 `value is not lossless JSON`，4 次测试 3 次失败 | 报告 5.3-5 | 改成按需挂载字段，不再写 `undefined` | §15「lossless JSON」×2 |
| R2 | **严重（兜底断裂）** | dump 彻底失败时 `resolveWithFallback` 直接抛错，`adb_tap` 不走视觉兜底 | B 站播放页 | catch dump 错误后直接降视觉；`adb_screen` 也改为返回截图兜底而不是抛错 | §12 |
| R3 | 中 | dump 失败后换模式重试，等待翻倍（2×2.4s） | 报告第 2 条建议 | 区分「与压缩模式无关的失败」（idle 卡死/超时）不再重试；失败后记住该界面并在 `skipDumpMs` 内跳过 | §12 |
| R4 | 中 | `adb_app` 默认 `settle=medium`，启动比裸 adb 慢 61%（656→1054ms） | 报告 7.4 | 新增 `appSettle`，默认 `none`：启动就是启动，需要界面再传 settle | §15 |
| R5 | 中 | 连按按键间隔固定 200ms，返回两次多花 ~140ms | 报告 7.4（328→468ms） | 新增 `keyDelayMs`，默认 80ms | §15 |
| R6 | 低 | `adb_screen` 在不可解析界面直接抛错，模型拿不到任何可用信息 | 报告第 2 条建议 | 改为返回 `source=vision` + 截图路径 + 原因 | §12 |
| R7 | 低 | 批量末尾已有 `{dump:true}` 时，收尾的 `verify` 又补一次 dump，白付一次往返 | 0.2.1 现场复测：`swipe/swipe/dump` = 2 次往返 6434ms | 记录 `dirty`，收尾只在「上次 dump 后仍动过界面」时才 dump | §7 |
| R8 | **严重（性能陷阱）** | 默认开 `--compressed`，而部分设备 compressed 比 plain 慢 4–5 倍（11.5s vs 2.3–3.7s） | P3b 9.3，定位点按 3418→5345ms | 默认改 plain；新增 `dumpMode`；auto 下 plain 偏慢才试一次 compressed（3s 上限），试完定死 | §12b |
| R9 | **严重（脚本中断）** | dump 超时抛 ActionError，打断整条流水线 | P3b 9.4（现场崩两次） | 批量 flush 捕获异常标 `degraded` 继续；`adb_wait` 超时改为返回 `ok:false`；`adb_screen` 返回截图兜底 | §12c、§11 |
| R10 | 中 | `dumpTimeoutMs=8000` 让一次失败等太久 | P3b 9.4 | 默认 5000；试 compressed 时 3000 | §12 |
| R11 | 中 | `softTtlMs=800` 让动作返回的树很快过期 | P3b 建议 5 | 默认 1500 | §3 |
| R12 | 低 | 纯动作仍要付感知的钱 | P3b 建议 4 | 新增 `perceive:false`（等价 settle=none） | §15 |
| R13 | **严重（性能）** | `adb_tap(selector)` 默认做两遍 dump（定位 + 确认），慢 dump 设备上动作耗时翻倍 | P3c：0.2.3 定位点按 5771ms，`settle=none` 实测 2655/2991ms | 测量本机 dump 成本，超过 `slowDeviceDumpMs`（1500ms）自动单 dump 模式；显式 settle 优先 | §12d |
| R14 | 中 | 动作定位彻底失败时抛错，可能打断调用方脚本 | P3b 9.4 延伸 | `adb_tap` 返回 `ok:false` + 原因，不再抛出 | §13 |
| R15 | **严重（API 语义）** | `settle` 把「等待」与「确认 dump」捆绑：显式传 `settle:'fast'` 会覆盖设备自适应，被迫多付一遍确认 dump | P3d：0.2.4 定位点按仍 5409ms，`settle=none` 2848ms | 拆分为 `settle`（只等待）与 `confirm`（是否解析）；auto 在定位之后按本机成本判定 | §12d |
| R16 | 中 | auto 只跳过确认 dump、仍保留 250ms 等待，纯动作比 0.2.4 回退 | P3e：home 197→234、back 162→296 | 未显式指定 settle 时，跳过确认即同时跳过等待 | §12e |
| R17 | 中 | dump 成本只存在内存，重启后第一枪又按“快设备”处理 | P3e 建议 2 | 设备画像按 serial 落盘（`devices.json`），启动即读 | §12e |
| R18 | 低 | `adb_timing` 看不出这台设备是否值得开 confirm | P3e 建议 4 | 表头输出 `设备 dump ≈ Xms` + 建议 | §15 |
| R19 | 中 | `buildTree` 写的是 `clickables`（复数），引擎读 `tree.clickable`（单数）→ 界面表头永远显示「可点击=0」，而下面却列出 N 个目标 | P3f 现场：`节点=38 可点击=0` 后跟 5 个可点击项 | 字段改名为 `clickable`；表头改用「去重后实际列出的目标数」，与清单严格一致 | §15 |
| R20 | 低 | 即使改对字段，节点级计数与目标清单仍用两套过滤（节点数含未启用/未去重），两个数字可能仍不一致 | 复测反馈：建议统一口径 | 节点级计数改名 `clickableNodes`，只用于诊断；所有对外展示统一为 `目标=N`（等于清单条数） | §1、§15 |
| R21 | 低 | 自测失败路径不清理临时目录，累计在 `/tmp` 留下 929 个 `dsh-qadb-*` | 本地清理时发现 | 注册 `process.on('exit')` 统一回收所有 mkdtemp 目录 | 手工验证：连跑两次 0 残留 |

### 对「用 `exec-out uiautomator dump /dev/tty`」建议的回应

建议本身对（少两次往返），但**本插件已经是更优形态**：dump 与 cat 在同一条 shell 内完成，一次 ADB 调用。复测里的两组数据正好印证：

| 路径 | 实测 |
|---|---:|
| 拉文件式（dump / pull / rm） | 3486 ms |
| `exec-out uiautomator dump /dev/tty` | 2664 ms |
| 本插件（`dump; cat` 单次往返） | **2431–2506 ms** |

因此没有改成 `/dev/tty`：它在部分 ROM 上会把状态行混进 stdout，稳定性不如落盘+cat，而耗时已经更低。

### 结论修正

README 原文用 mock 数据宣称「单步 ~0.8s、5 步 4.2s」，在真实链路（dump 2.4s）下不成立。已在 README 第 0 节按实测重写，并明确：**插件只在「需要感知」的流程里划算；固定坐标流水线逐步调用工具是负优化（+32%）。**
