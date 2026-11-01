# dsh-quick-adb

给 **dsh**（DeepSeek Harness）加一条 Android 直控通道：**用 `uiautomator` 的控件树替代整屏截图识图**，把高频动作封装成可直接调用的 `adb_*` 工具，并把多步指令合并成一次 ADB 往返。

解决的问题很具体：`dsh` 部署在服务器上、通过 ADB 连手机，原来每一步都要「截图 → 模型识图 → 生成并执行代码」，单步稳定在 3–5 秒。装上本插件后，同一批动作的单步耗时降到 **~0.8 秒**，ADB 往返从 2–3 次/步降到 **1 次/步**。

实测（`node scripts/bench.mjs --steps 5`，mock 设备，dump 520ms / 截图 480ms / 识图 2500ms / 生成代码 1200ms）：

| 路径 | 平均/步 | p50 | 往返/步 | 5 步总耗时 |
|---|---|---|---|---|
| 旧：截图 → 识图 → 生成代码 → 执行 | 4241 ms | 4241 ms | 2.00 | 21.2 s |
| 新：控件树 → 动作合并往返 | **833 ms** | 833 ms | **1.00** | **4.2 s** |

单步加速 **≈5.1×**（多次运行 5.05–5.10；表内为单次示例，数值随调度略有波动）。自测（`node scripts/selftest.mjs`）里，9 个真实场景综合下来是 **0.38 次往返/步**，对照实测的「朴素三步式」是 **3 次/步**。

> 文档索引：问题与修复记录 [AUDIT.md](AUDIT.md)｜自检方法与可信度 [docs/VERIFICATION.md](docs/VERIFICATION.md)｜支持的环境 [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md)｜为什么能做到 [docs/WHY-IT-WORKS.md](docs/WHY-IT-WORKS.md)

---

## 1. 它为什么快：三条主线

### 主线一：把「看图」换成「读结构」

`uiautomator dump` 直接给出控件层级、文本、resource-id、类名、可点击性、精确 bounds。同样的屏幕，截图是 1080×2400 的位图（要上传、要模型推理），dump 是几十 KB 的 XML（本地正则解析，毫秒级），结果**确定性可复现**——不需要模型猜坐标。

| 维度 | 截图 + 识图（旧） | `uiautomator dump`（本插件） |
|---|---|---|
| 单次耗时 | 截图 300–600ms + 模型推理 1–4s | 300–800ms，无模型参与 |
| 输出 | 位图，坐标靠模型估计 | 结构化文本 / id / 类名 / bounds |
| 可复现性 | 每次可能不同 | 同一界面完全一致 |
| 何时失效 | 基本不失效 | WebView / Flutter / 游戏 / DRM（自绘界面） |

失效场景由第 5 节的兜底阶梯接管，不是硬失败。

### 主线二：动作与「重新感知」合并成一次往返

朴素实现的一步是三条命令：

```
adb shell uiautomator dump /sdcard/ui.xml     ← 往返 1
adb shell cat /sdcard/ui.xml                  ← 往返 2
adb shell input tap 540 1200                  ← 往返 3
然后还得再 dump 一次才知道点完是什么界面          ← 往返 4、5
```

本插件把它压成一条：

```bash
adb shell "input tap 540 1200; sleep 0.25; uiautomator dump --compressed /sdcard/dsh_ui_x.xml >/dev/null 2>&1; cat /sdcard/dsh_ui_x.xml"
```

**一次往返**完成「点击 + 稳定等待 + 取回新界面」，返回值里直接带新界面的可点击目标摘要——所以模型下一步**不需要再调 `adb_screen`**。

### 主线三：同一界面内的重复读取走缓存

| 层级 | 条件 | 代价 |
|---|---|---|
| **L1 精确命中** | 无动作发生 且 年龄 ≤ `softTtlMs`(800ms) | **0 次往返** |
| **L2 探测复核** | 无动作发生 且 年龄 ≤ `hardTtlMs`(15s) | 1 次 ~110ms 的 `dumpsys window` |
| **L3 重新解析** | 做过动作 / 过期 / 探测不符 | 1 次往返（dump + cat） |
| **L4 视觉兜底** | 控件树不可用 / 定位失败 | 截图 + 可选视觉命令 |

**任何会改变界面的动作都会把缓存标记为 `dirty`**，下一次感知直接走 L3——绝不拿旧树去点新界面。而动作本身已经顺带 dump 了新界面，所以这笔开销在实际运行中很少真的发生。

