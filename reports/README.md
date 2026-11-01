# 本地复测原始报告（不入库）

本目录存放实机复测的**原始报告**，由使用者的 dsh 经 QQ 通道产出。

**为什么被 .gitignore 排除**：原始报告包含设备内网地址（`adb connect` 端点）、局域网 IP、内部会话名等现场信息，而本仓库是公开的。脱敏后的结论已汇总进 [`docs/RESULTS.md`](../docs/RESULTS.md)，那才是对外可引用的版本。

当前文件：

| 文件 | 内容 |
|---|---|
| `benchmarks/dsh-quick-adb基准报告-含流水线复测.md` | P1 单动作基准 + P2 固定坐标流水线 |
| `benchmarks/dsh-quick-adb基准报告-P3b.md` | P3b：稳定界面 + 定位步骤；compressed 陷阱 |
| `benchmarks/dsh-quick-adb基准报告-0.2.3.md` | 0.2.3 复测：双 dump 是瓶颈 |
| `benchmarks/dsh-quick-adb基准报告-0.2.4.md` | 0.2.4 复测：settle 与 confirm 耦合 |
| `benchmarks/dsh-quick-adb基准报告-0.2.5.md` | 0.2.5 复测：−19.8%，confirm 三态探针 |

新增报告直接放进 `benchmarks/` 即可，不会被提交。
