/**
 * 面向模型的工具集（adb_*）。
 *
 * 设计取向：工具数量克制、每个都对应一个高频动作，参数用「选择器对象」而不是
 * 让模型自己算坐标——模型只描述目标，坐标由插件在本地控件树上算。
 * @module dsh-quick-adb/tools
 */
import { clamp } from './util.js';

let defineTool;
let LOAD_ERROR = null;
try {
    ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
}
catch (error) {
    defineTool = undefined;
    LOAD_ERROR = error;
}

const asText = text => [{ type: 'text', text }];

function jsonOutput(render) {
    return { schema: { type: 'json' }, render };
}

const SELECTOR_DOC = '选择器对象：{text?:"精确文案", textContains?, textRegex?, id?:"btn_ok 或 com.x:id/btn_ok", desc?, cls?, nth?:0, clickable?:true}。传字符串等价于 {text}';

function screenTextOf(value) {
    if (value?.screen?.text !== undefined)
        return value.screen.text;
    return '';
}

/** 点击类结果的统一渲染：动作 + 新界面，模型无需再单独感知一次。 */
function actionRender(label) {
    return (_args, value) => {
        const v = value ?? {};
        const head = [`${label}${v.point !== undefined && v.point !== null ? ` @(${v.point.x},${v.point.y})` : ''}`];
        if (v.settle !== undefined)
            head.push(`settle=${v.settle}`);
        if (v.note !== undefined && v.note !== '')
            head.push(`注意：${v.note}`);
        const lines = [head.join(' ')];
        const screen = screenTextOf(v);
        if (screen !== '')
            lines.push('', screen);
        return asText(lines.join('\n'));
    };
}

/** 界面结果的渲染：摘要 + 可选定位结果（审计 P1-3：原来把 find 丢了）。 */
function screenRender(_args, value) {
    const v = value ?? {};
    const lines = [v.text ?? ''];
    if (v.find !== null && v.find !== undefined) {
        if (v.find.ok) {
            const name = v.find.label || v.find.id || '(无文案控件)';
            lines.push('', `定位命中：${name} @(${v.find.point.x},${v.find.point.y})，共匹配 ${v.find.matches} 个${v.find.lifted ? '（已提升到可点击容器）' : ''}`);
        }
        else {
            const reason = v.find.reason === 'nth-out-of-range'
                ? `（nth 越界，实际只有 ${v.find.matches} 个匹配）`
                : '';
            const candidates = (v.find.candidates ?? []).slice(0, 6).join(' / ');
            lines.push('', `未命中${reason}；候选：${candidates === '' ? '（界面几乎无文案）' : candidates}`);
        }
    }
    return asText(lines.join('\n'));
}

/**
 * 注册全部工具。
 * @param {object} ctx - dsh 插件上下文（已 inject tools）
 * @param {object} engine - AndroidEngine
 * @param {object} config - 归一化后的配置
 * @returns {() => void} disposer
 */
