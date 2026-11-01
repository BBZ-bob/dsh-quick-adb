#!/usr/bin/env node
/**
 * 自测：不需要真机即可验证「解析 / 定位 / 缓存 / 动作合成 / 批处理 / 兜底 / 安全开关 / 计时」。
 *
 * v0.2（审计整改）新增：
 *   - L2 探测复核路径（原来零覆盖）
 *   - settle:none 与 batch verify:false 的缓存失效
 *   - allowShell=false 下 batch 的 shell 步骤必须被拦
 *   - adb_app 包名注入必须被拒且零 ADB 调用
 *   - dump 降级链（不支持 --compressed / 超时 / 空层级 / 全失败）
 *   - wait 超时上界、nth 越界报错、render 输出 find
 * 并用同一台替身设备实测「朴素三步式」的往返数，作为对照基线（不再拍脑袋乘 3）。
 *
 * 运行：node scripts/selftest.mjs
 * 详细计时：DSH_ADB_SELFTEST_VERBOSE=1 node scripts/selftest.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Adb } from '../lib/adb.js';
import { ScreenCache } from '../lib/cache.js';
import { buildTree } from '../lib/dump.js';
import { AndroidEngine } from '../lib/engine.js';
import { normalizeConfig } from '../lib/schema.js';
import { resolve } from '../lib/selector.js';
import { TimingLog } from '../lib/timing.js';
import { createFakeAdb, loadFixtures } from './mock-device.mjs';

const fixtures = loadFixtures();
const wait = ms => new Promise(done => setTimeout(done, ms));

/** 默认用很小的延迟跑逻辑，只有计时相关场景才用真实量级。 */
function makeFake(options = {}) {
    return createFakeAdb({ dumpMs: 80, probeMs: 20, actionMs: 10, shotMs: 20, ...options });
}

function makeEngine({ fake, config = {} } = {}) {
    const f = fake ?? makeFake();
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-qadb-'));
    const cfg = normalizeConfig({ serial: 'fake-serial-1', screenshotDir: join(tmp, 'shots'), ...config });
    const adb = new Adb({ serial: 'fake-serial-1', exec: f.exec });
    const timing = new TimingLog({ file: join(tmp, 'timing.jsonl'), enabled: true, log: () => {} });
    const cache = new ScreenCache({ softTtlMs: cfg.softTtlMs, hardTtlMs: cfg.hardTtlMs });
    const engine = new AndroidEngine({ config: cfg, adb, timing, cache, log: () => {} });
    return { engine, adb, timing, cache, tmp, fake: f };
}

const checks = [];
function check(name, condition, detail = '') {
    checks.push({ name, ok: condition === true, detail });
    console.log(`  [${condition === true ? 'PASS' : 'FAIL'}] ${name}${detail !== '' ? ` — ${detail}` : ''}`);
}

const stats = [];
function record(scenario, steps, calls, ms) {
    stats.push({ scenario, steps, calls, ms, perStep: calls / Math.max(1, steps) });
}

console.log('\n=== 1. 控件树解析（无 ADB） ===');
{
    const tree = buildTree(fixtures.home);
    check('解析出节点', tree.nodes.length >= 10, `nodes=${tree.nodes.length}`);
    check('提取包名', tree.pkg === 'com.tencent.mm', tree.pkg);
    check('计算界面签名', /^[0-9a-f]{8}$/.test(tree.signature), tree.signature);
    const row = tree.nodes.find(node => node.text === '文件传输助手');
    check('可点击容器内的文本被继承为标签', row !== undefined && row.label === '文件传输助手', row?.label);
    const entities = buildTree('<hierarchy rotation="0"><node text="a&amp;b &lt;c&gt;" class="android.widget.TextView" package="p" bounds="[0,0][10,10]" /></hierarchy>');
    check('XML 实体被解码', entities.nodes[0].text === 'a&b <c>', entities.nodes[0].text);
}

