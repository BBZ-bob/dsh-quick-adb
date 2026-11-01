/**
 * 动作执行器：所有「会改变界面」的操作共用同一条收尾逻辑。
 *
 * 这是审计 P3-2 的整改结果——原来 tap/swipe/input/key 各写一遍
 * 「拼命令 + settle + dump + absorb + invalidate」，四份重复导致
 * batch 那条路径漏了失效（P1-1）。现在只有一个出口，语义不可能再分叉。
 * @module dsh-quick-adb/actions
 */
import { clamp, secondsLiteral } from './util.js';

/** settle 语义：none / fast / medium / slow / 毫秒数。 */
export function settleMs(config, value) {
    if (value === undefined || value === null)
        return config.settleFastMs;
    if (typeof value === 'number')
        return clamp(value, 0, 20000);
    switch (value) {
        case 'none': return 0;
        case 'fast': return config.settleFastMs;
        case 'medium': return config.settleMediumMs;
        case 'slow': return config.settleSlowMs;
        default: return config.settleFastMs;
    }
}

/** 点击（长按用 swipe 原地停留实现，兼容性最好）。 */
export function tapCommand(point, { long = false, longMs = 700 } = {}) {
    return long
        ? `input swipe ${point.x} ${point.y} ${point.x} ${point.y} ${Math.round(longMs)}`
        : `input tap ${point.x} ${point.y}`;
}

/**
 * 连按：一条命令内完成，不增加往返。
 * 间隔默认 80ms（原来 200ms，在 P2 实测里让「返回两次」从 328ms 变成 468ms）。
 */
export function keyCommands(code, times = 1, delayMs = 80) {
    const count = clamp(times, 1, 20);
    const commands = [];
    for (let i = 0; i < count; i++) {
        commands.push(`input keyevent ${code}`);
        if (i < count - 1 && delayMs > 0)
            commands.push(`sleep ${secondsLiteral(delayMs)}`);
    }
    return commands;
}

/**
 * 执行一组设备命令，并按 settle 决定是否顺带取回新界面。
 *
 * 返回的 `settle` 有三种取值：
 *   - dumped：动作后已重新解析，缓存是新的
 *   - failed：动作生效但重建失败，缓存已作废（下一步会重解析）
 *   - none：调用方要求不等待，缓存已作废
 * @returns {Promise<{settle: string, tree: object|null}>}
 */
export async function runAction({ perception, adb, cache, config, serial, op, commands, settle, reason }) {
    const wait = settleMs(config, settle);
    const script = [...commands];
    if (wait > 0) {
        script.push(`sleep ${secondsLiteral(wait)}`);
        script.push(perception.dumpScriptFor(serial, perception.caps.compressed));
    }
    const result = await adb.shell(script.join('; '), { timeoutMs: config.actionTimeoutMs, op });
    if (wait <= 0) {
        cache.invalidate(serial, reason);
        return { settle: 'none', tree: null };
    }
    const tree = perception.absorb(result.stdout, reason);
    if (tree !== null)
        return { settle: 'dumped', tree };
    cache.invalidate(serial, `${reason}.settle-failed`);
    return { settle: 'failed', tree: null };
}

export default { settleMs, tapCommand, keyCommands, runAction };
