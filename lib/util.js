/**
 * 小工具集合：无外部依赖，便于在 dsh 宿主内联运行。
 * @module dsh-quick-adb/util
 */

/** 毫秒级睡眠（本地，不占 ADB 往返）。 */
export function sleep(ms) {
    if (!Number.isFinite(ms) || ms <= 0)
        return Promise.resolve();
    return new Promise(done => setTimeout(done, ms));
}

/** 当前毫秒时间戳，单调用于计时。 */
export function now() {
    return Date.now();
}

/** 截断字符串，超出补省略号。 */
export function trunc(text, max) {
    const s = String(text ?? '');
    if (s.length <= max)
        return s;
    return s.slice(0, Math.max(1, max - 1)) + '…';
}

/** 归一化界面文本：折叠空白、去首尾空白。 */
export function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** FNV-1a 32 位哈希，用于界面签名（稳定、无需依赖）。 */
export function fnv1a(input) {
    let hash = 0x811c9dc5;
    const s = String(input ?? '');
    for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 把类名压成短名：android.widget.Button -> Button。 */
export function shortClass(cls) {
    const s = String(cls ?? '');
    if (s === '')
        return '';
    const tail = s.slice(s.lastIndexOf('.') + 1);
    return tail === '' ? s : tail;
}

/** 把 resource-id 压短：com.foo:id/btn_ok -> btn_ok。 */
export function shortId(id) {
    const s = String(id ?? '');
    if (s === '')
        return '';
    const slash = s.lastIndexOf('/');
    return slash === -1 ? s : s.slice(slash + 1);
}

/** 设备序列号/路径安全化，用于远程文件名。 */
export function safeToken(value, fallback = 'default') {
    const s = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
    return s === '' ? fallback : s;
}

/** 秒级字面量：250 -> '0.25'，供设备端 sleep 使用。 */
export function secondsLiteral(ms) {
    const v = Math.max(0, Number(ms) || 0) / 1000;
    return v.toFixed(2);
}

/** 单引号安全转义，供 device 端 sh -c 解析。 */
export function shQuote(value) {
    return "'" + String(value ?? '').replace(/'/g, "'\\''") + "'";
}

/** 数值收敛到区间。 */
export function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return min;
    return Math.min(max, Math.max(min, n));
}

/**
 * 顺序互斥队列：ADB 动作必须串行，避免两次 tap 交错污染缓存。
 * @returns {(fn: () => Promise<any>) => Promise<any>} 包装器
 */
export function createLock() {
    let tail = Promise.resolve();
    return function locked(fn) {
        const run = tail.then(fn, fn);
        // 吞掉异常，仅用于排队；异常由调用方自己的 run 抛出
        tail = run.then(() => undefined, () => undefined);
        return run;
    };
}

/** 终端显示宽度（中日韩字符按 2 计），用于表格对齐。 */
export function displayWidth(text) {
    let width = 0;
    for (const char of String(text ?? '')) {
        const code = char.codePointAt(0) ?? 0;
        const wide = (code >= 0x1100 && code <= 0x115F)
            || (code >= 0x2E80 && code <= 0xA4CF)
            || (code >= 0xAC00 && code <= 0xD7A3)
            || (code >= 0xF900 && code <= 0xFAFF)
            || (code >= 0xFE30 && code <= 0xFE6F)
            || (code >= 0xFF00 && code <= 0xFF60)
            || (code >= 0xFFE0 && code <= 0xFFE6);
        width += wide ? 2 : 1;
    }
    return width;
}

/** 按显示宽度左对齐补齐。 */
export function padDisplay(text, width) {
    const s = String(text ?? '');
    const pad = width - displayWidth(s);
    return pad > 0 ? s + ' '.repeat(pad) : s;
}