---

## 2. 安装

### 设备侧（服务器上）

```bash
adb start-server
adb connect 192.168.1.20:5555      # 无线调试；USB 直连可跳过
adb devices -l                      # 必须看到状态 device
```

### 方式 A：作为 bundle 装配（推荐）

```bash
# 把本目录作为包加入 profile（或从 npm / git 安装后启用 bundle）
# Web 侧栏 → Plugins 页安装并启用；具体子命令以 dsh plugin --help 为准
```

`package.json` 已声明：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`cordis.patch.yml`（顶层必须是 YAML 数组）：

```yaml
- insert:
  - id: dsh-quick-adb
    name: 'dsh-quick-adb'
    # config: { serial: '192.168.1.20:5555', settleFastMs: 200 }
```

### 方式 B：绝对路径手工挂载（不装包，服务器上最快验证）

在 profile 层 patch（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）的既有 `insert` 块里加一条绝对路径：

```yaml
- insert:
  - id: dsh-quick-adb
    name: /opt/dsh-plugins/dsh-quick-adb/lib/index.js
    config:
      serial: '192.168.1.20:5555'
      settleFastMs: 200
```

`lib/` 只有相对导入与 Node 内置模块，**复制整个 `lib/` + package.json 即可**；`@deepseek-ai/*` 由宿主进程解析。

### 验证

```bash
node scripts/selftest.mjs    # 64 项断言（装进 dsh 后另跑 16 项工具层断言，共 80）
node scripts/bench.mjs       # 优化前后单步耗时对比
```

---

## 3. 文件结构

```
dsh-quick-adb/
├── package.json          # dsh.bundle.patch；dshx.contributes.tools
├── cordis.patch.yml      # bundle patch（insert）
├── README.md  AUDIT.md
├── docs/                 # 自检方法/环境/原理
├── lib/
│   ├── index.js          # 插件入口：name / inject / Config / apply
│   ├── schema.js         # schemastery 配置 + 独立默认值归一化
│   ├── adb.js            # 低层 ADB 封装（一次 run = 一次往返）
│   ├── xml.js            # dump XML 解析（零依赖）
│   ├── dump.js           # 界面模型：标签、签名、可点击目标
│   ├── selector.js       # 控件定位：评分 + 可点击性提升 + nth 越界报错
│   ├── cache.js          # 单槽缓存 + L1/L2 判定计数
│   ├── perceive.js       # 感知层：dump / probe / 分层复用
│   ├── actions.js        # 动作执行器：唯一的「settle + dump + 失效」出口
│   ├── engine.js         # 编排：定位、兜底、校验、公开动作
│   ├── batch.js          # 批量编译：多步压成少量往返
│   ├── vision.js         # 截图与外部视觉命令
│   ├── timing.js         # 计时日志（JSONL）+ 聚合报告
│   ├── tools.js          # 10 个 adb_* 工具（defineTool）
│   ├── errors.js  util.js
├── scripts/              # selftest / bench / mock-device
└── fixtures/             # 三种真实形态的 dump XML
```

---

## 4. 工具清单

| 工具 | 作用 | 典型往返 |
|---|---|---|
| `adb_screen` | 读界面（可顺带定位一个控件，命中坐标写进返回文本） | 0–1 |
| `adb_tap` | 点击（selector 或数字坐标，支持长按） | 1 |
| `adb_swipe` | 滑动（方向 / 显式起止点 / 指定控件内） | 1 |
| `adb_input` | 输入文本（可定位、清空、回车提交） | 1 |
| `adb_key` | 返回/Home/回车/删除…，连按也只花 1 次 | 1 |
| `adb_wait` | 等元素出现/消失，或等界面稳定（`idle`） | 0–1/轮 |
| `adb_batch` | 批量执行多步，合并往返 | 1–2/批 |
| `adb_app` | 启动/停止/重启/清数据/查前台/查状态 | 1 |
| `adb_shell` | 逃生口（受 `allowShell` 控制） | 1 |
| `adb_timing` | 耗时与缓存命中报告 | 0 |

选择器统一是对象（传字符串等价于 `{text}`）：

```json
{"text": "设置"}
{"textContains": "登录"}
{"id": "btn_ok"}                       // 简写也能命中 com.foo:id/btn_ok
{"cls": "Button", "nth": 1}            // nth 越界会报错，不会静默取最后一个
{"text": "搜索", "clickable": true}
```

