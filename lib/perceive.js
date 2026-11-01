/**
 * 感知层：dump 解析、焦点探测、分层缓存判定。
 *
 * 这一层只回答两个问题：
 *   1. 现在能不能用上次解析的结果？（L1 精确 / L2 探测复核 / L3 重解析）
 *   2. 如果要用新的，怎么用尽量少的往返拿到？（一条 shell 内 dump + cat）
 * @module dsh-quick-adb/perceive
 */
import { buildTree } from './dump.js';
import { ActionError } from './errors.js';
import { safeToken, trunc } from './util.js';

/** `--compressed` 不被支持时 uiautomator 的典型报错（各 ROM 措辞不一，这里放宽）。 */
const COMPRESSED_UNSUPPORTED = /unknown option|unknown argument|unrecognized option|invalid option|usage:\s*uiautomator/i;

export class Perception {
    /**
     * @param {{config: object, adb: object, cache: object, timing: object, log?: Function, serialOf: () => string, ensureSerial: () => Promise<string>}} deps
     */
    constructor({ config, adb, cache, timing, log = () => {}, serialOf, ensureSerial }) {
        this.config = config;
        this.adb = adb;
        this.cache = cache;
        this.timing = timing;
        this.log = log;
        this.serialOf = serialOf;
        this.ensureSerial = ensureSerial;
        this.caps = { compressed: true, compressedVerified: false };
    }

    remoteDumpPath(serial) {
        return `/sdcard/dsh_ui_${safeToken(serial, 'dev')}.xml`;
    }

    /** 设备端脚本：dump 落盘 + 立刻 cat，两条命令一次往返。 */
    dumpScriptFor(serial, compressed = this.caps.compressed) {
        const flag = compressed ? '--compressed ' : '';
        const path = this.remoteDumpPath(serial);
        return `uiautomator dump ${flag}${path} >/dev/null 2>&1; cat ${path} 2>/dev/null`;
    }

