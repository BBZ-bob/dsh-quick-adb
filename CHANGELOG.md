# 变更记录

遵循语义化版本；每条对应一次实机复测暴露的问题。

## 0.2.8 — 2026-11-01

- 统一可点击计数口径：节点级计数改名 `clickableNodes` 仅作诊断，对外展示一律 `目标=N`（严格等于清单条数）
- 修复 `目标=0` 而清单有 N 条的矛盾（字段名复数/单数不一致）

## 0.2.7 — 2026-11-01

- 修复界面表头永远显示「可点击=0」（`clickables` vs `clickable`）

## 0.2.6 — 2026-11-01

- 纯动作不再多睡：auto 跳过确认 dump 时，未显式指定 settle 也一并跳过等待
- 设备画像按 serial 落盘（`devices.json`），重启后直接复用 dump 成本与模式
- `adb_timing` 表头输出 `设备 dump ≈ Xms` 与 confirm 建议

## 0.2.5 — 2026-11-01

- `settle` 与 `confirm` 解耦：settle 只控制等待，confirm 控制是否重新解析
- 显式传 `settle:'fast'` 不再隐含确认 dump（此前每次多付 ~2.5s）
- 新增 `confirm` 参数（false/true/auto）

## 0.2.4 — 2026-11-01

- 慢 dump 设备自动单 dump 模式（`slowDeviceDumpMs`，默认 1500ms）
- `adb_tap` 定位彻底失败改为返回 `ok:false`，不再抛错打断脚本

## 0.2.3 — 2026-11-01

- `--compressed` 改为设备自探测：默认 plain，plain 偏慢才试一次 compressed（3s 上限）
- dump 超时不再抛错：批量标 `degraded` 继续、`adb_wait` 返回 `ok:false`、`adb_screen` 给截图兜底
- `dumpTimeoutMs` 8000 → 5000；新增 `perceive:false` 纯动作通道；`softTtlMs` 800 → 1500

## 0.2.2 — 2026-11-01

- 批量收尾不再重复 dump（末尾已有 `{dump:true}` 时省一次往返）

## 0.2.1 — 2026-11-01

- `adb_batch` 返回值含 `undefined` 导致 `not lossless JSON`（现场 3/4 次失败）
- dump 彻底失败时 `adb_tap` 走视觉兜底，不再直接抛错
- dump 失败不再换模式重试（等待翻倍）；失败界面在 `skipDumpMs` 内跳过
- `adb_app` 默认 `settle=none`；连按间隔 200 → 80ms
- 修正 peer 依赖范围（`@deepseek-ai/schemastery` 实际为 3.18.x），改为可选 peer

## 0.2.0 — 2026-11-01

- 首个可用版本：10 个 `adb_*` 工具、控件树感知、分层缓存、批量编译、计时日志
- 名称统一为 `dsh-quick-adb`（npm / GitHub / 本地均未占用）
- 关闭初始审计的 27 项问题（命令注入、`allowShell` 绕过、缓存不失效、`nth` 越界等）

## 0.1.0 — 2026-10-31

- 内部原型（`dsh-android-adb`），未发布
