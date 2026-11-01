/**
 * 计时日志：每次 ADB 往返、每次感知来源都留一条 JSONL。
 *
 * 目的不只是「看耗时」，而是让「优化前后对比」有可重复的量化口径：
 *   - adbCalls：这一步花了几次 ADB 往返（往返次数才是单步耗时的主因）
 *   - source：cache / cache-verified / dump / vision（缓存是否真的生效）
 *   - wallMs：宿主侧墙钟耗时
 * 报告按 op 聚合 p50/p95，配合 scripts/bench.mjs 的基线即可给出加速比。
 * @module dsh-quick-adb/timing
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { padDisplay } from './util.js';

function percentile(sorted, p) {
    if (sorted.length === 0)
        return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}

export class TimingLog {
    constructor({ file = '', enabled = true, maxBytes = 8 * 1024 * 1024, ring = 2000, log = () => {} } = {}) {
        this.file = file;
        this.enabled = enabled;
        this.maxBytes = maxBytes;
        this.ring = ring;
        this.log = log;
        this.buffer = [];
        this.queue = Promise.resolve();
        this.writes = 0;
    }

    /**
     * 记录一条。
     * @param {{op: string, kind?: string, wallMs?: number, adbCalls?: number, source?: string, ok?: boolean, serial?: string, extra?: object}} entry
     */
    record(entry) {
        const record = {
            ts: new Date().toISOString(),
            op: entry.op ?? 'unknown',
            kind: entry.kind ?? 'op',
            wallMs: Math.round(entry.wallMs ?? 0),
            adbCalls: entry.adbCalls ?? 0,
            source: entry.source ?? '',
            ok: entry.ok !== false,
            serial: entry.serial ?? '',
        };
        if (entry.extra !== undefined)
            record.extra = entry.extra;
        this.buffer.push(record);
        if (this.buffer.length > this.ring)
            this.buffer.splice(0, this.buffer.length - this.ring);
        if (!this.enabled || this.file === '')
            return record;
        const line = JSON.stringify(record) + '\n';
        this.queue = this.queue
            .then(async () => {
                await mkdir(dirname(this.file), { recursive: true });
                this.writes++;
                if (this.writes % 200 === 0) {
                    try {
                        const info = await stat(this.file);
                        if (info.size > this.maxBytes)
                            await rename(this.file, this.file + '.1');
                    }
                    catch { /* 文件还不存在，忽略 */ }
                }
                await appendFile(this.file, line, 'utf8');
            })
            .catch(error => {
                this.log('warn', `计时日志写入失败: ${error instanceof Error ? error.message : String(error)}`);
            });
        return record;
    }

    /** 最近 n 条（内存环形缓冲）。 */
    recent(limit = 50) {
        return this.buffer.slice(-Math.max(1, limit));
    }

    /** 落盘 flush，脚本退出前调用。 */
    async flush() {
        await this.queue;
    }

    /**
     * 聚合报告。默认只统计面向模型的「步骤级」记录，内部 dump/probe 需显式开启。
     * @param {{limit?: number, includeInternal?: boolean, baseline?: {stepMs?: number, adbCalls?: number}}} options
     */
    report({ limit = 0, includeInternal = false, baseline = {} } = {}) {
        const source = (limit > 0 ? this.buffer.slice(-limit) : this.buffer)
            .filter(item => includeInternal || item.kind !== 'internal');
        const groups = new Map();
        for (const item of source) {
            let group = groups.get(item.op);
            if (group === undefined) {
                group = { op: item.op, count: 0, calls: 0, walls: [], ok: 0, sources: {} };
                groups.set(item.op, group);
            }
            group.count++;
            group.calls += item.adbCalls;
            group.walls.push(item.wallMs);
            if (item.ok)
                group.ok++;
            if (item.source !== '')
                group.sources[item.source] = (group.sources[item.source] ?? 0) + 1;
        }
        const rows = [];
        for (const group of groups.values()) {
            const sorted = [...group.walls].sort((a, b) => a - b);
            const sum = sorted.reduce((acc, v) => acc + v, 0);
            rows.push({
                op: group.op,
                count: group.count,
                adbCalls: Number((group.calls / group.count).toFixed(2)),
                avgMs: Math.round(sum / group.count),
                p50Ms: percentile(sorted, 50),
                p95Ms: percentile(sorted, 95),
                maxMs: sorted[sorted.length - 1] ?? 0,
                okRate: Number((group.ok / group.count).toFixed(3)),
                sources: group.sources,
            });
        }
        rows.sort((a, b) => b.count - a.count);
        const total = rows.reduce((acc, r) => acc + r.count, 0);
        const totalMs = rows.reduce((acc, r) => acc + r.avgMs * r.count, 0);
        const totalCalls = rows.reduce((acc, r) => acc + r.adbCalls * r.count, 0);
        const out = {
            samples: total,
            avgStepMs: total > 0 ? Math.round(totalMs / total) : 0,
            avgAdbCalls: total > 0 ? Number((totalCalls / total).toFixed(2)) : 0,
            rows,
        };
        const stepMs = Number(baseline.stepMs ?? 0);
        const calls = Number(baseline.adbCalls ?? 0);
        if (stepMs > 0 && out.avgStepMs > 0) {
            out.baseline = baseline;
            out.savedMsPerStep = Math.max(0, stepMs - out.avgStepMs);
            out.speedup = Number((stepMs / out.avgStepMs).toFixed(2));
            out.savedCallsPerStep = calls > 0 ? Number((calls - out.avgAdbCalls).toFixed(2)) : null;
            out.savedMsTotal = out.savedMsPerStep * total;
        }
        return out;
    }

    /** 渲染为文本表（工具与 bench 共用）。 */
    formatReport(report) {
        const lines = [];
        lines.push(`计时报告：样本 ${report.samples} 条，平均单步 ${report.avgStepMs}ms，平均 ${report.avgAdbCalls} 次 ADB 往返`);
        lines.push(`${padDisplay('op', 18)} ${'次数'.padStart(5)} ${'平均ms'.padStart(7)} ${'p50'.padStart(5)} ${'p95'.padStart(5)} ${'最大'.padStart(6)} ${'往返/次'.padStart(8)}  来源`);
        for (const row of report.rows.slice(0, 20)) {
            const sources = Object.entries(row.sources).map(([k, v]) => `${k}:${v}`).join(',');
            // 中文表头按显示宽度对齐，避免等宽假设导致错位
            lines.push(
                `${padDisplay(row.op, 18)} ${String(row.count).padStart(5)} ${String(row.avgMs).padStart(7)} ${String(row.p50Ms).padStart(5)} ${String(row.p95Ms).padStart(5)} ${String(row.maxMs).padStart(6)} ${String(row.adbCalls).padStart(8)}  ${sources}`,
            );
        }
        if (report.baseline !== undefined) {
            lines.push('');
            lines.push(`对比基线：单步 ${report.baseline.stepMs}ms / ${report.baseline.adbCalls} 次往返`);
            lines.push(`节省：每步 ${report.savedMsPerStep}ms，加速 ${report.speedup}×${report.savedCallsPerStep !== null ? `，往返减少 ${report.savedCallsPerStep} 次` : ''}`);
            lines.push(`本窗口累计节省约 ${(report.savedMsTotal / 1000).toFixed(1)}s`);
        }
        return lines.join('\n');
    }

    /** 读取磁盘上的历史日志（跨会话对比用）。 */
    async readFile({ limit = 500 } = {}) {
        if (this.file === '')
            return [];
        try {
            const raw = await readFile(this.file, 'utf8');
            const lines = raw.split('\n').filter(Boolean);
            return lines.slice(-limit).map(line => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    return null;
                }
            }).filter(Boolean);
        }
        catch {
            return [];
        }
    }

    /** 清空内存样本与日志文件。 */
    async clear({ keepFile = false } = {}) {
        // 先等落盘队列排空，否则 in-flight 的 append 会在截断后又写回旧数据
        await this.queue;
        this.buffer = [];
        if (!keepFile && this.file !== '') {
            try {
                await writeFile(this.file, '', 'utf8');
            }
            catch { /* 忽略 */ }
        }
    }
}

export default { TimingLog };