console.log('\n=== 2. 定位与可点击性提升（无 ADB） ===');
{
    const tree = buildTree(fixtures.home);
    const lifted = resolve(tree, { text: '文件传输助手' });
    check('按文案定位成功', lifted.ok === true);
    check('提升到可点击行容器', lifted.lifted === true && lifted.point.y === 330, JSON.stringify(lifted.point));
    const byId = resolve(tree, { id: 'action_bar_search' });
    check('按简写 id 定位', byId.ok === true && byId.point.x === 900 && byId.point.y === 160, JSON.stringify(byId.point));
    const miss = resolve(tree, { text: '不存在的按钮' });
    check('未命中时保留候选', miss.ok === false && miss.candidates.length > 0, miss.candidates.slice(0, 3).join(' / '));
    const outOfRange = resolve(tree, { cls: 'TextView', nth: 99 });
    check('nth 越界必须失败而不是钳制', outOfRange.ok === false && outOfRange.reason === 'nth-out-of-range', `matches=${outOfRange.matches}`);
}

console.log('\n=== 3. L1 缓存：同屏复用 ===');
{
    const { engine, adb, cache, tmp } = makeEngine();
    const first = await engine.screen();
    const afterFirst = adb.calls;
    const second = await engine.screen();
    const third = await engine.screen();
    check('首次感知走 dump', first.source === 'dump', `calls=${afterFirst}`);
    check('第二次 0 次 ADB', adb.calls === afterFirst && second.source === 'cache', `source=${second.source}`);
    check('第三次仍然 0 次 ADB', third.source === 'cache');
    check('精确命中计数为 2', cache.snapshot().stats.exact === 2, JSON.stringify(cache.snapshot().stats));
    record('同屏重复感知 ×3', 3, adb.calls, 0);
    rmSync(tmp, { recursive: true, force: true });
}

console.log('\n=== 4. L2 缓存：焦点探测复核（原测试未覆盖） ===');
{
    const { engine, adb, tmp } = makeEngine({ config: { softTtlMs: 20, hardTtlMs: 15000 } });
    await engine.screen();
    await wait(40);
    const before = adb.calls;
    const verified = await engine.screen();
    check('软 TTL 过后走探测复核', verified.source === 'cache-verified', `source=${verified.source}`);
    check('复核只花 1 次往返', adb.calls - before === 1, `delta=${adb.calls - before}`);
    check('复核命中不重新解析', verified.nodes > 0 && verified.ageMs >= 30, `age=${verified.ageMs}ms`);
    rmSync(tmp, { recursive: true, force: true });

    const mismatch = makeEngine({ config: { softTtlMs: 20, hardTtlMs: 15000 } });
    await mismatch.engine.screen();
    mismatch.fake.state.faults.probePkg = 'com.other.app';
    await wait(40);
    const forced = await mismatch.engine.screen();
    check('探测包名不符时重新解析', forced.source === 'dump', `source=${forced.source}`);
    rmSync(mismatch.tmp, { recursive: true, force: true });
}

console.log('\n=== 5. 动作 + 稳定等待 + 重新解析：一次往返 ===');
{
    const { engine, adb, tmp, fake } = makeEngine();
    await engine.screen();
    const before = adb.calls;
    const result = await engine.tap({ selector: { text: '搜索' } });
    check('点击成功', result.ok === true);
    check('点击只花 1 次 ADB 往返（含等待与重新 dump）', adb.calls - before === 1, `delta=${adb.calls - before}`);
    check('点击坐标精确命中搜索入口', JSON.stringify(result.point) === '{"x":900,"y":160}', JSON.stringify(result.point));
    check('动作结果里带回新界面', result.screen?.text.includes('取消') === true);
    check('点击落在设备侧', fake.state.taps.length === 1 && fake.state.taps[0].x === 900);
    const next = await engine.screen();
    check('下一步感知命中缓存（0 往返）', next.source === 'cache', next.source);
    record('定位点击 + 取回新界面', 1, adb.calls - before, 0);
    rmSync(tmp, { recursive: true, force: true });
}

console.log('\n=== 6. settle:none 必须作废缓存 ===');
{
    const { engine, cache, tmp } = makeEngine();
    await engine.screen();
    check('前置：缓存可用', cache.snapshot().slots[0].dirty === false);
    const result = await engine.tap({ x: 900, y: 160, settle: 'none' });
    check('settle=none 不返回界面', result.settle === 'none' && result.screen === undefined);
    check('缓存被标记为 dirty', cache.snapshot().slots[0].dirty === true);
    const after = await engine.screen();
    check('下一次感知重新解析', after.source === 'dump', after.source);
    rmSync(tmp, { recursive: true, force: true });
}

