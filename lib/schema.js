/**
 * 插件配置：schemastery 描述（设置页可编辑）+ 独立默认值/归一化。
 *
 * 归一化独立于 schemastery，好处是：宿主未安装 schemastery 时（例如手动挂载
 * 单文件部署），`apply()` 依然能拿到完整配置而不是一堆 undefined。
 * @module dsh-quick-adb/schema
 */
import { clamp } from './util.js';

let z;
try {
    ({ default: z } = await import('@deepseek-ai/schemastery'));
}
catch {
    try {
        ({ default: z } = await import('schemastery'));
    }
    catch {
        z = undefined;
    }
}

export const DEFAULTS = {
    /** adb 可执行文件；留空用 $ANDROID_ADB 或 PATH 中的 adb。 */
    adbPath: '',
    /** 目标设备序列号；留空自动选择唯一在线设备。 */
    serial: '',
    /** 缓存软 TTL：无动作发生时，此时间内直接复用，0 次 ADB。 */
    softTtlMs: 1500,
    /** 缓存硬 TTL：超过软 TTL 后仍可用一次 ~100ms 的 focus 探测复核。 */
    hardTtlMs: 15000,
    /** 是否允许 focus 探测复核（L2）。关闭后过期即重新 dump。 */
    verifyProbe: true,
    /** dump 模式：auto（先 plain，慢则试一次 compressed）/ plain / compressed。 */
    dumpMode: 'auto',
    /** auto 模式下 plain 平均超过该值才尝试 compressed。 */
    slowDumpMs: 4000,
    /** 试 compressed 时的超时上限，避免一次试错等太久。 */
    trialDumpTimeoutMs: 3000,
    /** 单次 dump 超时；动画剧烈的界面容易卡住 uiautomator。 */
    dumpTimeoutMs: 5000,
    /** 动作（含同一条脚本里的 sleep + dump）超时。 */
    actionTimeoutMs: 20000,
    /** adb_wait 默认超时。 */
    waitTimeoutMs: 10000,
    settleFastMs: 250,
    settleMediumMs: 700,
    settleSlowMs: 1500,
    /** 批处理中相邻盲动作的间隔。 */
    stepDelayMs: 120,
    /** 等待时先用轻探测判断「界面是否换了」，避免每轮整树解析。 */
    waitProbeFirst: true,
    probeFirstMaxMs: 1500,
    /** 文本注入方式：auto / input / adbkeyboard / adbkeyboard-b64。 */
    inputMode: 'auto',
    /** 设备已装 ADBKeyboard 时，auto 模式对非 ASCII 走广播注入。 */
    adbKeyboardInstalled: false,
    /** adb_app 默认等待：none 只启动不取界面（P2 实测启动慢 61% 的主因）。 */
    appSettle: 'none',
    /** 连按之间的间隔（毫秒）；原 200ms 让「返回两次」多花约 140ms。 */
    keyDelayMs: 80,
    /** 点击输入框后到开始输入的等待（毫秒）。 */
    inputFocusDelayMs: 80,
    /** 判定「该界面不可 dump」后的跳过时长（毫秒）。 */
    skipDumpMs: 60000,
    /** 直接跳过 dump 的包名/Activity 正则（逗号分隔）。 */
    skipDumpPatterns: '',
    /** 控件树失败时是否允许视觉兜底。 */
    visionFallback: true,
    /** 外部视觉命令（stdout 输出 JSON 文本块），留空则只落盘截图。 */
    visionCommand: '',
    visionTimeoutMs: 20000,
    /** 截图目录；留空用 <dsh-home>/quick-adb/shots。 */
    screenshotDir: '',
    /** 是否允许 adb_shell 任意命令（batch 的 shell 步骤共用此开关）。 */
    allowShell: true,
    /** 截图最多保留多少张，超出后按时间清理。 */
    maxShots: 50,
    /** 日志级别：debug / info / warn / error。 */
    logLevel: 'info',
    maxOutputChars: 8000,
    timingEnabled: true,
    /** 计时日志路径；留空用 <dsh-home>/quick-adb/timing.jsonl。 */
    timingFile: '',
    /** 优化前基线：用于在报告里直接算加速比（0 = 不对比）。 */
    baselineStepMs: 0,
    baselineAdbCalls: 0,
    /** 动作成功后是否在结果里附上最新界面摘要（省掉一次 screen 调用）。 */
    includeScreenInAction: true,
};

