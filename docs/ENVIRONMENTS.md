# 支持的环境

本文件说明 `dsh-quick-adb` 能跑在什么环境、需要满足什么前提、哪些环境**不**保证。
判定标准：能 `adb devices` 看到 `device`、`uiautomator dump` 能返回层级，就算"可用"。

---

## 1. 宿主环境（跑 dsh 的服务器）

| 项 | 要求 | 说明 | 验证状态 |
|---|---|---|---|
| 操作系统 | Linux x86_64 / arm64、macOS、Windows 10+ | 插件是纯 Node ESM，无原生依赖；平台差异只在 adb 可执行文件路径 | Linux/macOS 逻辑等价；Windows 已实跑测试 |
| Node.js | **≥ 20** | 用到顶层 `await`、`Array.prototype.at`、`node:` 前缀导入 | Node 22.22 实跑 |
| dsh | `>=0.1.5-rc.1 <0.3.0-0`（见 `engines.dsh`） | 依赖 `ctx.tools.register` + `@deepseek-ai/dsh-tools` 的 `defineTool`；`systemPrompt` 为可选增强 | 按生产插件契约比对，未跑真实宿主 |
| 包管理器 | pnpm（dsh profile 默认）/ npm | 走 bundle 装配时需要 | 未验证 pnpm 装包路径 |
| 权限 | 能执行 `adb`、能读写 `$DSH_HOME` | 截图与计时日志落在 `$DSH_HOME/quick-adb/` | 已验证 |
| 端口 | 本地 5037（adb server） | 远程 adb server 需 `adb -H <host> -P <port>` 或先建隧道 | 未验证 |

**adb 版本**：建议 platform-tools **≥ 28**。
- `adb exec-out`（截图二进制安全）需要较新版本；
- `input keyevent` 支持多键码需要 Android 端支持（见下）；
- 更老的 platform-tools 也能用，但截图可能触发 `\n`→`\r\n` 损坏，插件会自动退回「设备内落盘 + `adb pull`」。

---

## 2. 设备环境

| 项 | 要求 | 说明 |
|---|---|---|
| Android 版本 | **7.0 (API 24) 及以上建议**；4.4 起 `uiautomator dump` 即存在 | Android 7 起 `input` 命令行为稳定；更低版本未验证 |
| 调试通道 | USB 调试 或 无线调试 | Android 11+ 可用「无线调试 + 配对码」；更早版本用 `adb tcpip 5555` |
| 授权状态 | `adb devices` 显示 `device` | `unauthorized` / `offline` 会被插件明确报错并列出 |
| 屏幕 | 任意分辨率；尊重 `wm size` 的 override | 滑动距离按 `wm size` 换算，读不到时回落 1080×2400 |
| 输入法 | 默认输入法可接受 `input text`（ASCII） | 中文/emoji/含 `%` 文本需装 **ADBKeyboard** 并设 `inputMode: adbkeyboard-b64` |
| 无障碍/自动化 | `uiautomator` 可用（系统自带） | 部分定制 ROM 会禁用或被安全策略拦截 |
| 厂商权限 | 部分 ROM 需额外开「USB 调试（安全设置）」才能模拟点击 | 小米/OPPO/vivo 常见；未开时 `input tap` 静默无效 |

**多设备**：默认要求 profile 内只有一台在线设备；多台必须配 `serial`，否则插件报错并列出现有 serial（不猜）。

---

## 3. 应用环境（被操控的 App）

| 界面类型 | 控件树可用性 | 表现 |
|---|---|---|
| 原生 View / AndroidX | 完整 | 最佳路径：文本、id、bounds 全有 |
| Compose | 大部分可用 | 语义树可被 uiautomator 读到，但部分自绘组件无文本 |
| WebView（未开无障碍） | 只有 1 个节点 | 自动落视觉兜底（慢路径） |
| Flutter | 通常只有少量节点 | 同上；部分版本可通过 `--enable-impeller` 无关，需 App 侧开语义 |
| 游戏 / Unity / 视频 DRM 层 | 空层级或 1 个节点 | 同上 |
| 系统弹窗 / 权限框 | 可用 | 但包名会变成 `com.android.permissioncontroller`，缓存按包名判定会自动重解析 |

---

## 4. 网络与部署形态

| 形态 | 是否支持 | 说明 |
|---|---|---|
| dsh 与设备同机（USB） | ✅ 推荐 | 延迟最低，无网络抖动 |
| dsh 在服务器，设备在另一网段（`adb connect`） | ✅ | 建议 `adb connect` 后用 `adb devices` 固定 serial；RTT 会直接计入单步耗时 |
| 远程 adb server（`adb -H`） | ⚠️ 未验证 | 需要自己保证 5037 可达；插件只调用本机 `adb` |
| 容器内跑 dsh（USB 透传） | ⚠️ 需手动映射 | 容器需 `--device /dev/bus/usb` 或走网络 adb |
| iOS / HarmonyOS NEXT | ❌ 不支持 | 本插件只走 ADB |

---

## 5. 与 dsh 的集成形态

| 形态 | 是否支持 | 说明 |
|---|---|---|
| bundle 装配（`dsh.bundle.patch`） | ✅ | 推荐；`cordis.patch.yml` 已提供 |
| 绝对路径手工挂载（profile patch） | ✅ | 服务器上最快验证；复制 `lib/` + package.json 即可 |
| HMR 热更新 | ✅ | 改配置/补丁即时生效（需 profile 开启 HMR） |
| dsh Web / Desktop / CLI | ✅（理论） | 只依赖 `ctx.tools` 与可选 `systemPrompt`，与前端形态无关 |
| 与其他工具插件共存 | ✅ | 串行队列在插件内部；工具标记 `isConcurrencySafe:false` |

---

## 6. 明确不保证的情况

1. **没有任何真机验证**：本仓库的测试全部跑在替身设备上（见 [VERIFICATION.md](VERIFICATION.md) 第 6 节）。厂商 ROM 的时序差异、`uiautomator` 卡死频率、WebView 行为都未实测。
2. **需要视觉判断的界面**：验证码、图形解锁、游戏画面、图表读数——控件树里没有这些信息，只能走视觉兜底，速度回到旧流程。
3. **强动画界面**：持续动画会让 `uiautomator dump` 长时间拿不到 idle 状态，表现为 dump 超时 → 自动重试 → 仍失败则视觉兜底。
4. **分屏 / 画中画 / 悬浮窗**：只解析当前焦点窗口，另一个窗口的控件不可见。
5. **高并发调用**：插件内部串行，多个 agent 同时操控同一设备会排队，超时预算按单调用计算。
6. **加密/加固界面**：设置 `FLAG_SECURE` 的页面截图会是黑屏，但控件树通常仍可用。

---

## 7. 最小可用自检清单

部署后按顺序确认，任一步失败就先解决该步：

```bash
# 1. adb 能看见设备
adb devices -l                       # 期望状态 device

# 2. 控件树可用（最关键）
adb shell "uiautomator dump --compressed /sdcard/t.xml >/dev/null 2>&1; cat /sdcard/t.xml" | head -3
#    期望看到 <hierarchy ...> 且包含多个 <node>

# 3. 输入可用
adb shell input tap 540 1200         # 期望界面有反应

# 4. 插件自测（不需要设备）
node scripts/selftest.mjs

# 5. 插件在 dsh 内可用
#    会话里执行：adb_screen → adb_tap {"selector":{"text":"设置"}} → adb_timing
```