console.log('\n=== 7. 批量指令合并往返 ===');
{
    const { engine, adb, tmp, fake } = makeEngine();
    await engine.screen();
    const before = adb.calls;
    const result = await engine.batch({
        steps: [
            { tap: '搜索' },
            { wait: 200 },
            { input: { text: 'hello world', submit: true } },
        ],
    });
    check('批处理整体成功', result.ok === true, result.error ?? '');
    check('3 步只花 1 次往返', adb.calls - before === 1, `delta=${adb.calls - before}`);
    check('文本按 %s 契约注入', fake.state.typed[0] === 'hello%sworld', fake.state.typed[0]);
    check('结尾验证拿到界面', result.screen?.pkg === 'com.tencent.mm');
    check('步骤结果完整', result.steps.length === 3 && result.steps.every(step => step.ok), JSON.stringify(result.steps.map(s => s.kind)));
    record('批处理 3 步', 3, adb.calls - before, 0);
    rmSync(tmp, { recursive: true, force: true });
}

console.log('\n=== 8. 批量 verify:false 必须作废缓存（P1-1 回归） ===');
{
    const { engine, cache, tmp } = makeEngine();
    await engine.screen();
    const result = await engine.batch({ steps: [{ tap: '搜索' }, { wait: 50 }], verify: false });
    check('批处理成功但未取界面', result.ok === true && result.screen === null);
    check('明确标记缓存已作废', result.cacheInvalidated === true);
    check('缓存 dirty', cache.snapshot().slots[0].dirty === true);
    const after = await engine.screen();
    check('下一步重新解析而不是吃旧树', after.source === 'dump', after.source);
    rmSync(tmp, { recursive: true, force: true });
}

console.log('\n=== 9. allowShell=false 必须同时拦住 batch（P0-2 回归） ===');
{
    const { engine, tmp, fake } = makeEngine({ config: { allowShell: false } });
    await engine.screen();
    let direct = '';
    try {
        await engine.shell({ command: 'echo direct' });
    }
    catch (error) {
        direct = error.message;
    }
    check('adb_shell 被拦截', direct.includes('allowShell'), direct.slice(0, 40));
    const viaBatch = await engine.batch({ steps: [{ shell: 'echo leaked' }] });
    check('batch 的 shell 步骤被拦截', viaBatch.ok === false && viaBatch.error.includes('allowShell'), viaBatch.error.slice(0, 40));
    check('设备侧确实没收到命令', fake.state.scripts.every(script => !script.includes('echo leaked')));
    rmSync(tmp, { recursive: true, force: true });
}

console.log('\n=== 10. adb_app 包名校验（P0-1 回归） ===');
{
    const { engine, adb, tmp } = makeEngine();
    const before = adb.calls;
    let message = '';
    try {
        await engine.app({ action: 'start', package: 'com.x; echo PWNED' });
    }
    catch (error) {
        message = error.message;
    }
    check('非法包名被拒绝', message.includes('非法包名'), message.slice(0, 40));
    check('拒绝时零 ADB 调用', adb.calls === before, `delta=${adb.calls - before}`);
    const valid = makeEngine();
    await valid.engine.app({ action: 'start', package: 'com.android.settings', settle: 'none' });
    const command = valid.fake.state.scripts.at(-1) ?? '';
    check('合法包名可以启动', command.includes('monkey -p'));
    check('包名在命令中被引号包裹', command.includes("'com.android.settings'"), command.slice(0, 50));
    rmSync(valid.tmp, { recursive: true, force: true });
    let badActivity = '';
    try {
        await engine.app({ action: 'start', package: 'com.a.b', activity: 'Main; rm -rf /' });
    }
    catch (error) {
        badActivity = error.message;
    }
    check('非法 Activity 被拒绝', badActivity.includes('非法 Activity'), badActivity.slice(0, 40));
    rmSync(tmp, { recursive: true, force: true });
}

