/**
 * 批量指令编译器：把 N 个动作压进尽可能少的 ADB 往返。
 *
 * 核心策略是「先离线解析、再一次性下发」：
 *  1. 选择器先在缓存树上解析成本地坐标（0 次往返）；
 *  2. 连续的可盲执行动作拼成一条 shell 脚本（`;` 连接，中间用设备端 sleep）；
 *  3. 只有当某步的选择器解析不了、或显式要求看界面时，才切段并插入一次 dump；
 *  4. 结尾一次 dump 作为「验证 + 下一步感知」，同时回填缓存。
 *
 * 审计整改（v0.2）：
 *  - `shell` 步骤必须过 `allowShell` 开关（P0-2）；
 *  - 只要执行过会改界面的步骤而最终没拿到新树，就作废缓存（P1-1）；
 *  - 按累计时长切段，避免整段脚本撞上 actionTimeoutMs 被 kill（P2-11）。
 * @module dsh-quick-adb/batch
 */
import { ActionError } from './errors.js';
import { clamp, secondsLiteral, sleep } from './util.js';

/** 从一条命令里推断设备端 sleep 时长（毫秒），用于累计预算。 */
function sleepCost(command) {
    const matched = /sleep\s+([\d.]+)/.exec(command);
    return matched === null ? 0 : Number(matched[1]) * 1000;
}

/** 把简写还原成内部步骤描述。 */
export function normalizeStep(raw) {
    if (typeof raw === 'string')
        return { kind: 'tap', selector: { text: raw }, delayMs: null };
    if (raw === null || typeof raw !== 'object')
        throw new ActionError(`无法识别的批量步骤：${JSON.stringify(raw)}`, { kind: 'bad-args' });

    const source = raw;

    if (source.tap !== undefined) {
        const value = source.tap;
        if (typeof value === 'string')
            return { kind: 'tap', selector: { text: value }, delayMs: source.delayMs ?? null };
        if (Array.isArray(value) && value.length >= 2)
            return { kind: 'tap', point: { x: Number(value[0]), y: Number(value[1]) }, delayMs: source.delayMs ?? null };
        const obj = value ?? {};
        if (Number.isFinite(obj.x) && Number.isFinite(obj.y) && obj.text === undefined && obj.id === undefined)
            return { kind: 'tap', point: { x: Number(obj.x), y: Number(obj.y) }, delayMs: source.delayMs ?? null };
        return { kind: 'tap', selector: obj, long: obj.long === true, longMs: obj.longMs, delayMs: source.delayMs ?? null };
    }
    if (source.swipe !== undefined) {
        const value = source.swipe;
        if (typeof value === 'string')
            return { kind: 'swipe', direction: value, from: null, to: null, durationMs: 300, selector: null, scale: null, delayMs: source.delayMs ?? null };
        const obj = value ?? {};
        return {
            kind: 'swipe',
            direction: obj.direction ?? 'up',
            from: obj.from ?? null,
            to: obj.to ?? null,
            selector: obj.selector ?? null,
            durationMs: obj.durationMs ?? 300,
            scale: obj.scale ?? null,
            delayMs: source.delayMs ?? null,
        };
    }
    if (source.input !== undefined) {
        const value = source.input;
        if (typeof value === 'string')
            return { kind: 'input', text: value, selector: null, submit: false, clear: false, delayMs: source.delayMs ?? null };
        const obj = value ?? {};
        return {
            kind: 'input',
            text: String(obj.text ?? ''),
            selector: obj.selector ?? null,
            submit: obj.submit === true,
            clear: obj.clear === true,
            delayMs: source.delayMs ?? null,
        };
    }
    if (source.key !== undefined) {
        const value = source.key;
        if (typeof value === 'number')
            return { kind: 'key', key: String(value), times: 1, delayMs: source.delayMs ?? null };
        if (typeof value === 'string')
            return { kind: 'key', key: value, times: 1, delayMs: source.delayMs ?? null };
        const obj = value ?? {};
        return { kind: 'key', key: String(obj.key ?? obj.name ?? 'back'), times: Number(obj.times ?? 1), delayMs: source.delayMs ?? null };
    }
    if (source.wait !== undefined) {
        const value = source.wait;
        if (typeof value === 'number')
            return { kind: 'wait-ms', ms: value };
        const obj = value ?? {};
        if (obj.selector !== undefined)
            return { kind: 'wait-for', selector: obj.selector, timeoutMs: Number(obj.timeoutMs ?? 8000), intervalMs: obj.intervalMs ?? null, delayMs: null };
        return { kind: 'wait-ms', ms: Number(obj.ms ?? 300) };
    }
    if (source.waitFor !== undefined) {
        const obj = source.waitFor ?? {};
        return { kind: 'wait-for', selector: obj.selector ?? obj.text, timeoutMs: Number(obj.timeoutMs ?? 8000), intervalMs: obj.intervalMs ?? null, delayMs: null };
    }
    if (source.dump !== undefined)
        return { kind: 'dump' };
    if (source.shell !== undefined)
        return { kind: 'shell', command: String(source.shell) };
    throw new ActionError(`批量步骤缺少可识别字段（tap/swipe/input/key/wait/dump/shell）：${JSON.stringify(raw)}`, { kind: 'bad-args' });
}

