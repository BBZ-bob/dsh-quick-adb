/**
 * 视觉兜底：只有在控件树不可用（WebView/自绘/DRM）或定位彻底失败时才走这里。
 *
 * 两条路：
 *  1. 配置了 `visionCommand`：调用任意外部多模态/OCR 命令，返回 JSON 文本块，
 *     插件据此换算坐标，动作仍可继续（真正的「自动兜底」）。
 *  2. 未配置：只落盘截图并把路径交回宿主，由 agent 既有的识图链路处理
 *     （即旧流程，但只在必要时发生）。
 * @module dsh-quick-adb/vision
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeText, safeToken, trunc } from './util.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_MAGIC);
}

/**
 * 截屏并落盘。
 * @returns {Promise<{path: string, bytes: number, ms: number, mode: string}>}
 */
export async function capture(adb, { dir, serial = '', timeoutMs = 12000, maxShots = 50, log = () => {} } = {}) {
    const started = Date.now();
    await mkdir(dir, { recursive: true });
    const file = join(dir, `screen-${Date.now()}-${safeToken(serial, 'dev')}.png`);
    const result = await adb.execOut(['screencap', '-p'], { timeoutMs, encoding: 'buffer', op: 'screencap' });
    const buffer = result.stdout;
    if (isPng(buffer)) {
        await writeFile(file, buffer);
        await pruneShots(dir, maxShots, log);
        return { path: file, bytes: buffer.length, ms: Date.now() - started, mode: 'exec-out' };
    }
    // 老平台 adb 会把 \n 改写为 \r\n，破坏 PNG。退回「设备内落盘 + pull」。
    log('warn', 'screencap 输出不是合法 PNG，退回 shell 落盘 + adb pull');
    const remote = `/sdcard/dsh_shot_${Date.now()}.png`;
    await adb.shell(`screencap -p ${remote}`, { timeoutMs, op: 'screencap-shell' });
    await adb.run(['pull', remote, file], { timeoutMs: Math.max(timeoutMs, 20000), op: 'pull' });
    await adb.shell(`rm -f ${remote}`, { timeoutMs: 5000, op: 'cleanup' }).catch(() => undefined);
    let bytes = 0;
    try {
        bytes = (await stat(file)).size;
    }
    catch { /* 文件可能没落下来，交给上层报错 */ }
    await pruneShots(dir, maxShots, log);
    return { path: file, bytes, ms: Date.now() - started, mode: 'pull' };
}

/**
 * 执行外部视觉命令。
 * 约定：stdout 为 JSON，形如
 *   {"items":[{"text":"搜索","x":540,"y":180,"w":120,"h":60}]}
 * 或直接是数组。环境变量：DSH_SHOT / DSH_SERIAL / DSH_QUERY。
 */
export function runVisionCommand({ command, shotPath, serial = '', query = '', timeoutMs = 20000, log = () => {} }) {
    if (typeof command !== 'string' || command.trim() === '')
        return Promise.resolve({ ok: false, items: [], error: 'visionCommand 未配置', raw: '' });
    return new Promise((resolve) => {
        const started = Date.now();
        let child;
        try {
            child = spawn(command, {
                shell: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                env: { ...process.env, DSH_SHOT: shotPath, DSH_SERIAL: serial, DSH_QUERY: query },
            });
        }
        catch (error) {
            resolve({ ok: false, items: [], error: error instanceof Error ? error.message : String(error), raw: '' });
            return;
        }
        const out = [];
        const err = [];
        let killed = false;
        const timer = setTimeout(() => {
            killed = true;
            try {
                child.kill('SIGKILL');
            }
            catch { /* 已退出 */ }
        }, Math.max(1000, timeoutMs));
        child.stdout.on('data', c => out.push(c));
        child.stderr.on('data', c => err.push(c));
        child.on('error', error => {
            clearTimeout(timer);
            resolve({ ok: false, items: [], error: error.message, raw: '' });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            const raw = Buffer.concat(out).toString('utf8');
            const stderr = Buffer.concat(err).toString('utf8');
            if (killed) {
                resolve({ ok: false, items: [], error: `visionCommand 超时（${timeoutMs}ms）`, raw: trunc(raw, 400) });
                return;
            }
            if (code !== 0) {
                resolve({ ok: false, items: [], error: `visionCommand 退出码 ${code}：${trunc(stderr, 300)}`, raw: trunc(raw, 400) });
                return;
            }
            const items = parseVisionItems(raw);
            if (items === null) {
                log('warn', 'visionCommand 输出不是可解析的 JSON，按纯文本丢弃');
                resolve({ ok: false, items: [], error: 'visionCommand 输出无法解析为 JSON', raw: trunc(raw, 400) });
                return;
            }
            resolve({ ok: true, items, error: '', raw: trunc(raw, 400), ms: Date.now() - started });
        });
    });
}