export const Config = z === undefined
    ? undefined
    : z.object({
        adbPath: z.string().default('').description('adb 可执行文件路径；留空则用 $ANDROID_ADB 或 PATH 中的 adb'),
        serial: z.string().default('').description('设备序列号（adb devices 第一列）；留空自动选择唯一在线设备'),
        softTtlMs: z.number().default(1500).description('缓存软 TTL（毫秒）：无动作时直接复用解析结果，0 次 ADB'),
        hardTtlMs: z.number().default(15000).description('缓存硬 TTL（毫秒）：过期后先用 focus 轻探测复核再决定是否重解析'),
        verifyProbe: z.boolean().default(true).description('是否允许 focus 轻探测复核（关闭则过期即重新 dump）'),
        dumpMode: z.union([z.const('auto'), z.const('plain'), z.const('compressed')]).default('auto')
            .description('dump 模式：auto 先 plain，慢才试 compressed；plain 最稳；compressed 需按设备实测'),
        slowDumpMs: z.number().default(4000).description('auto 模式下 plain 平均超过该值才尝试 compressed'),
        trialDumpTimeoutMs: z.number().default(3000).description('试 compressed 时的超时上限（毫秒）'),
        dumpTimeoutMs: z.number().default(5000).description('单次 uiautomator dump 超时（毫秒）'),
        actionTimeoutMs: z.number().default(20000).description('动作脚本（含 sleep + dump）超时（毫秒）'),
        waitTimeoutMs: z.number().default(10000).description('adb_wait 的默认超时（毫秒）'),
        settleFastMs: z.number().default(250).description('settle=fast 的等待毫秒数（点击后到重新解析之间）'),
        settleMediumMs: z.number().default(700).description('settle=medium 的等待毫秒数'),
        settleSlowMs: z.number().default(1500).description('settle=slow 的等待毫秒数'),
        stepDelayMs: z.number().default(120).description('批处理中相邻盲动作的间隔（毫秒）'),
        waitProbeFirst: z.boolean().default(true).description('等待时先用 focus 轻探测判断界面是否切换'),
        probeFirstMaxMs: z.number().default(1500).description('轻探测优先阶段的最长时长（毫秒），超过后改为逐轮 dump'),
        inputMode: z.union([z.const('auto'), z.const('input'), z.const('adbkeyboard'), z.const('adbkeyboard-b64')]).default('auto')
            .description('文本注入方式：input 只可靠支持 ASCII；中文需 ADBKeyboard'),
        adbKeyboardInstalled: z.boolean().default(false).description('设备是否已安装 ADBKeyboard（auto 模式下决定非 ASCII 走广播）'),
        appSettle: z.union([z.const('none'), z.const('fast'), z.const('medium'), z.const('slow')]).default('none')
            .description('adb_app 默认等待：none 只启动不取界面；需要拿界面时传 settle'),
        keyDelayMs: z.number().default(80).description('连按按键之间的间隔（毫秒）'),
        inputFocusDelayMs: z.number().default(80).description('点击输入框后到开始输入的等待（毫秒）'),
        skipDumpMs: z.number().default(60000).description('判定不可 dump 后跳过重复尝试的时长（毫秒）'),
        skipDumpPatterns: z.string().default('').description('直接跳过 dump 的包名/Activity 正则，逗号分隔，如 tv.danmaku.bili,com.example'),
        visionFallback: z.boolean().default(true).description('控件树不可用/定位失败时是否允许视觉兜底'),
        visionCommand: z.string().default('').description('外部视觉命令，stdout 输出 {"items":[{"text","x","y"}]}；留空只落盘截图'),
        visionTimeoutMs: z.number().default(20000).description('visionCommand 超时（毫秒）'),
        screenshotDir: z.string().default('').description('截图目录；留空用 <dsh-home>/quick-adb/shots'),
        allowShell: z.boolean().default(true).description('是否允许 adb_shell 执行任意 shell 命令（批量里的 shell 步骤同样受此限制）'),
        maxShots: z.number().default(50).description('兜底截图最多保留张数，超出按时间清理'),
        logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')]).default('info').description('插件日志级别'),
        maxOutputChars: z.number().default(8000).description('adb_shell 返回内容的最大字符数'),
        timingEnabled: z.boolean().default(true).description('是否落盘计时日志（JSONL）'),
        timingFile: z.string().default('').description('计时日志路径；留空用 <dsh-home>/quick-adb/timing.jsonl'),
        baselineStepMs: z.number().default(0).description('优化前单步平均耗时（毫秒），用于报告里算加速比；0 = 不对比'),
        baselineAdbCalls: z.number().default(0).description('优化前单步平均 ADB 往返次数，用于报告里算往返减少量'),
        includeScreenInAction: z.boolean().default(true).description('动作成功后是否在结果中附最新界面摘要（省一次感知调用）'),
    });