/** 生成一条设备命令（坐标已确定）。 */
function buildCommand(step, point, extra) {
    switch (step.kind) {
        case 'tap':
            return step.long === true
                ? `input swipe ${point.x} ${point.y} ${point.x} ${point.y} ${Math.round(step.longMs ?? 700)}`
                : `input tap ${point.x} ${point.y}`;
        case 'swipe': {
            const size = extra.size;
            let start = step.from;
            let end = step.to;
            if (start === null || end === null) {
                const scale = Number(step.scale ?? 0.6);
                if (extra.anchor !== null && extra.anchor !== undefined) {
                    // 指定控件内滑动：以命中点为中心，行程取屏高的 30%
                    const travel = Math.round(size.height * 0.15);
                    const anchor = extra.anchor;
                    const vertical = step.direction !== 'left' && step.direction !== 'right';
                    if (vertical) {
                        const sign = step.direction === 'down' ? -1 : 1;
                        start = { x: anchor.x, y: anchor.y + travel * sign };
                        end = { x: anchor.x, y: anchor.y - travel * sign };
                    }
                    else {
                        const sign = step.direction === 'right' ? -1 : 1;
                        start = { x: anchor.x + travel * sign, y: anchor.y };
                        end = { x: anchor.x - travel * sign, y: anchor.y };
                    }
                    return `input swipe ${start.x} ${start.y} ${end.x} ${end.y} ${Math.round(step.durationMs ?? 300)}`;
                }
                const cx = Math.round(size.width / 2);
                const cy = Math.round(size.height / 2);
                const vt = Math.round(size.height * scale / 2);
                const ht = Math.round(size.width * scale / 2);
                if (step.direction === 'up') {
                    start = { x: cx, y: cy + vt };
                    end = { x: cx, y: cy - vt };
                }
                else if (step.direction === 'down') {
                    start = { x: cx, y: cy - vt };
                    end = { x: cx, y: cy + vt };
                }
                else if (step.direction === 'left') {
                    start = { x: cx + ht, y: cy };
                    end = { x: cx - ht, y: cy };
                }
                else {
                    start = { x: cx - ht, y: cy };
                    end = { x: cx + ht, y: cy };
                }
            }
            return `input swipe ${start.x} ${start.y} ${end.x} ${end.y} ${Math.round(step.durationMs ?? 300)}`;
        }
        case 'key': {
            const code = extra.keycode;
            const times = Math.max(1, Math.min(20, Number(step.times ?? 1)));
            return Array.from({ length: times }, () => `input keyevent ${code}`).join('; ');
        }
        case 'input':
            return extra.textCommand;
        default:
            return 'true';
    }
}

/**
 * 执行批处理。
 * @param {object} engine - AndroidEngine
 * @param {{steps: Array, verify?: boolean, settle?: string|number, stopOnError?: boolean, defaultDelayMs?: number}} args
 */
