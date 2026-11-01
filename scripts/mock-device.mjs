/**
 * 替身设备：用可控延迟模拟真机的 dump / 探测 / 动作耗时。
 *
 * 供 selftest 与 bench 共用。它实现的是 `Adb` 的 exec 注入点，
 * 因此被测试的是真实的解析、缓存、脚本拼装逻辑，只有设备被替换。
 * @module dsh-quick-adb/scripts/mock-device
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0)]);

export const wait = ms => new Promise(done => setTimeout(done, ms));

export function loadFixtures() {
    return {
        home: readFileSync(join(root, 'fixtures/home.xml'), 'utf8'),
        search: readFileSync(join(root, 'fixtures/search.xml'), 'utf8'),
        webview: readFileSync(join(root, 'fixtures/webview.xml'), 'utf8'),
    };
}

/**
 * @param {{startScreen?: string, dumpMs?: number, probeMs?: number, actionMs?: number, shotMs?: number}} options
 */
export function createFakeAdb({ startScreen = 'home', dumpMs = 520, probeMs = 110, actionMs = 45, shotMs = 480, faults = {} } = {}) {
    const fixtures = loadFixtures();
    // faults 用于注入失败场景（审计结论：原测试只能跑「一切正常」的路径）
    //   unsupportedCompressed: n 次压缩 dump 返回 Unknown option
    //   emptyDumps: n 次返回空层级；dumpErrors: n 次直接抛错；badPng: 截图不是 PNG
    const state = { screen: startScreen, calls: 0, scripts: [], taps: [], typed: [], faults: { unsupportedCompressed: 0, emptyDumps: 0, dumpErrors: 0, badPng: false, probePkg: null, ...faults } };
    const focus = {
        home: '  mCurrentFocus=Window{4b86 u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}',
        search: '  mCurrentFocus=Window{5c21 u0 com.tencent.mm/com.tencent.mm.ui.SearchUI}',
        webview: '  mCurrentFocus=Window{77aa u0 com.example.webapp/com.example.webapp.MainActivity}',
    };
    const exec = async (argv) => {
        state.calls++;
        if (argv.includes('devices'))
            return { stdout: 'List of devices attached\nfake-serial-1\tdevice product:test model:Pixel_7\n', stderr: '' };
        if (argv.includes('screencap')) {
            await wait(shotMs);
            return { stdout: state.faults.badPng ? Buffer.from('not-a-png') : PNG };
        }
        const script = String(argv[argv.length - 1] ?? '');
        state.scripts.push(script);
        // 设备端 sleep 也是真实耗时（同一往返内），mock 必须如实模拟
        const sleeps = [...script.matchAll(/sleep ([\d.]+)/g)].map(m => Number(m[1]) * 1000).filter(v => Number.isFinite(v));
        if (sleeps.length > 0)
            await wait(sleeps.reduce((a, b) => a + b, 0));
        if (script.includes('dumpsys window')) {
            await wait(probeMs);
            const line = focus[state.screen] ?? '';
            if (state.faults.probePkg !== null)
                return { stdout: line.replace(/com\.[a-z.]+\//, state.faults.probePkg + '/'), stderr: '' };
            return { stdout: line, stderr: '' };
        }
        if (script.includes('wm size'))
            return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
        const tap = /input tap (\d+) (\d+)/.exec(script);
        if (tap !== null) {
            await wait(actionMs);
            state.taps.push({ x: Number(tap[1]), y: Number(tap[2]) });
            if (state.screen === 'home')
                state.screen = 'search';
        }
        const text = /input text '([^']*)'/.exec(script);
        if (text !== null)
            state.typed.push(text[1]);
        if (/input keyevent 4\b/.test(script) && state.screen === 'search')
            state.screen = 'home';
        if (script.includes('uiautomator dump')) {
            if (state.faults.dumpErrors > 0) {
                state.faults.dumpErrors--;
                throw new Error('adb 调用超时（8000ms）：模拟界面卡住');
            }
            if (script.includes('--compressed') && state.faults.unsupportedCompressed > 0) {
                state.faults.unsupportedCompressed--;
                await wait(dumpMs);
                return { stdout: '', stderr: 'Error: Unknown option: --compressed' };
            }
            if (state.faults.emptyDumps > 0) {
                state.faults.emptyDumps--;
                await wait(dumpMs);
                return { stdout: '<hierarchy rotation="0" />', stderr: '' };
            }
            await wait(dumpMs);
            return { stdout: `<hierarchy rotation="0"></hierarchy>\n${fixtures[state.screen] ?? fixtures.home}`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
    };
    return { exec, state };
}

export default { createFakeAdb, loadFixtures, wait, PNG };