/** 合并默认值并做类型收敛。 */
export function normalizeConfig(raw) {
    const input = raw !== null && typeof raw === 'object' ? raw : {};
    const out = { ...DEFAULTS, ...input };
    out.adbPath = typeof out.adbPath === 'string' && out.adbPath.trim() !== ''
        ? out.adbPath.trim()
        : (process.env.DSH_QUICK_ADB_BIN ?? process.env.ANDROID_ADB ?? 'adb');
    out.serial = typeof out.serial === 'string' ? out.serial.trim() : '';
    out.softTtlMs = clamp(out.softTtlMs, 0, 600000);
    out.hardTtlMs = Math.max(out.softTtlMs, clamp(out.hardTtlMs, 0, 3600000));
    out.dumpTimeoutMs = clamp(out.dumpTimeoutMs, 1000, 120000);
    out.slowDumpMs = clamp(out.slowDumpMs, 10, 60000);
    out.trialDumpTimeoutMs = clamp(out.trialDumpTimeoutMs, 500, 60000);
    if (!['auto', 'plain', 'compressed'].includes(out.dumpMode))
        out.dumpMode = 'auto';
    out.actionTimeoutMs = clamp(out.actionTimeoutMs, 1000, 300000);
    out.waitTimeoutMs = clamp(out.waitTimeoutMs, 100, 300000);
    out.settleFastMs = clamp(out.settleFastMs, 0, 20000);
    out.settleMediumMs = clamp(out.settleMediumMs, 0, 20000);
    out.settleSlowMs = clamp(out.settleSlowMs, 0, 20000);
    out.stepDelayMs = clamp(out.stepDelayMs, 0, 5000);
    out.probeFirstMaxMs = clamp(out.probeFirstMaxMs, 0, 60000);
    out.visionTimeoutMs = clamp(out.visionTimeoutMs, 1000, 300000);
    out.maxOutputChars = clamp(out.maxOutputChars, 200, 200000);
    out.baselineStepMs = clamp(out.baselineStepMs, 0, 600000);
    out.baselineAdbCalls = clamp(out.baselineAdbCalls, 0, 100);
    out.verifyProbe = out.verifyProbe !== false;
    out.visionFallback = out.visionFallback !== false;
    out.allowShell = out.allowShell !== false;
    out.maxShots = clamp(out.maxShots, 0, 5000);
    out.keyDelayMs = clamp(out.keyDelayMs, 0, 1000);
    out.inputFocusDelayMs = clamp(out.inputFocusDelayMs, 0, 2000);
    out.skipDumpMs = clamp(out.skipDumpMs, 0, 3600000);
    if (!['none', 'fast', 'medium', 'slow'].includes(out.appSettle))
        out.appSettle = 'none';
    out.timingEnabled = out.timingEnabled !== false;
    out.waitProbeFirst = out.waitProbeFirst !== false;
    out.adbKeyboardInstalled = out.adbKeyboardInstalled === true;
    out.includeScreenInAction = out.includeScreenInAction !== false;
    if (!['auto', 'input', 'adbkeyboard', 'adbkeyboard-b64'].includes(out.inputMode))
        out.inputMode = 'auto';
    if (!['debug', 'info', 'warn', 'error'].includes(out.logLevel))
        out.logLevel = 'info';
    return out;
}

export default { Config, DEFAULTS, normalizeConfig };