    /** 轻探测：一次 ~100ms 的往返，判断是否还在同一界面。 */
    async probe() {
        const started = Date.now();
        try {
            const result = await this.adb.shell("dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -4", { timeoutMs: 4000, op: 'probe' });
            const text = String(result.stdout ?? '');
            const focus = /mCurrentFocus=Window\{[^}]*\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(text);
            const app = /mFocusedApp=.*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(text);
            const picked = focus ?? app;
            const ms = Date.now() - started;
            this.timing.record({ op: 'probe', kind: 'internal', wallMs: ms, adbCalls: 1, source: 'probe', serial: this.serialOf() });
            return { ok: true, pkg: picked?.[1] ?? '', activity: picked?.[2] ?? '', raw: trunc(text.replace(/\s+/g, ' '), 200), ms };
        }
        catch (error) {
            this.timing.record({ op: 'probe', kind: 'internal', wallMs: Date.now() - started, adbCalls: 1, source: 'probe', ok: false, serial: this.serialOf() });
            return { ok: false, pkg: '', activity: '', error: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
        }
    }

    /**
     * 一次完整 dump + 解析，成功后写入缓存。
     *
     * 降级策略（对应审计 P2-3）：只有设备明确表示不认识 `--compressed` 时才永久关掉；
     * 单纯超时或空层级只影响本次，下次仍用压缩（压缩能显著减小大界面的传输量）。
     */
    async dumpTree({ reason = 'dump' } = {}) {
        const serial = await this.ensureSerial();
        const attempts = [];
        const candidates = this.caps.compressed ? [true, false] : [false];
        for (const compressed of candidates) {
            const started = Date.now();
            let result;
            try {
                result = await this.adb.shell(this.dumpScriptFor(serial, compressed), { timeoutMs: this.config.dumpTimeoutMs, op: 'dump' });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                attempts.push(`${compressed ? 'compressed' : 'plain'} 调用失败: ${message}`);
                continue;
            }
            const ms = Date.now() - started;
            const stderr = String(result.stderr ?? '');
            const stdoutHead = String(result.stdout ?? '').slice(0, 300);
            if (COMPRESSED_UNSUPPORTED.test(stderr) || COMPRESSED_UNSUPPORTED.test(stdoutHead)) {
                this.caps.compressed = false;
                attempts.push('设备不支持 --compressed，永久降级');
                continue;
            }
            let tree = null;
            try {
                tree = buildTree(String(result.stdout ?? ''));
            }
            catch (error) {
                attempts.push(`${compressed ? 'compressed' : 'plain'} 解析失败: ${error instanceof Error ? error.message : String(error)}${stderr !== '' ? ` / stderr=${trunc(stderr, 120)}` : ''}`);
                continue;
            }
            if (tree.nodes.length === 0) {
                attempts.push('空层级（常见于 WebView/Flutter/游戏/DRM）');
                continue;
            }
            if (compressed)
                this.caps.compressedVerified = true;
            this.cache.set(serial, { tree, reason, dumpMs: ms, source: 'dump' });
            this.timing.record({ op: 'dump', kind: 'internal', wallMs: ms, adbCalls: 1, source: 'dump', serial, extra: { nodes: tree.nodes.length, compressed } });
            return tree;
        }
        this.timing.record({ op: 'dump', kind: 'internal', wallMs: 0, adbCalls: candidates.length, source: 'dump', ok: false, serial });
        throw new ActionError(
            `控件树不可用：${attempts.join(' | ')}。已尝试 ${candidates.length} 次 dump。可继续用视觉兜底（adb_tap 会自动回退），或检查 uiautomator 是否可用。`,
            { kind: 'dump-failed', detail: { attempts } },
        );
    }

    /**
     * 分层感知：L1 缓存 → L2 探测复核 → L3 完整 dump。
     * @returns {Promise<{tree: object, source: string, adbCalls: number, ageMs: number, wallMs: number}>}
     */
    async perceive({ reason = 'read', force = false } = {}) {
        const started = Date.now();
        const serial = await this.ensureSerial();
        if (!force) {
            const entry = this.cache.get(serial);
            if (entry !== null && entry.tree !== undefined) {
                const age = Date.now() - entry.at;
                if (!entry.dirty && age <= this.config.softTtlMs) {
                    this.cache.note('exact', serial);
                    return { tree: entry.tree, source: 'cache', adbCalls: 0, ageMs: age, wallMs: 0 };
                }
                if (!entry.dirty && age <= this.config.hardTtlMs && this.config.verifyProbe) {
                    const probe = await this.probe();
                    // 探测必须真的解析出包名才算复核通过；正则失配时宁可重 dump
                    const pkgSame = probe.ok && probe.pkg !== '' && (entry.tree.pkg === '' || probe.pkg === entry.tree.pkg);
                    const activitySame = entry.activity === null || probe.activity === '' || entry.activity === probe.activity;
                    if (pkgSame && activitySame) {
                        if (entry.activity === null && probe.activity !== '')
                            entry.activity = probe.activity;
                        this.cache.note('verified', serial);
                        this.timing.record({ op: 'perceive', kind: 'internal', wallMs: Date.now() - started, adbCalls: 1, source: 'cache-verified', serial, extra: { ageMs: age } });
                        return { tree: entry.tree, source: 'cache-verified', adbCalls: 1, ageMs: age, wallMs: Date.now() - started, probe };
                    }
                }
            }
        }
        const tree = await this.dumpTree({ reason });
        return { tree, source: 'dump', adbCalls: 1, ageMs: 0, wallMs: Date.now() - started };
    }

    /** 把一次 shell 输出里的 XML 吸收成界面树并写缓存；失败返回 null。 */
    absorb(raw, reason) {
        let tree;
        try {
            tree = buildTree(String(raw ?? ''));
        }
        catch {
            return null;
        }
        if (tree.nodes.length === 0)
            return null;
        const serial = this.serialOf();
        if (serial !== '')
            this.cache.set(serial, { tree, reason, source: 'dump' });
        return tree;
    }

    /** 只读当前缓存树，不触发任何 ADB 调用。 */
    peek() {
        const serial = this.serialOf();
        if (serial === '')
            return null;
        const entry = this.cache.peek(serial);
        if (entry === null || entry.dirty)
            return null;
        return entry.tree ?? null;
    }

    /** 动作发生后作废缓存（下一步必须重新解析）。 */
    markDirty(reason) {
        const serial = this.serialOf();
        if (serial !== '')
            this.cache.invalidate(serial, reason);
    }

    /** 拿到新树后刷新缓存，并把「已见过 Activity」清空（新树不带 Activity 信息）。 */
    cacheSnapshot() {
        return this.cache.snapshot();
    }
}

export default { Perception };
