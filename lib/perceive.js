/**
 * 感知层：dump 解析、焦点探测、分层缓存判定。
 *
 * 这一层只回答两个问题：
 *   1. 现在能不能用上次解析的结果？（L1 精确 / L2 探测复核 / L3 重解析）
 *   2. 如果要用新的，怎么用尽量少的往返拿到？（一条 shell 内 dump + cat）
 * @module dsh-quick-adb/perceive
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildTree } from './dump.js';
import { ActionError } from './errors.js';
import { safeToken, trunc } from './util.js';

/** `--compressed` 不被支持时 uiautomator 的典型报错（各 ROM 措辞不一，这里放宽）。 */
const COMPRESSED_UNSUPPORTED = /unknown option|unknown argument|unrecognized option|invalid option|usage:\s*uiautomator/i;

/**
 * 与压缩模式无关的失败：界面在动、自绘、或被安全策略挡住。
 * 这类错误换 plain 重试也是同样结果，只会把两次 dump 的时间都烧掉
 * （第三方 P2 实测：B 站播放页 dump 直接报错，等待翻倍）。
 */
const MODE_INDEPENDENT_FAILURE = /could not get idle state|could not get root node|no root node|ERROR: *could|not idle|timeout|超时/i;

/** 把失败记录渲染成可读目标。 */
function describeTarget(record) {
    if (record.pkg !== '' || record.activity !== '')
        return `${record.pkg || '?'}/${record.activity || '?'}`;
    return '当前界面';
}

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
        this.caps = { compressed: false, compressedVerified: false };
        /** 已确定的 dump 模式：null=未定（auto 先用 plain）、'plain'、'compressed' */
        this.usedMode = null;
        this.compressedTried = false;
        this.trialPending = false;
        this.modeSamples = { plain: [], compressed: [] };
        /** 最近一次成功 dump 的耗时（毫秒）：用来判断这台设备是否「dump 很贵」 */
        this.dumpCostMs = 0;
        /** 每台设备的 dump 画像（按 serial 落盘，重启后不必重新估算） */
        this.deviceStore = {};
        this.deviceProfileLoaded = false;
        this.applyiedSerial = null;
        this.saveTimer = null;
        /** 最近一次 dump 失败记录：{ serial, pkg, activity, at } */
        this.dumpFailure = null;
        this.patternCache = null;
    }

    remoteDumpPath(serial) {
        return `/sdcard/dsh_ui_${safeToken(serial, 'dev')}.xml`;
    }

    /** 设备端脚本：dump 落盘 + 立刻 cat，两条命令一次往返。 */
    /**
     * 这台设备的 dump 是否「贵」。贵的话动作默认不做事后确认（单 dump 模式）：
     * 一次确认 dump 的钱（本机实测 2.7s）远大于它带来的缓存收益。
     */
    slowDumpDevice() {
        return this.dumpCostMs > this.config.slowDeviceDumpMs;
    }

    /** 读设备画像：优先用磁盘上记录的 dump 成本/模式，避免重启后第一枪又猜错。 */
    async applyDeviceProfile(serial) {
        if (this.applyiedSerial === serial)
            return;
        this.applyiedSerial = serial;
        if (!this.deviceProfileLoaded) {
            this.deviceProfileLoaded = true;
            const file = this.config.deviceCacheFile;
            if (file !== '') {
                try {
                    const raw = await readFile(file, 'utf8');
                    const parsed = JSON.parse(raw);
                    if (parsed !== null && typeof parsed === 'object')
                        this.deviceStore = parsed;
                }
                catch { /* 首次运行没有缓存文件 */ }
            }
        }
        const record = this.deviceStore[serial];
        if (record === undefined || record === null)
            return;
        if (Number.isFinite(record.dumpCostMs) && record.dumpCostMs > 0)
            this.dumpCostMs = record.dumpCostMs;
        if (record.mode === 'plain' || record.mode === 'compressed') {
            this.usedMode = record.mode;
            this.compressedTried = true;
            this.caps.compressed = record.mode === 'compressed';
        }
        this.log('debug', `设备画像：dump≈${Math.round(this.dumpCostMs)}ms，模式=${this.usedMode ?? 'auto'}`);
    }

    /** 记录本机 dump 成本与模式，供下次启动直接使用。 */
    rememberDevice(serial) {
        if (this.config.deviceCacheFile === '' || serial === '')
            return;
        const mode = this.usedMode ?? (this.currentCompressed() ? 'compressed' : 'plain');
        const previous = this.deviceStore[serial];
        if (previous !== undefined
            && Math.abs((previous.dumpCostMs ?? 0) - this.dumpCostMs) < 100
            && previous.mode === mode)
            return;
        this.deviceStore[serial] = { dumpCostMs: Math.round(this.dumpCostMs), mode, at: Date.now() };
        this.scheduleSave();
    }

    scheduleSave() {
        if (this.saveTimer !== null)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            const file = this.config.deviceCacheFile;
            if (file === '')
                return;
            void (async () => {
                try {
                    await mkdir(dirname(file), { recursive: true });
                    await writeFile(file, JSON.stringify(this.deviceStore, null, 2), 'utf8');
                }
                catch (error) {
                    this.log('warn', `写入设备画像失败：${error instanceof Error ? error.message : String(error)}`);
                }
            })();
        }, 300);
        if (typeof this.saveTimer.unref === 'function')
            this.saveTimer.unref();
    }

    /** 给 adb_timing 用的设备画像摘要。 */
    deviceProfile() {
        return {
            serial: this.serialOf() || 'auto',
            dumpCostMs: Math.round(this.dumpCostMs),
            mode: this.usedMode ?? (this.currentCompressed() ? 'compressed' : 'plain'),
            slow: this.slowDumpDevice(),
        };
    }

    /** 当前应当使用的压缩开关。auto 未定时先用 plain（安全），慢到阈值才试 compressed。 */
    currentCompressed() {
        if (this.usedMode !== null)
            return this.usedMode === 'compressed';
        if (this.config.dumpMode === 'compressed')
            return true;
        if (this.config.dumpMode === 'plain')
            return false;
        return false;
    }

    dumpScriptFor(serial, compressed = this.currentCompressed()) {
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
        await this.applyDeviceProfile(serial);
        if (await this.shouldSkipDump(serial)) {
            const record = this.dumpFailure;
            const seconds = Math.round((Date.now() - record.at) / 1000);
            throw new ActionError(
                `跳过 dump：${describeTarget(record)} 在 ${seconds}s 前被判定为不可解析（skipDumpMs=${this.config.skipDumpMs}），直接走视觉兜底。`,
                { kind: 'dump-skipped', detail: { pkg: record.pkg, activity: record.activity } },
            );
        }
        const attempts = [];
        const candidates = this.modesToTry();
        const trial = this.trialPending;
        for (const compressed of candidates) {
            const label = compressed ? 'compressed' : 'plain';
            const started = Date.now();
            let result;
            try {
                const timeoutMs = trial ? Math.min(this.config.dumpTimeoutMs, this.config.trialDumpTimeoutMs) : this.config.dumpTimeoutMs;
                result = await this.adb.shell(this.dumpScriptFor(serial, compressed), { timeoutMs, op: 'dump' });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                attempts.push(`${label} 调用失败: ${message}`);
                if (MODE_INDEPENDENT_FAILURE.test(message)) {
                    // 卡死/超时与模式无关，重试只是再等一遍
                    await this.rememberDumpFailure(serial);
                    throw this.dumpFailedError(attempts, candidates.length);
                }
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
            if (MODE_INDEPENDENT_FAILURE.test(stderr) || MODE_INDEPENDENT_FAILURE.test(stdoutHead)) {
                attempts.push(`${label} 设备报错: ${trunc(stderr || stdoutHead, 100)}`);
                await this.rememberDumpFailure(serial);
                throw this.dumpFailedError(attempts, candidates.length);
            }
            let tree = null;
            try {
                tree = buildTree(String(result.stdout ?? ''));
            }
            catch (error) {
                attempts.push(`${label} 解析失败: ${error instanceof Error ? error.message : String(error)}${stderr !== '' ? ` / stderr=${trunc(stderr, 120)}` : ''}`);
                continue;
            }
            if (tree.nodes.length === 0) {
                attempts.push('空层级（常见于 WebView/Flutter/游戏/DRM）');
                continue;
            }
            this.dumpCostMs = ms;
            this.learnDumpTiming(compressed, ms);
            this.caps.compressed = compressed;
            this.rememberDevice(serial);
            this.dumpFailure = null;
            this.cache.set(serial, { tree, reason, dumpMs: ms, source: 'dump' });
            this.timing.record({ op: 'dump', kind: 'internal', wallMs: ms, adbCalls: 1, source: 'dump', serial, extra: { nodes: tree.nodes.length, compressed } });
            return tree;
        }
        await this.rememberDumpFailure(serial);
        throw this.dumpFailedError(attempts, candidates.length);
    }

    /**
     * auto 模式的模式选择：
     *  - 未定 → 先 plain（安全，不赌设备支持）
     *  - plain 连续两次超过 slowDumpMs → 试一次 compressed（超时上限 trialDumpTimeoutMs）
     *  - 试过之后定死，不再反复
     */
    modesToTry() {
        if (this.config.dumpMode === 'compressed')
            return [true, false];
        if (this.config.dumpMode === 'plain')
            return [false, false];
        // 单一模式也给一次重试：空层级/解析失败常是动画造成的瞬态，值得再试一次
        if (this.usedMode === 'compressed')
            return [true, false];
        if (this.usedMode === 'plain')
            return [false, false];
        if (this.trialPending)
            return [true, false];
        return [false, false];
    }

    learnDumpTiming(compressed, ms) {
        const key = compressed ? 'compressed' : 'plain';
        this.modeSamples[key].push(ms);
        if (this.modeSamples[key].length > 8)
            this.modeSamples[key].shift();
        if (this.config.dumpMode !== 'auto')
            return;
        const avg = list => (list.length === 0 ? 0 : list.reduce((a, b) => a + b, 0) / list.length);
        if (key === 'plain' && this.usedMode === null && !this.trialPending && !this.compressedTried) {
            const samples = this.modeSamples.plain;
            if (samples.length >= 2 && avg(samples) > this.config.slowDumpMs) {
                this.trialPending = true;
                this.log('info', `plain dump 平均 ${Math.round(avg(samples))}ms，超过 slowDumpMs=${this.config.slowDumpMs}，下次尝试 --compressed`);
            }
            return;
        }
        if (key === 'compressed' && this.trialPending) {
            this.compressedTried = true;
            this.trialPending = false;
            const plainAvg = avg(this.modeSamples.plain);
            const compressedAvg = avg(this.modeSamples.compressed);
            if (compressedAvg > 0 && compressedAvg < plainAvg * 0.8) {
                this.usedMode = 'compressed';
                this.log('info', `--compressed 更快（${Math.round(compressedAvg)}ms vs ${Math.round(plainAvg)}ms），后续使用 compressed`);
            }
            else {
                this.usedMode = 'plain';
                this.log('info', `--compressed 并不更快（${Math.round(compressedAvg)}ms vs ${Math.round(plainAvg)}ms），后续固定 plain`);
            }
        }
    }

    dumpFailedError(attempts, tried) {
        this.timing.record({ op: 'dump', kind: 'internal', wallMs: 0, adbCalls: tried, source: 'dump', ok: false, serial: this.serialOf() });
        return new ActionError(
            `控件树不可用：${attempts.join(' | ')}。已尝试 ${tried} 次 dump。接下来会走视觉兜底（adb_tap 自动回退）；${this.config.skipDumpMs}ms 内同一界面不再重复 dump。`,
            { kind: 'dump-failed', detail: { attempts } },
        );
    }

    /**
     * 记住「这个界面 dump 不了」。下次先在 TTL 内用 ~110ms 的焦点探测确认还在同一界面，
     * 是则直接跳过 dump，把 2.4s 的钱省下来。
     */
    async rememberDumpFailure(serial) {
        let pkg = '';
        let activity = '';
        const probe = await this.probe().catch(() => ({ ok: false }));
        if (probe.ok) {
            pkg = probe.pkg;
            activity = probe.activity;
        }
        if (pkg === '' && activity === '') {
            const cached = this.cache.peek(serial);
            pkg = cached?.tree?.pkg ?? '';
        }
        this.dumpFailure = { serial, pkg, activity, at: Date.now() };
        this.log('warn', `dump 失败，已记录不可解析界面 ${describeTarget(this.dumpFailure)}（${this.config.skipDumpMs}ms 内跳过重复 dump）`);
    }

    skipPatterns() {
        if (this.patternCache !== null)
            return this.patternCache;
        const raw = this.config.skipDumpPatterns ?? '';
        const list = [];
        for (const piece of String(raw).split(/[,;\n]/)) {
            const text = piece.trim();
            if (text === '')
                continue;
            try {
                list.push(new RegExp(text, 'i'));
            }
            catch {
                this.log('warn', `skipDumpPatterns 中的正则无效，已忽略：${text}`);
            }
        }
        this.patternCache = list;
        return list;
    }

    /** 是否应当跳过 dump（用户名单 + 失败记忆 + 焦点探测确认）。 */
    async shouldSkipDump(serial) {
        const patterns = this.skipPatterns();
        if (patterns.length > 0) {
            const cachedPkg = this.cache.peek(serial)?.tree?.pkg ?? '';
            if (cachedPkg !== '' && patterns.some(re => re.test(cachedPkg)))
                return true;
        }
        const record = this.dumpFailure;
        if (record === null || record.serial !== serial)
            return false;
        if (Date.now() - record.at > this.config.skipDumpMs) {
            this.dumpFailure = null;
            return false;
        }
        if (record.pkg === '' && record.activity === '')
            return false;
        const probe = await this.probe();
        if (!probe.ok)
            return false;
        const samePkg = record.pkg === '' || probe.pkg === record.pkg;
        const sameActivity = record.activity === '' || probe.activity === '' || probe.activity === record.activity;
        if (samePkg && sameActivity)
            return true;
        // 换界面了，失败记录作废
        this.dumpFailure = null;
        return false;
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
