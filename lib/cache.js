/**
 * 界面缓存：每台设备只保留「最近一次解析结果」。
 *
 * 一个设备同时只显示一个界面，所以单槽即可；多槽只会让过期数据混入决策。
 * 关键不是容量，而是「何时可信」：
 *   - dirty=false 且年龄 ≤ softTtl  → 完全可信，0 次 ADB
 *   - dirty=false 且年龄 ≤ hardTtl  → 用一次 focus 轻探测复核（~100ms）
 *   - dirty=true（刚做过动作）      → 直接作废，重新 dump
 * @module dsh-quick-adb/cache
 */

export class ScreenCache {
    constructor({ softTtlMs = 800, hardTtlMs = 15000 } = {}) {
        this.softTtlMs = softTtlMs;
        this.hardTtlMs = hardTtlMs;
        this.slots = new Map();
        this.stats = {
            lookups: 0,
            exact: 0,
            verified: 0,
            dumps: 0,
            invalidations: 0,
            vision: 0,
        };
    }

    /** 读取并计数一次查询（不改变可信状态）。 */
    get(serial) {
        this.stats.lookups++;
        return this.slots.get(serial) ?? null;
    }

    /** 只读窥视，不计数，用于内部判断。 */
    peek(serial) {
        return this.slots.get(serial) ?? null;
    }

    /** 写入新的解析结果。 */
    set(serial, entry) {
        this.slots.set(serial, {
            tree: entry.tree,
            at: Date.now(),
            dirty: false,
            reason: entry.reason ?? 'dump',
            activity: entry.activity ?? null,
            dumpMs: entry.dumpMs ?? 0,
            source: entry.source ?? 'dump',
            hits: 0,
        });
        this.stats.dumps++;
    }

    /** 动作发生后作废（下一次感知必须重新 dump）。 */
    invalidate(serial, reason, { keepTree = true } = {}) {
        const entry = this.slots.get(serial);
        if (entry === undefined) {
            this.stats.invalidations++;
            return;
        }
        entry.dirty = true;
        entry.reason = reason;
        entry.invalidatedAt = Date.now();
        if (!keepTree)
            this.slots.delete(serial);
        this.stats.invalidations++;
    }

    /**
     * 记录一次命中。
     * @param {'exact'|'verified'|'vision'} kind
     * @param {string} serial - 命中归属的设备（多设备时必须精确到槽位，审计 P2-6）
     */
    note(kind, serial) {
        if (kind === 'exact')
            this.stats.exact++;
        else if (kind === 'verified')
            this.stats.verified++;
        else if (kind === 'vision')
            this.stats.vision++;
        if ((kind === 'exact' || kind === 'verified') && serial !== undefined) {
            const entry = this.slots.get(serial);
            if (entry !== undefined)
                entry.hits++;
        }
    }

    /** 任意命中率（含付费的探测复核），仅用于粗看趋势。 */
    hitRate() {
        const total = this.stats.exact + this.stats.verified + this.stats.dumps;
        if (total === 0)
            return 0;
        return (this.stats.exact + this.stats.verified) / total;
    }

    /** 零成本命中率：只算真正没花 ADB 往返的那部分（审计 P2-7）。 */
    hitRateExact() {
        const total = this.stats.exact + this.stats.verified + this.stats.dumps;
        if (total === 0)
            return 0;
        return this.stats.exact / total;
    }

    snapshot() {
        const serials = [];
        for (const [serial, entry] of this.slots)
            serials.push({
                serial,
                ageMs: Date.now() - entry.at,
                dirty: entry.dirty,
                reason: entry.reason,
                signature: entry.tree?.signature ?? '',
                pkg: entry.tree?.pkg ?? '',
                nodes: entry.tree?.nodes.length ?? 0,
                hits: entry.hits,
            });
        return {
            slots: serials,
            stats: { ...this.stats },
            hitRate: Number(this.hitRate().toFixed(3)),
            hitRateExact: Number(this.hitRateExact().toFixed(3)),
        };
    }

    clear() {
        this.slots.clear();
    }
}

export default { ScreenCache };
