/**
 * dsh-quick-adb —— 给 dsh 的 Android 设备操作插件。
 *
 * 目标：把「每步截图 → 模型识图 → 生成代码 → 执行」压成「读控件树 → 直接调动作」，
 * 单步耗时从秒级降到百毫秒级。
 *
 * 接入方式（不改 dsh 核心）：
 *   package.json  `dsh.bundle.patch` 指向 cordis.patch.yml，
 *   cordis.patch.yml 用 insert 挂载本文件；本文件按 Cordis 插件约定导出
 *   name / inject / Config / apply，工具通过 ctx.tools.register 注册。
 *
 * 依赖声明刻意收窄为 `tools`：systemPrompt 只是「有则加一段提示」的增强，
 * 不应成为挂载的硬前提（审计 P3-7）。
 * @module dsh-quick-adb
 */
import { join } from 'node:path';
import { Adb } from './adb.js';
import { ScreenCache } from './cache.js';
import { AndroidEngine, dshHome } from './engine.js';
import { Config, normalizeConfig } from './schema.js';
import { TimingLog } from './timing.js';
import { registerTools } from './tools.js';

export const name = 'quick-adb';

/** 只需要工具运行时；其余能力通过 ctx.get 可选获取。 */
export const inject = ['tools'];

export { Config };

const LOG_RANK = { debug: 10, info: 20, warn: 30, error: 40 };

const PLATFORM_PROMPT = `[Android 设备操作 · dsh-quick-adb] 你可以用 adb_* 工具直接操控已通过 ADB 连接的手机，不需要自己拼 adb 命令，也不需要截图识图。
- 感知优先：adb_screen 返回可点击目标、文案与坐标，通常 0 次 ADB 往返；用文案/ID 定位，比记坐标稳。
- 单步动作：adb_tap / adb_input / adb_swipe / adb_key 会在同一次往返内返回新界面摘要，**不要**紧接着再调 adb_screen。
- 多步固定流程：用 adb_batch 一次提交（如 点击搜索 → 输入关键词 → 回车 → 等结果），往返次数最少。
- 等页面：用 adb_wait（until=appear/disappear/idle），不要用长 sleep 硬等。
- 只有界面是 WebView/Flutter/游戏等自绘场景导致控件树为空时，才退回截图；adb_tap 已内置视觉兜底。
- 所有工具都走同一台已连接设备；换设备请改插件配置 serial。`;

/**
 * 挂载插件。
 * @param {object} ctx - Cordis 插件上下文
 * @param {object} rawConfig - 配置（经 Config 校验后传入）
 */
export function apply(ctx, rawConfig) {
    const config = normalizeConfig(rawConfig);
    const log = (level, message) => {
        if ((LOG_RANK[level] ?? 20) < LOG_RANK[config.logLevel])
            return;
        const line = `[dsh-quick-adb] ${message}`;
        if (level === 'error')
            console.error(line);
        else if (level === 'warn')
            console.warn(line);
        else
            console.log(line);
    };

    const home = join(dshHome(), 'quick-adb');
    if (config.deviceCacheFile === '')
        config.deviceCacheFile = join(home, 'devices.json');
    const timing = new TimingLog({
        file: config.timingFile !== '' ? config.timingFile : join(home, 'timing.jsonl'),
        enabled: config.timingEnabled,
        log,
    });
    const adb = new Adb({
        adbPath: config.adbPath,
        serial: config.serial,
        timeoutMs: config.actionTimeoutMs,
        log,
    });
    const cache = new ScreenCache({ softTtlMs: config.softTtlMs, hardTtlMs: config.hardTtlMs });
    const engine = new AndroidEngine({ config, adb, timing, cache, log });

    ctx.effect(() => {
        const disposeTools = registerTools(ctx, engine, config);

        // 系统提示是增强项：拿不到就跳过，不影响工具可用
        let disposePrompt = null;
        try {
            const systemPrompt = typeof ctx.get === 'function'
                ? (ctx.get('systemPrompt') ?? ctx.systemPrompt)
                : ctx.systemPrompt;
            if (typeof systemPrompt?.section === 'function') {
                disposePrompt = systemPrompt.section({
                    name: 'tool:quick-adb',
                    order: 80,
                    text: PLATFORM_PROMPT,
                });
            }
            else {
                log('debug', '宿主未提供 systemPrompt 服务，跳过使用指引注入');
            }
        }
        catch (error) {
            log('warn', `系统提示注册失败（不影响工具可用）：${error instanceof Error ? error.message : String(error)}`);
        }

        log('info', `mounted (adb=${config.adbPath}, serial=${config.serial || 'auto'}, softTtl=${config.softTtlMs}ms, settle=${config.settleFastMs}ms, timing=${config.timingEnabled ? 'on' : 'off'})`);

        return () => {
            try {
                if (typeof disposeTools === 'function')
                    disposeTools();
                if (typeof disposePrompt === 'function')
                    disposePrompt();
            }
            finally {
                void timing.flush();
            }
        };
    }, 'dsh-quick-adb.mount');
}

export default { name, inject, Config, apply };
