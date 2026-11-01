# 调研产物（不入库）

写插件之前，为了搞清 dsh 的插件机制（插件如何注册、工具如何声明、profile 如何装配），从桌面端 `app.asar` 里抽出了相关包并做了全文扫描。这些是 **dsh 自身的代码副本**，不是本项目的产出，因此只保留在本地。

| 文件/目录 | 用途 |
|---|---|
| `asar-extract/` | 从 `app.asar` 抽出的 `@deepseek-ai/dsh-plugin-manager`（bundle patch 与安装语义）与 `dsh-client-ui-plugin-manager` |
| `scan-asar.out.txt`（9.4MB） | asar 全文清单，用来定位 `defineTool` / `ctx.tools.register` 的调用点 |
| `scan2.txt`（4.6MB）/ `scan3.txt`（196KB） | 关键字命中片段，确认 tool 定义与 patch 字段形态 |
| `extract-asar.mjs` / `scan-asar.mjs` | 上面两步的脚本 |
| `.dsh-home/` | 一个空的 `profiles/web`，用来观察 profile 目录结构（`package.json` + `cordis.patch.yml`） |

复现方式：需要本机装有 DeepSeek Harness 桌面端，重跑 `scan-asar.mjs` 即可。

**为什么不入库**：内容属于第三方（dsh 发行包）代码，且体积大、与插件运行无关。