两个容易被忽略、但显著影响命中率的设计：

- **可点击性提升**：文案节点常 `clickable=false`（按钮 = 可点击容器 + 内部 TextView）。定位到文本后向上找最近的可点击祖先，并跳过面积超过界面 70% 的「伪容器」。
- **评分而非首个命中**：精确文案 > 包含 > 正则；自身文本 > 子孙聚合标签；同分取面积更小、层级更浅的节点。

---

## 5. 兜底阶梯（触发条件写死在代码里）

| 触发条件 | 处理 |
|---|---|
| 缓存年龄 ≤ `softTtlMs` 且无动作 | 直接复用（0 往返） |
| 缓存年龄 ≤ `hardTtlMs`、无动作、focus 探测包名/Activity 一致 | 复用并标记 `cache-verified`（1 次 ~110ms） |
| 做过动作 / 探测不一致 / 显式 `invalidate` | 完整 dump（1 往返） |
| dump 超时 | 本次改普通 dump 重试；**不**永久关闭压缩 |
| 设备不认识 `--compressed` | 永久降级为普通 dump |
| dump 返回空层级 | 重试一次；仍失败抛 `dump-failed` |
| 控件定位失败 | 强制重解析一次再试 |
| 重试后仍失败 | 截图；配了 `visionCommand` 就换算坐标继续点，否则报错附截图路径 |
| `wait` 超时 | 抛错并附「最后界面摘要」 |

`visionCommand` 是一个外部命令，stdout 返回 `{"items":[{"text":"确定","x":540,"y":1820}]}`，插件据此算坐标。不配置时只落盘截图并把路径交回模型。

---

## 6. 批量指令

```json
{
  "steps": [
    {"tap": "搜索"},
    {"wait": 200},
    {"input": {"text": "hello world", "submit": true}},
    {"waitFor": {"textContains": "结果"}},
    {"swipe": "up"},
    {"dump": true},
    {"shell": "dumpsys battery | head -3"}
  ],
  "verify": true
}
```

执行策略：**先离线解析、再一次性下发**——选择器先在缓存树上解析成坐标（0 往返），连续动作拼成一条 shell，只有「解析不了 / 需要看界面」时才切段插 dump，结尾一次 dump 同时充当「验证 + 下一步感知」。

往返账（`selftest` 实测，不是估算）：

| 实现方式 | 往返/步 |
|---|---|
| 朴素三步式（dump / cat / input 各一次） | 3.00 |
| 本插件（综合 8 步场景） | **0.38** |

批处理还会按累计时长切段：整段脚本超过 `actionTimeoutMs × 0.6` 就提前分段，避免撞上超时被 kill、设备停在中间状态。

---

## 7. 配置项