console.log('\n=== 11. 等待：命中与超时上界 ===');
{
    const hit = makeEngine({ fake: makeFake({ startScreen: 'search' }) });
    await hit.engine.screen();
    const before = hit.adb.calls;
    const appeared = await hit.engine.wait({ selector: { text: '没有更多了' }, timeoutMs: 3000 });
    check('已在当前界面时立即返回', appeared.ok === true && appeared.attempts === 1);
    check('等待不产生额外往返', hit.adb.calls === before);
    record('等待已在屏元素', 1, hit.adb.calls - before, 0);
    rmSync(hit.tmp, { recursive: true, force: true });

    const slow = makeEngine({ fake: makeFake({ dumpMs: 200 }) });
    const started = Date.now();
    let timeoutMessage = '';
    try {
        await slow.engine.wait({ selector: { text: '永不出现' }, timeoutMs: 300 });
    }
    catch (error) {
        timeoutMessage = error.message;
    }
    const elapsed = Date.now() - started;
    check('超时抛错并附最后界面', timeoutMessage.includes('等待超时'), timeoutMessage.slice(0, 30));
    check('超时上界受控（< 超时 + 一个 dump）', elapsed < 900, `elapsed=${elapsed}ms`);
    rmSync(slow.tmp, { recursive: true, force: true });
}

console.log('\n=== 12. dump 降级链 ===');
{
    const unsupported = makeEngine({ fake: makeFake({ faults: { unsupportedCompressed: 1 } }) });
    const result = await unsupported.engine.screen();
    check('不认识 --compressed 时自动降级并成功', result.source === 'dump' && result.nodes > 0);
    check('能力位被永久关闭', unsupported.engine.caps.compressed === false);
    rmSync(unsupported.tmp, { recursive: true, force: true });

    const timeout = makeEngine({ fake: makeFake({ faults: { dumpErrors: 1 } }) });
    const recovered = await timeout.engine.screen();
    check('一次超时后仍成功', recovered.source === 'dump');
    check('超时不会永久关闭压缩（P2-3）', timeout.engine.caps.compressed === true);
    rmSync(timeout.tmp, { recursive: true, force: true });

    const empty = makeEngine({ fake: makeFake({ faults: { emptyDumps: 1 } }) });
    const afterEmpty = await empty.engine.screen();
    check('空层级会重试为普通 dump', afterEmpty.source === 'dump' && afterEmpty.nodes > 0);
    rmSync(empty.tmp, { recursive: true, force: true });

    const broken = makeEngine({ fake: makeFake({ faults: { emptyDumps: 2 } }) });
    let dumpError = '';
    try {
        await broken.engine.screen();
    }
    catch (error) {
        dumpError = error.message;
    }
    check('两次都失败时报 dump-failed', dumpError.includes('控件树不可用'), dumpError.slice(0, 30));
    rmSync(broken.tmp, { recursive: true, force: true });
}

console.log('\n=== 13. 视觉兜底：截图与外部命令 ===');
{
    const shotOnly = makeEngine({ fake: makeFake({ startScreen: 'webview' }) });
    let message = '';
    try {
        await shotOnly.engine.tap({ selector: { text: '确定' } });
    }
    catch (error) {
        message = error.message;
    }
    check('未配 visionCommand 时落盘截图并报错', message.includes('已截图兜底'), message.slice(0, 50));
    check('视觉兜底被计数', shotOnly.cache.snapshot().stats.vision === 1);

    const script = join(shotOnly.tmp, 'vision.mjs');
    writeFileSync(script, 'process.stdout.write(JSON.stringify({items:[{text:"确定",x:540,y:1820}]}))', 'utf8');
    const withCommand = makeEngine({
        fake: makeFake({ startScreen: 'webview' }),
        config: { visionCommand: `node "${script.replace(/\\/g, '/')}"` },
    });
    const tapped = await withCommand.engine.tap({ selector: { text: '确定' }, settle: 'none' });
    check('配置 visionCommand 后可用视觉坐标继续点击', tapped.mode === 'vision' && tapped.point.x === 540 && tapped.point.y === 1820, JSON.stringify(tapped.point));
    rmSync(shotOnly.tmp, { recursive: true, force: true });
    rmSync(withCommand.tmp, { recursive: true, force: true });
}