export function registerTools(ctx, engine, config) {
    if (typeof defineTool !== 'function')
        throw new Error('dsh-quick-adb 无法加载 @deepseek-ai/dsh-tools，请确认插件部署在 dsh profile 内（依赖随宿主解析）');
    const disposers = [];
    const register = (tool) => {
        disposers.push(ctx.tools.register(tool));
    };

    register(defineTool({
        name: 'adb_screen',
        description: '读取当前 Android 界面的控件结构（文本、可点击目标、坐标），优先走缓存，通常 0 次 ADB。这是替代整屏截图识图的主要感知手段：先看这里，不要默认截图。给 selector 可顺便拿到命中坐标。',
        parameters: {
            selector: { type: 'object', additionalProperties: true, description: `可选：顺便定位一个控件，命中结果会直接写进返回文本。${SELECTOR_DOC}` },
            invalidate: { type: 'boolean', description: '强制丢弃缓存并重新解析（界面明显已变但缓存未过期时用）' },
            maxTargets: { type: 'number', description: '最多返回多少个可点击目标（默认 40）' },
            maxTexts: { type: 'number', description: '最多返回多少条可见文本（默认 60，0 表示不返回文本）' },
            maxChars: { type: 'number', description: '文本输出上限（默认 6000 字符）' },
        },
        output: jsonOutput(screenRender),
        isConcurrencySafe: () => true,
        execute: async (args) => engine.screen(args ?? {}),
    }));

    register(defineTool({
        name: 'adb_tap',
        description: '点击控件或坐标。给 selector 时由插件在控件树中定位并提升到可点击容器，命中率高于自己算坐标；失败会自动重解析一次，仍失败则视觉兜底。默认在同一次 ADB 往返里完成「点击 + 短暂等待 + 取回新界面」。',
        parameters: {
            selector: { type: 'object', additionalProperties: true, description: `与 x/y 二选一。${SELECTOR_DOC}` },
            x: { type: 'number', description: '坐标点击的 x（与 y 同时给出时忽略 selector）' },
            y: { type: 'number', description: '坐标点击的 y' },
            long: { type: 'boolean', description: '长按（默认 false）' },
            longMs: { type: 'number', description: '长按毫秒数（默认 700）' },
            settle: { type: 'string', description: '点击后等待：none/fast/medium/slow 或毫秒数（默认 fast=250ms）。none 省一次 dump，但下一步必须重新感知' },
            allowVision: { type: 'boolean', description: '定位失败时是否允许视觉兜底（默认 true）' },
            perceive: { type: 'boolean', description: '设为 false 等价于 settle=none：只做动作，不取界面（纯动作流水线用这个）' },
        },
        output: jsonOutput(actionRender('已点击')),
        isConcurrencySafe: () => false,
        execute: async (args) => engine.tap(args ?? {}),
    }));

    register(defineTool({
        name: 'adb_swipe',
        description: '滑动屏幕或某个可滚动控件。可用 direction（up/down/left/right）自动按屏幕尺寸换算，也可显式给 from/to，或给 selector 在指定控件内滑动（定位失败同样会视觉兜底）。',
        parameters: {
            direction: { type: 'string', description: '滑动方向：up（内容向上/看下面）、down、left、right（默认 up）' },
            scale: { type: 'number', description: '滑动行程占屏幕比例（默认 0.6，太小可能触发不了滚动）' },
            durationMs: { type: 'number', description: '滑动时长毫秒（默认 300）' },
            selector: { type: 'object', additionalProperties: true, description: `可选：在命中的控件区域内滑动。${SELECTOR_DOC}` },
            from: { type: 'object', additionalProperties: true, description: '起点 {x,y}（与 to 配对使用，优先于 direction）' },
            to: { type: 'object', additionalProperties: true, description: '终点 {x,y}' },
            settle: { type: 'string', description: '滑动后等待：none/fast/medium/slow（默认 fast）' },
            allowVision: { type: 'boolean', description: '指定控件定位失败时是否允许视觉兜底（默认 true）' },
            perceive: { type: 'boolean', description: '设为 false 等价于 settle=none：只滑动，不取界面' },
        },
        output: jsonOutput(actionRender('已滑动')),
        isConcurrencySafe: () => false,
        execute: async (args) => engine.swipe(args ?? {}),
    }));

    register(defineTool({
        name: 'adb_input',
        description: '向输入框输入文本（可先点击定位、清空、回车提交）。文本注入、清空、提交与之后重新取界面都合并在一次 ADB 往返内。非 ASCII 文本或含 % 的文本需要设备安装 ADBKeyboard（配置 inputMode=adbkeyboard-b64）。',
        parameters: {
            text: { type: 'string', description: '要输入的文本' },
            selector: { type: 'object', additionalProperties: true, description: `可选：先点击该输入框。${SELECTOR_DOC}` },
            clear: { type: 'boolean', description: '先清空（移动光标到末尾后连按退格）' },
            submit: { type: 'boolean', description: '输入后按回车（keyevent 66）' },
            settle: { type: 'string', description: '输入后等待：none/fast/medium/slow（默认 fast）' },
            allowVision: { type: 'boolean', description: '输入框定位失败时是否允许视觉兜底（默认 true）' },
            perceive: { type: 'boolean', description: '设为 false 等价于 settle=none：只输入，不取界面' },
        },
        output: jsonOutput(actionRender('已输入')),
        isConcurrencySafe: () => false,
        execute: async (args) => engine.input(args ?? {}),
    }));

    register(defineTool({
        name: 'adb_key',
        description: '发送系统按键：back（返回）、home、enter、delete、menu、recents、power、tab，或直接给 keycode 数字。连按多次也只花一次 ADB 往返。',
        parameters: {
            key: { type: 'string', required: true, description: 'back/home/enter/delete/menu/recents/power/tab/move-end/up/down/left/right，或数字 keycode' },
            times: { type: 'number', description: '连按次数（默认 1，上限 20）' },
            settle: { type: 'string', description: '按键后等待：none/fast/medium/slow（默认 fast）' },
            perceive: { type: 'boolean', description: '设为 false 等价于 settle=none：只按键，不取界面' },
        },
        output: jsonOutput(actionRender('已按键')),
        isConcurrencySafe: () => false,
        execute: async (args) => engine.key(args ?? {}),
    }));

    register(defineTool({
        name: 'adb_wait',
        description: '等待元素出现/消失，或等待界面稳定（until=idle）。内部先用约 100ms 的焦点探测判断界面是否真的切换，再用控件树确认，比每轮整树解析更省时。返回命中坐标可直接给 adb_tap 的 x/y。',
        parameters: {
            selector: { type: 'object', additionalProperties: true, description: `until=appear/disappear 时必填。${SELECTOR_DOC}` },
            until: { type: 'string', description: 'appear（默认）/ disappear / idle（界面签名稳定）' },
            timeoutMs: { type: 'number', description: '超时毫秒（默认取配置 waitTimeoutMs=10000）' },
            intervalMs: { type: 'number', description: '轮询间隔毫秒（默认 250）' },
            stableMs: { type: 'number', description: 'until=idle 时签名需保持稳定的时长（默认 300）' },
        },
        output: jsonOutput((_args, value) => {
            const v = value ?? {};
            const head = v.ok === false
                ? `等待超时：${v.until} 用时 ${v.waitedMs}ms（${v.attempts} 次探测）。未抛错，可继续下一步或改用坐标。`
                : `等待完成：${v.until} 用时 ${v.waitedMs}ms（${v.attempts} 次探测）${v.point !== null && v.point !== undefined ? ` 命中 @(${v.point.x},${v.point.y})` : ''}`;
            const screen = screenTextOf(v);
            return asText(screen === '' ? head : `${head}\n\n${screen}`);
        }),
        isConcurrencySafe: () => false,
        execute: async (args) => engine.wait(args ?? {}),
    }));

    register(defineTool({
        name: 'adb_batch',
        description: '批量执行多步动作，合并 ADB 往返。步骤里的选择器先在本地控件树解析成坐标，连续动作拼进同一条 shell 脚本，通常 3~5 步只需 1~2 次往返。适合「点搜索→输入→回车→等结果」这类固定流程。步骤格式：{"tap":"文案"} / {"tap":{text,id}} / {"input":{text,submit}} / {"swipe":"up"} / {"key":"back"} / {"wait":800} / {"waitFor":{text}} / {"dump":true} / {"shell":"..."}（shell 受 allowShell 限制）',
        parameters: {
            steps: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true, description: '步骤数组，按顺序执行' },
            verify: { type: 'boolean', description: '结束后是否取回最终界面（默认 true，与最后一步合并为同一次往返）。设 false 会作废缓存，下一步必须重新感知' },
            settle: { type: 'string', description: '收尾 dump 前的等待：none/fast/medium/slow（默认 fast）' },
            stopOnError: { type: 'boolean', description: '某步失败是否中止（默认 true）' },
            defaultDelayMs: { type: 'number', description: '每步默认间隔毫秒（默认取配置 stepDelayMs=120）' },
        },
        output: jsonOutput((_args, value) => {
            const v = value ?? {};
            const marks = (v.steps ?? []).map(step => `${step.i}${step.ok ? '✓' : '✗'}`).join(' ');
            const lines = [`批处理${v.ok ? '完成' : '失败'}：${v.steps?.length ?? 0} 步，${v.adbCalls} 次 ADB 往返，${v.wallMs}ms`];
            if (marks !== '')
                lines.push(`步骤：${marks}`);
            if (v.error !== null && v.error !== undefined)
                lines.push(`失败于第 ${v.failedStep} 步：${v.error}`);
            if (v.cacheInvalidated === true)
                lines.push('缓存已作废：下一步感知会重新解析界面');
            if (v.degraded === true)
                lines.push('降级执行：有命令超时或界面不可解析，脚本未被中断（纯坐标步骤仍可继续）');
            const screen = screenTextOf(v);
            if (screen !== '')
                lines.push('', screen);
            return asText(lines.join('\n'));
        }),
        isConcurrencySafe: () => false,
        execute: async (args) => engine.batch(args ?? {}),
    }));

    register(defineTool({
        name: 'adb_app',
        description: '应用级操作：启动（am start -W 会等到 Activity 可见）、停止、重启、清数据、查当前前台应用、查设备与缓存状态。包名会做白名单校验。启动/重启后顺带返回新界面，省一次感知。',
        parameters: {
            action: { type: 'string', required: true, description: 'start / stop / restart / clear / current / status' },
            package: { type: 'string', description: '包名，如 com.android.settings（action=current/status 时可省略）' },
            activity: { type: 'string', description: '可选：Activity 全名，给定时用 am start -W -n 精确定位' },
            settle: { type: 'string', description: '启动后等待：none/fast/medium/slow（默认 medium=700ms）' },
        },
        output: jsonOutput(actionRender('应用操作')),
        isConcurrencySafe: () => false,
        execute: async (args) => engine.app(args ?? {}),
    }));

    register(defineTool({
        name: 'adb_shell',
        description: '在设备上执行任意 shell 命令（逃生口：dumpsys、pm、settings、文件操作等）。会把缓存标记为失效，下次感知会重新解析。受配置 allowShell 控制。',
        parameters: {
            command: { type: 'string', required: true, description: '设备端 shell 命令，可用 ; 串联多条' },
            timeoutMs: { type: 'number', description: '超时毫秒（默认 actionTimeoutMs）' },
        },
        output: jsonOutput((_args, value) => {
            const v = value ?? {};
            const body = v.stdout !== '' ? v.stdout : '(无输出)';
            return asText(`${v.ok ? '执行成功' : `执行失败(code=${v.code})`}\n${body}${v.stderr !== '' ? `\n[stderr] ${v.stderr}` : ''}`);
        }),
        isConcurrencySafe: () => false,
        execute: async (args) => engine.shell(args ?? {}),
    }));

    register(defineTool({
        name: 'adb_timing',
        description: '查看单步耗时与缓存命中报告（含 ADB 往返次数、p50/p95、来源分布）。用于评估本次会话的优化效果；配置 baselineStepMs 后可给出加速比。',
        parameters: {
            last: { type: 'number', description: '只统计最近 N 条样本（默认全部内存样本，最多 2000）' },
            reset: { type: 'boolean', description: '清空统计（默认 false）' },
            includeInternal: { type: 'boolean', description: '是否包含内部 dump/probe 明细（默认 false）' },
        },
        output: jsonOutput((_args, value) => asText(value?.text ?? '')),
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const input = args ?? {};
            if (input.reset === true)
                await engine.timing.clear();
            const report = engine.timing.report({
                limit: clamp(input.last ?? 0, 0, 2000),
                includeInternal: input.includeInternal === true,
                baseline: { stepMs: config.baselineStepMs, adbCalls: config.baselineAdbCalls },
            });
            const text = engine.timing.formatReport(report);
            const cache = engine.cache.snapshot();
            return {
                sampled: report.samples,
                avgStepMs: report.avgStepMs,
                avgAdbCalls: report.avgAdbCalls,
                rows: report.rows,
                baseline: report.baseline ?? null,
                speedup: report.speedup ?? null,
                savedMsPerStep: report.savedMsPerStep ?? null,
                cache,
                text: `${text}\n\n缓存命中率（含探测复核）${(cache.hitRate * 100).toFixed(1)}%，零成本命中 ${(cache.hitRateExact * 100).toFixed(1)}%（精确 ${cache.stats.exact} / 复核 ${cache.stats.verified} / 解析 ${cache.stats.dumps} / 视觉 ${cache.stats.vision}）\n累计 ADB 调用 ${engine.adb.calls} 次`,
            };
        },
    }));

    return () => {
        for (const dispose of disposers) {
            try {
                dispose();
            }
            catch (error) {
                void error;
            }
        }
    };
}

/** 备用：未加载到 dsh-tools 时的诊断信息。 */
export function toolsLoadError() {
    return LOAD_ERROR;
}

export default { registerTools, toolsLoadError };