/** 从命令输出里提取文本块数组，容忍前后噪声。 */
function parseVisionItems(raw) {
    const text = String(raw ?? '').trim();
    if (text === '')
        return null;
    const attempts = [text];
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    if (firstBrace !== -1)
        attempts.push(text.slice(firstBrace, text.lastIndexOf('}') + 1));
    if (firstBracket !== -1)
        attempts.push(text.slice(firstBracket, text.lastIndexOf(']') + 1));
    for (const attempt of attempts) {
        try {
            const parsed = JSON.parse(attempt);
            const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : null;
            if (list === null)
                continue;
            return list.map(item => normalizeItem(item)).filter(item => item !== null);
        }
        catch { /* 试下一种切法 */ }
    }
    return null;
}

function normalizeItem(item) {
    if (item === null || typeof item !== 'object')
        return null;
    const source = item;
    const text = normalizeText(source.text ?? source.label ?? source.content ?? '');
    let x = Number(source.x ?? source.cx ?? Number.NaN);
    let y = Number(source.y ?? source.cy ?? Number.NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        const box = source.bounds ?? source.box;
        if (Array.isArray(box) && box.length >= 4) {
            x = (Number(box[0]) + Number(box[2])) / 2;
            y = (Number(box[1]) + Number(box[3])) / 2;
        }
    }
    if (text === '' || !Number.isFinite(x) || !Number.isFinite(y))
        return null;
    return { text, x: Math.round(x), y: Math.round(y), w: Number(source.w ?? 0) || 0, h: Number(source.h ?? 0) || 0 };
}

/** 用视觉结果匹配选择器文案，返回可点击坐标。 */
export function matchVisionItems(items, selector) {
    const wanted = normalizeText(selector?.text ?? selector?.textContains ?? '').toLowerCase();
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0)
        return null;
    if (wanted === '') {
        // 没有文案条件时无法可靠换算，交由调用方判定
        return null;
    }
    let best = null;
    for (const item of list) {
        const text = item.text.toLowerCase();
        let score = 0;
        if (text === wanted)
            score = 100;
        else if (text.includes(wanted) || wanted.includes(text))
            score = 60;
        if (score === 0)
            continue;
        if (best === null || score > best.score)
            best = { item, score };
    }
    return best === null ? null : { point: { x: best.item.x, y: best.item.y }, item: best.item, score: best.score };
}

/** 只保留最近 N 张截图，避免长期运行把磁盘填满（审计 P2-10）。 */
async function pruneShots(dir, keep, log) {
    if (!Number.isFinite(keep) || keep <= 0)
        return;
    try {
        const names = (await readdir(dir)).filter(name => name.startsWith('screen-') && name.endsWith('.png'));
        if (names.length <= keep)
            return;
        const items = [];
        for (const name of names) {
            try {
                items.push({ name, mtime: (await stat(join(dir, name))).mtimeMs });
            }
            catch { /* 并发删除，跳过 */ }
        }
        items.sort((a, b) => a.mtime - b.mtime);
        for (const item of items.slice(0, Math.max(0, items.length - keep))) {
            try {
                await unlink(join(dir, item.name));
            }
            catch { /* 忽略单个失败 */ }
        }
    }
    catch (error) {
        log('warn', `清理旧截图失败：${error instanceof Error ? error.message : String(error)}`);
    }
}

export default { capture, runVisionCommand, matchVisionItems };