console.log('\n=== 14. 计时日志与报告 ===');
{
    const { engine, timing, tmp } = makeEngine({ fake: makeFake({ dumpMs: 120 }), config: { baselineStepMs: 3200, baselineAdbCalls: 3 } });
    await engine.screen();
    await engine.tap({ selector: { text: '搜索' } });
    await engine.screen();
    await timing.flush();
    const report = timing.report({ baseline: { stepMs: 3200, adbCalls: 3 } });
    check('聚合出步骤级样本', report.samples === 3, `samples=${report.samples}`);
    check('平均往返次数低于基线', report.avgAdbCalls < 3, `${report.avgAdbCalls} 次/步`);
    check('给出加速比', typeof report.speedup === 'number' && report.speedup > 1, `${report.speedup}×`);
    const lines = readFileSync(join(tmp, 'timing.jsonl'), 'utf8').trim().split('\n');
    check('JSONL 已落盘且字段完整', lines.length >= 3 && JSON.parse(lines[0]).adbCalls !== undefined, `${lines.length} 行`);
    await timing.clear();
    check('clear 清空内存与文件', timing.recent(10).length === 0 && readFileSync(join(tmp, 'timing.jsonl'), 'utf8') === '');
    if (process.env.DSH_ADB_SELFTEST_VERBOSE === '1')
        console.log(timing.formatReport(report));
    rmSync(tmp, { recursive: true, force: true });
}

console.log('\n=== 15. 工具层：注册、执行、渲染（需 @deepseek-ai/dsh-tools） ===');
{
    let toolsModule = null;
    try {
        toolsModule = await import('../lib/tools.js');
    }
    catch {
        toolsModule = null;
    }
    if (toolsModule === null || typeof toolsModule.registerTools !== 'function' || toolsModule.toolsLoadError() !== null) {
        console.log('  [SKIP] 当前环境没有 @deepseek-ai/dsh-tools（在 dsh profile 内运行才会加载成功）');
    }
    else {
        const build = (fake) => {
            const made = makeEngine({ fake: fake ?? makeFake() });
            const tools = [];
            toolsModule.registerTools({ tools: { register: tool => { tools.push(tool); return () => {}; } } }, made.engine, made.engine.config);
            return { ...made, tools, byName: new Map(tools.map(tool => [tool.name, tool])) };
        };
        const base = build();
        const names = base.byName;
        check('注册 10 个工具', names.size === 10, [...names.keys()].join(','));
        check('工具名以 adb_ 前缀统一', [...names.keys()].every(name => name.startsWith('adb_')));

        const run = async (name, args, fake) => {
            const made = build(fake);
            const value = await made.byName.get(name).execute(args, {});
            return { value, made };
        };

        const screen = await run('adb_screen', { selector: { text: '搜索' } });
        check('adb_screen 返回目标与定位', screen.value.targetCount > 0 && screen.value.find?.ok === true, JSON.stringify(screen.value.find?.point));
        const rendered = names.get('adb_screen').output.render({}, screen.value)[0].text;
        check('adb_screen 渲染文本包含命中坐标（P1-3 回归）', rendered.includes('定位命中') && rendered.includes('(900,160)'), rendered.split('\n').pop());
        rmSync(screen.made.tmp, { recursive: true, force: true });

        const tap = await run('adb_tap', { selector: { text: '搜索' } });
        check('adb_tap 返回新界面', tap.value.settle === 'dumped' && tap.value.point.x === 900);
        rmSync(tap.made.tmp, { recursive: true, force: true });

        const swipe = await run('adb_swipe', { direction: 'up' });
        check('adb_swipe 行程按屏幕换算', swipe.value.from.y > swipe.value.to.y && swipe.value.durationMs === 300, JSON.stringify([swipe.value.from, swipe.value.to]));
        rmSync(swipe.made.tmp, { recursive: true, force: true });

        const input = await run('adb_input', { text: 'abc' });
        check('adb_input 注入 ASCII 无告警', input.value.chars === 3 && input.value.note === '', input.value.note);
        rmSync(input.made.tmp, { recursive: true, force: true });

        const percent = await run('adb_input', { text: '50% off' });
        check('含 % 的文本给出告警（P2-1）', percent.value.note.includes('%'), percent.value.note.slice(0, 30));
        rmSync(percent.made.tmp, { recursive: true, force: true });

        const key = await run('adb_key', { key: 'back', times: 2 });
        check('adb_key 连按只发一组命令', key.value.code === 4 && key.value.times === 2);
        rmSync(key.made.tmp, { recursive: true, force: true });

        const waitTool = await run('adb_wait', { selector: { text: '通讯录' }, timeoutMs: 2000 });
        check('adb_wait 返回命中坐标', waitTool.value.ok === true && waitTool.value.point !== null);
        rmSync(waitTool.made.tmp, { recursive: true, force: true });

        // 批量要断言「合并往返」，必须先有缓存（首步本来就要花一次感知）
        const batchMade = makeEngine();
        await batchMade.engine.screen();
        const batchTools = [];
        toolsModule.registerTools({ tools: { register: tool => { batchTools.push(tool); return () => {}; } } }, batchMade.engine, batchMade.engine.config);
        const batchTool = batchTools.find(tool => tool.name === 'adb_batch');
        const batchValue = await batchTool.execute({ steps: [{ tap: '搜索' }, { wait: 100 }] }, {});
        check('adb_batch 合并为 1 次往返', batchValue.adbCalls === 1 && batchValue.ok === true, `calls=${batchValue.adbCalls}`);
        const batchRendered = batchTool.output.render({}, batchValue)[0].text;
        check('adb_batch 渲染包含步骤序列', /步骤：1✓ 2✓/.test(batchRendered), batchRendered.split('\n')[1] ?? '');
        rmSync(batchMade.tmp, { recursive: true, force: true });

        const app = await run('adb_app', { action: 'current' });
        check('adb_app current 返回前台包名', app.value.pkg === 'com.tencent.mm', app.value.pkg);
        rmSync(app.made.tmp, { recursive: true, force: true });

        const shell = await run('adb_shell', { command: 'echo hi' });
        check('adb_shell 可执行并返回', shell.value.ok === true);
        rmSync(shell.made.tmp, { recursive: true, force: true });

        const timingTool = await run('adb_timing', {});
        check('adb_timing 输出报告文本', timingTool.value.text.includes('计时报告'));
        rmSync(timingTool.made.tmp, { recursive: true, force: true });

        let renderError = '';
        for (const [name, tool] of names) {
            try {
                const parts = tool.output.render({}, { text: 'x', settle: 'dumped', steps: [], find: null });
                if (!Array.isArray(parts) || typeof parts[0]?.text !== 'string')
                    throw new Error('render 返回结构异常');
            }
            catch (error) {
                renderError += `${name}: ${error.message}; `;
            }
        }
        check('10 个 render 对空结果均可渲染', renderError === '', renderError);
        rmSync(base.tmp, { recursive: true, force: true });
    }
}