export async function runBatch(engine, args = {}) {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    if (steps.length === 0)
        throw new ActionError('adb_batch 需要非空 steps 数组', { kind: 'bad-args' });

    const inner = engine.internals();
    const config = engine.config;
    const serial = inner.serial();
    const verify = args.verify !== false;
    const stopOnError = args.stopOnError !== false;
    const stepDelayMs = Number.isFinite(args.defaultDelayMs) ? Number(args.defaultDelayMs) : config.stepDelayMs;
    const started = Date.now();
    // 留 40% 余量：整段脚本若贴到 actionTimeoutMs 会被 kill，设备状态不可知
    const budgetMs = Math.max(2000, config.actionTimeoutMs * 0.6);

    const results = [];
    let pending = [];
    let pendingMs = 0;
    let flushes = 0;
    let tree = inner.peekTree();
    let lastDumpOk = false;
    let mutated = false;
    let failure = null;

    const queue = (command, cost = 50) => {
        pending.push(command);
        pendingMs += sleepCost(command) + cost;
    };

    const flush = async ({ dump = false, op = 'batch' } = {}) => {
        if (pending.length === 0 && !dump)
            return null;
        const commands = pending.slice();
        pending = [];
        pendingMs = 0;
        if (dump) {
            if (commands.length > 0) {
                const settle = inner.settleMs(args.settle ?? 'fast');
                if (settle > 0)
                    commands.push(`sleep ${secondsLiteral(settle)}`);
            }
            commands.push(inner.dumpScript());
        }
        const result = await inner.adb.shell(commands.join('; '), { timeoutMs: config.actionTimeoutMs, op });
        flushes++;
        if (dump) {
            const fresh = inner.absorb(result.stdout, 'batch.dump');
            lastDumpOk = fresh !== null;
            if (fresh !== null)
                tree = fresh;
        }
        return result;
    };

    /** 保证下一段命令不会把整条脚本推过超时预算。 */
    const ensureRoom = async (cost) => {
        if (pending.length > 0 && pendingMs + cost > budgetMs)
            await flush();
    };

    const resolvePoint = async (step) => {
        if (step.point !== undefined && step.point !== null)
            return step.point;
        let loc = tree !== null ? inner.resolve(tree, step.selector) : { ok: false };
        if (!loc.ok && !lastDumpOk) {
            // 缓存未命中或刚做过动作：切段 + 一次 dump，然后在新树上重试
            await flush({ dump: true });
            loc = tree !== null ? inner.resolve(tree, step.selector) : { ok: false };
        }
        if (!loc.ok)
            throw inner.notFound(step.selector, tree ?? { nodes: [], pkg: '', signature: '', clickable: 0 }, '', loc);
        return loc.point;
    };

    for (let index = 0; index < steps.length; index++) {
        let step;
        try {
            step = normalizeStep(steps[index]);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({ i: index + 1, kind: 'invalid', ok: false, error: message });
            failure = { index: index + 1, error: message };
            if (stopOnError)
                break;
            continue;
        }

        try {
            if (step.kind === 'wait-ms') {
                // step.ms 已经是毫秒，直接作为预算增量（不能再用 sleepCost 解析字面量）
                await ensureRoom(step.ms);
                queue(`sleep ${secondsLiteral(step.ms)}`, 0);
                results.push({ i: index + 1, kind: 'wait', ok: true, ms: step.ms });
                continue;
            }
            if (step.kind === 'dump') {
                await flush({ dump: true });
                results.push({ i: index + 1, kind: 'dump', ok: tree !== null });
                continue;
            }
            if (step.kind === 'shell') {
                // 与 adb_shell 共用同一个开关（审计 P0-2）
                inner.assertShellAllowed();
                await ensureRoom(200);
                queue(step.command, 200);
                mutated = true;
                results.push({ i: index + 1, kind: 'shell', ok: true });
                continue;
            }
            if (step.kind === 'wait-for') {
                await flush({ dump: true });
                const timeoutMs = clamp(step.timeoutMs, 200, 120000);
                const intervalMs = clamp(step.intervalMs ?? 250, 50, 5000);
                const deadline = Date.now() + timeoutMs;
                const budget = Math.min(config.dumpTimeoutMs * 0.6, 400);
                let found = false;
                let attempts = 0;
                while (Date.now() < deadline) {
                    if (attempts > 0 && deadline - Date.now() < budget)
                        break;
                    attempts++;
                    const percept = await inner.perceive({ force: attempts > 1, reason: 'batch.wait' });
                    tree = percept.tree;
                    lastDumpOk = true;
                    const loc = inner.resolve(tree, step.selector);
                    if (loc.ok) {
                        found = true;
                        results.push({ i: index + 1, kind: 'wait-for', ok: true, attempts, point: loc.point });
                        break;
                    }
                    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
                }
                if (!found) {
                    const message = `第 ${index + 1} 步等待超时：${inner.describe(step.selector)}`;
                    results.push({ i: index + 1, kind: 'wait-for', ok: false, error: message, attempts });
                    failure = { index: index + 1, error: message };
                    if (stopOnError)
                        break;
                }
                continue;
            }

            // 只有「点击」和「在指定控件内滑动」需要解析坐标；方向式滑动不需要
            const needsPoint = step.kind === 'tap'
                || (step.kind === 'swipe' && step.selector !== null && step.selector !== undefined);
            const point = needsPoint ? await resolvePoint(step) : null;
            const extra = {};
            if (step.kind === 'swipe') {
                extra.size = await inner.screenSize();
                extra.anchor = point;
            }
            if (step.kind === 'key') {
                const code = inner.keycode(step.key) ?? (/^\d+$/.test(step.key) ? Number(step.key) : undefined);
                if (code === undefined)
                    throw new ActionError(`未知按键 ${step.key}`, { kind: 'bad-args' });
                extra.keycode = code;
            }
            if (step.kind === 'input') {
                if (step.selector !== undefined && step.selector !== null) {
                    const anchor = await resolvePoint({ selector: step.selector, point: null });
                    await ensureRoom(80);
                    queue(`input tap ${anchor.x} ${anchor.y}`, 40);
                    queue('sleep 0.15', 0);
                }
                if (step.clear === true) {
                    await ensureRoom(120);
                    queue('input keyevent 123', 20);
                    queue(`input keyevent ${Array.from({ length: 40 }, () => 67).join(' ')}`, 100);
                    queue('sleep 0.1', 0);
                }
                if (step.text !== '') {
                    const injected = inner.textCommand(step.text);
                    extra.textCommand = injected.command;
                    await ensureRoom(80);
                    queue(buildCommand(step, null, extra), 40);
                }
                if (step.submit === true) {
                    await ensureRoom(40);
                    queue('input keyevent 66', 20);
                }
                const delay = Number.isFinite(step.delayMs) ? Number(step.delayMs) : stepDelayMs;
                if (delay > 0)
                    queue(`sleep ${secondsLiteral(delay)}`, 0);
                mutated = true;
                results.push({ i: index + 1, kind: 'input', ok: true, chars: step.text.length, note: step.text.includes('%') ? '文本含 %，input text 可能无法精确表达' : '' });
                continue;
            }

            await ensureRoom(60);
            queue(buildCommand(step, point, extra), 50);
            const delay = Number.isFinite(step.delayMs) ? Number(step.delayMs) : stepDelayMs;
            if (delay > 0)
                queue(`sleep ${secondsLiteral(delay)}`, 0);
            mutated = true;
            results.push({ i: index + 1, kind: step.kind, ok: true, point: point ?? undefined });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({ i: index + 1, kind: step.kind, ok: false, error: message });
            failure = { index: index + 1, error: message };
            if (stopOnError)
                break;
        }
    }

    // 收尾：同一段脚本内顺带把最终界面拿回来（验证 + 供下一步复用）
    await flush({ dump: verify || failure !== null });

    // 关键：执行过改界面的步骤却没拿到新树，就必须作废缓存（审计 P1-1）
    const cacheInvalidated = !lastDumpOk && mutated;
    if (cacheInvalidated)
        inner.invalidate('batch');

    return {
        ok: failure === null,
        steps: results,
        adbCalls: flushes,
        wallMs: Date.now() - started,
        failedStep: failure?.index ?? null,
        error: failure?.error ?? null,
        cacheInvalidated,
        serial,
        screen: tree !== null && lastDumpOk
            ? {
                pkg: tree.pkg,
                signature: tree.signature,
                text: inner.summarize(tree, { maxTargets: 15, maxTexts: 20, maxChars: 1600 }),
            }
            : null,
    };
}

export default { runBatch, normalizeStep };
