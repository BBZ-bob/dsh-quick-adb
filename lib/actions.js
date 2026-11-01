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
 * 执行一组设备命令。等待（settle）与确认 dump（confirm）是两件独立的事：
 *   - settle 只决定动作后睡多久（给 UI 渲染时间，成本是一次设备端 sleep）
 *   - confirm 决定要不要顺带重新解析界面（成本是一整次 dump，慢设备上 ~2.7s）
 * P3c 实测：两者捆绑导致「显式传 settle=fast」的调用方被迫多付一遍 dump。
 *
 * 返回的 `settle`：dumped（已重新解析）/ failed（重建失败，缓存作废）/ none（未确认）
 * @returns {Promise<{settle: string, tree: object|null}>}
 */
export async function runAction({ perception, adb, cache, config, serial, op, commands, settle, confirm = true, reason }) {
    const wait = settleMs(config, settle);
    const wantsDump = wait > 0 && confirm !== false;
    const script = [...commands];
    if (wait > 0)
        script.push(`sleep ${secondsLiteral(wait)}`);
    if (wantsDump)
        script.push(perception.dumpScriptFor(serial));
    const result = await adb.shell(script.join('; '), { timeoutMs: config.actionTimeoutMs, op });
    if (!wantsDump) {
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