| 配置项 | 默认 | 说明 |
|---|---|---|
| `adbPath` | `$DSH_QUICK_ADB_BIN` 或 `$ANDROID_ADB` 或 `adb` | adb 可执行文件 |
| `serial` | 空（自动选唯一设备） | 目标设备；多设备必填 |
| `softTtlMs` | `800` | L1 复用窗口 |
| `hardTtlMs` | `15000` | L2 探测复核上限 |
| `verifyProbe` | `true` | 是否启用 L2 |
| `dumpTimeoutMs` | `8000` | 单次 dump 超时 |
| `actionTimeoutMs` | `20000` | 动作脚本（含 sleep+dump）超时 |
| `waitTimeoutMs` | `10000` | `adb_wait` 默认超时 |
| `settleFastMs` / `settleMediumMs` / `settleSlowMs` | `250` / `700` / `1500` | 动作后到重新解析之间的等待 |
| `stepDelayMs` | `120` | 批处理中相邻盲动作间隔 |
| `waitProbeFirst` | `true` | 等待时先用轻探测判断界面切换 |
| `probeFirstMaxMs` | `1500` | 轻探测优先阶段上限 |
| `inputMode` | `auto` | `auto` / `input` / `adbkeyboard` / `adbkeyboard-b64` |
| `adbKeyboardInstalled` | `false` | 设备装了 ADBKeyboard 时，`auto` 走 base64 |
| `visionFallback` | `true` | 是否允许视觉兜底 |
| `visionCommand` | 空 | 外部视觉命令（见第 5 节） |
| `visionTimeoutMs` | `20000` | 视觉命令超时 |
| `screenshotDir` | `<dsh-home>/quick-adb/shots` | 兜底截图目录 |
| `maxShots` | `50` | 截图保留张数，超出按时间清理 |
| `allowShell` | `true` | 是否允许 `adb_shell`（批量的 `shell` 步骤同受此限） |
| `maxOutputChars` | `8000` | `adb_shell` 返回上限 |
| `timingEnabled` | `true` | 是否落盘 JSONL |
| `timingFile` | `<dsh-home>/quick-adb/timing.jsonl` | 计时日志路径 |
| `baselineStepMs` / `baselineAdbCalls` | `0` | 优化前基线，用于报告算加速比 |
| `includeScreenInAction` | `true` | 动作结果是否附界面摘要 |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` |

---

## 8. 用计时日志证明「真的变快了」

每次操作写一条 JSONL（`<dsh-home>/quick-adb/timing.jsonl`）：

```json
{"ts":"2026-11-01T06:12:07.412Z","op":"tap","kind":"op","wallMs":812,"adbCalls":1,"source":"dumped","ok":true,"serial":"192.168.1.20:5555"}
```

会话内看：

```
adb_timing                      # 全部样本
adb_timing {"last": 50}         # 最近 50 步
adb_timing {"includeInternal": true}   # 连内部 dump/probe 一起看
```

严格的 A/B：

```bash
# 旧流程基线（同一台设备、同一批坐标）；--vision-ms / --gen-ms 换成你自己日志里的实测值
node scripts/bench.mjs --real --serial 192.168.1.20:5555 --x 540 --y 1200 --steps 10 \
  --vision-ms 2500 --gen-ms 1200

# 把基线写进配置，之后 adb_timing 的结论与 bench 完全一致
#   baselineStepMs: 4241
#   baselineAdbCalls: 2.00
```

判定标准：看 **p95** 而不是均值；**往返/步 ≤ 1.2** 才算合并生效；**零成本命中率 > 60%** 才算缓存有效；**视觉兜底计数为 0** 是健康信号。

---

## 9. 安全边界

- `allowShell: false` **同时**约束 `adb_shell` 与 `adb_batch` 的 `shell` 步骤（v0.2 修复）。
- `adb_app` 的 `package` / `activity` 先做白名单校验（`com.example.app` 形态），非法输入直接拒绝且不产生任何 ADB 调用；命令里再做一层引号包裹。
- `adb_input` 的文本经单引号转义，不会注入到设备 shell。
- `visionCommand` 走 `spawn(shell:true)`，**配置即代码执行**，只填可信命令；默认空即禁用。
- 截图与 dump 文本可能含敏感信息，注意落盘目录权限与模型上下文暴露范围。

---

## 10. 已知限制

1. **自绘界面拿不到控件树**：WebView（未开无障碍）、Flutter、Unity/游戏、部分 DRM 页会 dump 出 1 个节点或空层级，自动落到视觉兜底（仍是慢路径）。
2. **中文输入**：`input text` 多数设备只吃 ASCII；需装 ADBKeyboard 并设 `inputMode: adbkeyboard-b64`。含 `%` 的文本同样建议走 base64——`input text` 用 `%s` 表示空格，字面 `%s` 无法表达。
3. **同一 Activity 内的界面变化**：focus 不变时 L2 只能靠「无动作 + 时间窗」保证不复用陈旧数据；任何动作后缓存立即作废，这是刻意选择。
4. **`--compressed` 兼容性**：老设备不支持时自动降级；单纯超时不会永久降级（v0.2 修复）。
5. **多设备**：要求 profile 内只有一台在线设备，多台必须显式配 `serial`，否则直接报错并列出现有设备。
6. **密码框**：`uiautomator` 通常不返回密码明文；但其他文本会进入模型上下文，涉密界面请自行控制。

---

## 11. 测试

```bash
node scripts/selftest.mjs     # 64 项（无 dsh 依赖）；装进 dsh 后多跑 16 项工具层断言，共 80 项
node scripts/bench.mjs        # 单步耗时对比（mock 或 --real）
```

覆盖：解析 / 定位 / L1 / **L2** / 动作合成 / **settle:none 失效** / 批处理 / **verify:false 失效** / **allowShell 全链路** / **包名注入** / 等待超时上界 / **dump 降级链** / 视觉兜底（含 `visionCommand` 成功路径）/ 计时 / 工具层。

---

License: MIT
