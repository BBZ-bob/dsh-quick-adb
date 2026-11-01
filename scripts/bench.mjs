#!/usr/bin/env node
/**
 * 优化前后单步耗时对比。
 *
 * 三条时间线，同一台设备、同一批动作，只换感知方式：
 *   legacy  截图(1 次往返) → 多模态识图(常量) → 生成并执行代码(常量) → 点击(1 次往返)
 *   plugin  控件树感知 + 点击 + 稳定等待 + 重新解析（合并为 1 次往返）
 *
 * 识图与代码生成的耗时是模型侧延迟，无法在本机测出来，因此用
 * --vision-ms / --gen-ms 显式传入你现有链路的实测值；ADB 往返与 dump 耗时
 * 则是真测的（mock 模式下用注入延迟模拟真机）。
 *
 * 用法：
 *   node scripts/bench.mjs                       # mock 设备，默认参数
 *   node scripts/bench.mjs --steps 20 --vision-ms 3000 --gen-ms 1500
 *   node scripts/bench.mjs --real --serial 192.168.1.20:5555 --x 540 --y 1200
 *   node scripts/bench.mjs --report              # 读 DSH_HOME/quick-adb/timing.jsonl
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Adb } from '../lib/adb.js';
import { ScreenCache } from '../lib/cache.js';
import { AndroidEngine } from '../lib/engine.js';
import { normalizeConfig } from '../lib/schema.js';
import { TimingLog } from '../lib/timing.js';
import { createFakeAdb } from './mock-device.mjs';

function parseArgs(argv) {
    const out = { mode: 'mock', steps: 12, visionMs: 2500, genMs: 1200, x: 540, y: 1200, serial: '', report: false, dumpMs: 520, shotMs: 480 };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        const next = argv[i + 1];
        switch (key) {
            case '--real': out.mode = 'real'; break;
            case '--mock': out.mode = 'mock'; break;
            case '--report': out.report = true; break;
            case '--steps': out.steps = Number(next); i++; break;
            case '--vision-ms': out.visionMs = Number(next); i++; break;
            case '--gen-ms': out.genMs = Number(next); i++; break;
            case '--dump-ms': out.dumpMs = Number(next); i++; break;
            case '--shot-ms': out.shotMs = Number(next); i++; break;
            case '--x': out.x = Number(next); i++; break;
            case '--y': out.y = Number(next); i++; break;
            case '--serial': out.serial = String(next); i++; break;
            default: break;
        }
    }
    return out;
}

const sleep = ms => new Promise(done => setTimeout(done, Math.max(0, ms)));

function percentile(values, p) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}

function stats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    return {
        avg: Math.round(sum / values.length),
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
        total: Math.round(sum),
    };
}

const args = parseArgs(process.argv.slice(2));
const home = process.env.DSH_HOME ?? join(homedir() || '/tmp', '.dsh');
const timingFile = join(home, 'quick-adb', 'timing.jsonl');

if (args.report) {
    const timing = new TimingLog({ file: timingFile, enabled: false });
    const entries = await timing.readFile({ limit: 2000 });
    if (entries.length > 0) {
        // 用文件内容重建内存样本，保证跨会话也能出报告
        for (const entry of entries)
            timing.buffer.push(entry);
        const fromFile = timing.report({ baseline: { stepMs: args.visionMs + args.genMs + 900, adbCalls: 2 } });
        console.log(timing.formatReport(fromFile));
        console.log(`\n数据源：${timingFile}（${entries.length} 条）`);
    }
    else {
        console.log(`没有找到计时日志：${timingFile}（先在 dsh 里跑几步 adb_* 工具）`);
    }
    process.exit(0);
}

// ------------------------------------------------------------------ 准备设备
const fake = args.mode === 'mock' ? createFakeAdb({ dumpMs: args.dumpMs, shotMs: args.shotMs }) : null;
const serial = args.serial !== '' ? args.serial : (fake !== null ? 'fake-serial-1' : '');
const adb = new Adb({ serial, exec: fake !== null ? fake.exec : null });
const config = normalizeConfig({ serial, settleFastMs: 250 });
const cache = new ScreenCache({ softTtlMs: config.softTtlMs, hardTtlMs: config.hardTtlMs });
const timing = new TimingLog({ file: join(home, 'quick-adb', 'bench-timing.jsonl'), enabled: false, log: () => {} });
const engine = new AndroidEngine({ config, adb, timing, cache, log: () => {} });

console.log(`\n=== 单步耗时对比（${args.mode === 'mock' ? `mock 设备 dump=${args.dumpMs}ms 截图=${args.shotMs}ms` : `真机 ${serial || 'auto'}`}，${args.steps} 步） ===`);
console.log(`模型侧常量：识图 ${args.visionMs}ms + 生成并执行代码 ${args.genMs}ms（按你现有链路的实测值填 --vision-ms / --gen-ms）\n`);

// ------------------------------------------------------------------ 旧流程
const legacySteps = [];
const legacyCalls = [];
for (let i = 0; i < args.steps; i++) {
    const before = adb.calls;
    const started = Date.now();
    // 1. 截图
    if (args.mode === 'mock')
        await adb.execOut(['screencap', '-p'], { encoding: 'buffer' });
    else
        await adb.execOut(['screencap', '-p'], { encoding: 'buffer', timeoutMs: 15000 });
    // 2. 多模态识图 + 3. 生成并执行代码（模型侧，等值常量）
    await sleep(args.visionMs + args.genMs);
    // 4. 执行点击
    await adb.shell(`input tap ${args.x} ${args.y}`, { timeoutMs: 20000 });
    legacySteps.push(Date.now() - started);
    legacyCalls.push(adb.calls - before);
    if (fake !== null)
        fake.state.screen = 'home';
}

// ------------------------------------------------------------------ 新流程
if (fake !== null)
    fake.state.screen = 'home';
cache.clear();
const cacheBefore = { exact: 0 };
const pluginSteps = [];
const pluginCalls = [];
for (let i = 0; i < args.steps; i++) {
    const before = adb.calls;
    const started = Date.now();
    await engine.tap({ x: args.x, y: args.y, selector: undefined, settle: 'fast' });
    pluginSteps.push(Date.now() - started);
    pluginCalls.push(adb.calls - before);
    if (fake !== null)
        fake.state.screen = 'home';
}

const legacy = stats(legacySteps);
const plugin = stats(pluginSteps);
const speedup = (legacy.avg / plugin.avg).toFixed(2);
const callDrop = ((1 - (pluginCalls.reduce((a, b) => a + b, 0) / pluginCalls.length) / (legacyCalls.reduce((a, b) => a + b, 0) / legacyCalls.length)) * 100).toFixed(0);

const rows = [
    ['旧：截图→识图→生成代码→执行', legacy, legacyCalls],
    ['新：控件树→动作合并往返', plugin, pluginCalls],
];
console.log('路径                              平均/步   p50    p95    最慢   总耗时   往返/步');
for (const [label, stat, calls] of rows) {
    const perStepCalls = calls.reduce((a, b) => a + b, 0) / calls.length;
    console.log(`${label.padEnd(30)} ${String(stat.avg).padStart(7)} ${String(stat.p50).padStart(6)} ${String(stat.p95).padStart(6)} ${String(stat.max).padStart(6)} ${String(stat.total).padStart(8)} ${perStepCalls.toFixed(2).padStart(8)}`);
}
console.log(`\n单步加速 ${speedup}×；ADB 往返减少 ${callDrop}%；${args.steps} 步累计省下 ${((legacy.total - plugin.total) / 1000).toFixed(1)}s`);
console.log(`\n把下面两行写进插件 config，adb_timing 报告就会直接给同样的结论：`);
console.log(`  baselineStepMs: ${legacy.avg}`);
console.log(`  baselineAdbCalls: ${(legacyCalls.reduce((a, b) => a + b, 0) / legacyCalls.length).toFixed(2)}`);

const outDir = join(home, 'quick-adb');
const outFile = join(outDir, `bench-${args.mode}-${Date.now()}.json`);
try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outFile, JSON.stringify({
        mode: args.mode,
        steps: args.steps,
        visionMs: args.visionMs,
        genMs: args.genMs,
        legacy: { ...legacy, callsPerStep: Number((legacyCalls.reduce((a, b) => a + b, 0) / legacyCalls.length).toFixed(2)) },
        plugin: { ...plugin, callsPerStep: Number((pluginCalls.reduce((a, b) => a + b, 0) / pluginCalls.length).toFixed(2)) },
        speedup: Number(speedup),
        cache: cache.snapshot().stats,
    }, null, 2), 'utf8');
    console.log(`\n结果已写入 ${outFile}`);
}
catch (error) {
    console.log(`结果写入失败：${error instanceof Error ? error.message : String(error)}`);
}