console.log('\n=== 往返次数对照（同一台替身设备实测） ===');
{
    // 实测「朴素三步式」：dump / cat / input 各一次往返
    const fake = makeFake();
    const adb = new Adb({ serial: 'fake-serial-1', exec: fake.exec });
    const naiveBefore = adb.calls;
    await adb.shell('uiautomator dump --compressed /sdcard/ui.xml');
    await adb.shell('cat /sdcard/ui.xml');
    await adb.shell('input tap 540 1200');
    const naivePerStep = adb.calls - naiveBefore;

    console.log('场景                        步骤  ADB往返  往返/步');
    for (const row of stats) {
        console.log(`${row.scenario.padEnd(24)} ${String(row.steps).padStart(5)} ${String(row.calls).padStart(7)} ${row.perStep.toFixed(2).padStart(8)}`);
    }
    const steps = stats.reduce((acc, row) => acc + row.steps, 0);
    const calls = stats.reduce((acc, row) => acc + row.calls, 0);
    console.log(`${'合计'.padEnd(24)} ${String(steps).padStart(5)} ${String(calls).padStart(7)} ${(calls / steps).toFixed(2).padStart(8)}`);
    console.log(`对照（实测）：朴素三步式 ${naivePerStep} 次往返/步；本插件 ${(calls / steps).toFixed(2)} 次/步。`);
    check('平均往返次数低于朴素实现', calls / steps < naivePerStep, `${(calls / steps).toFixed(2)} < ${naivePerStep}`);
}

const failed = checks.filter(item => !item.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
    console.log('失败项：' + failed.map(item => item.name).join('; '));
    process.exit(1);
}
