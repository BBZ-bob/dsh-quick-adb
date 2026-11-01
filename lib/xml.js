/**
 * `uiautomator dump` 输出的 XML 解析。
 *
 * 为什么自己写而不是引入 XML 库：dump 的结构极其规整（单一 `<node>` 元素、
 * 属性全部双引号、自闭合或成对闭合），正则栈解析足够且零依赖、解析耗时
 * 在毫秒级，比任何通用解析器都快。
 * @module dsh-quick-adb/xml
 */

const NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    '#39': "'",
};

/** 解码 XML 实体（含十进制/十六进制字符引用）。 */
export function decodeEntities(input) {
    return String(input ?? '').replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (whole, body) => {
        const named = NAMED_ENTITIES[body];
        if (named !== undefined)
            return named;
        if (body.startsWith('#x') || body.startsWith('#X')) {
            const code = Number.parseInt(body.slice(2), 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        if (body.startsWith('#')) {
            const code = Number.parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return whole;
    });
}

/** 只截取 `<hierarchy>…</hierarchy>`，屏蔽 dump 的状态行、warn 噪声。 */
export function sliceHierarchy(raw) {
    const text = String(raw ?? '');
    const start = text.indexOf('<hierarchy');
    if (start === -1)
        return '';
    const end = text.lastIndexOf('</hierarchy>');
    if (end === -1)
        return '';
    return text.slice(start, end + '</hierarchy>'.length).replace(/\r/g, '');
}

const NODE_TAG = /<(\/)?(node|hierarchy)\b([^>]*)>/g;
const ATTR = /([A-Za-z_][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
const BOUNDS = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/;

function parseAttrs(raw) {
    const out = {};
    ATTR.lastIndex = 0;
    let m;
    while ((m = ATTR.exec(raw)) !== null)
        out[m[1]] = decodeEntities(m[2]);
    return out;
}

function parseBounds(value) {
    const m = BOUNDS.exec(String(value ?? ''));
    if (m === null)
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    const left = Number(m[1]);
    const top = Number(m[2]);
    const right = Number(m[3]);
    const bottom = Number(m[4]);
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * 解析 dump XML。
 * @param {string} xml - 已切片的 XML 文本。
 * @returns {{rotation: number, nodes: Array<object>, truncated: boolean}}
 */
export function parseHierarchy(xml) {
    const nodes = [];
    const stack = [];
    let rotation = 0;
    let truncated = false;
    NODE_TAG.lastIndex = 0;
    let match;
    while ((match = NODE_TAG.exec(xml)) !== null) {
        const closing = match[1] === '/';
        const tag = match[2];
        const rawAttrs = match[3] ?? '';
        if (tag === 'hierarchy') {
            if (!closing) {
                const attrs = parseAttrs(rawAttrs);
                const rot = Number(attrs.rotation);
                if (Number.isFinite(rot))
                    rotation = rot;
            }
            continue;
        }
        if (closing) {
            stack.pop();
            continue;
        }
        const attrs = parseAttrs(rawAttrs);
        const bounds = parseBounds(attrs.bounds);
        const parent = stack.length > 0 ? stack[stack.length - 1] : -1;
        const node = {
            i: nodes.length,
            parent,
            depth: stack.length,
            index: Number(attrs.index ?? 0) || 0,
            text: attrs.text ?? '',
            desc: attrs['content-desc'] ?? '',
            id: attrs['resource-id'] ?? '',
            cls: attrs.class ?? '',
            pkg: attrs.package ?? '',
            bounds,
            cx: bounds.left + Math.round(bounds.width / 2),
            cy: bounds.top + Math.round(bounds.height / 2),
            clickable: attrs.clickable === 'true',
            longClickable: attrs['long-clickable'] === 'true',
            scrollable: attrs.scrollable === 'true',
            enabled: attrs.enabled !== 'false',
            focusable: attrs.focusable === 'true',
            focused: attrs.focused === 'true',
            selected: attrs.selected === 'true',
            checked: attrs.checked === 'true',
            password: attrs.password === 'true',
            checkable: attrs.checkable === 'true',
            label: '',
            visible: bounds.width > 0 && bounds.height > 0,
            offscreen: bounds.right <= 0 || bounds.bottom <= 0,
        };
        nodes.push(node);
        const selfClosing = /\/\s*$/.test(rawAttrs);
        if (!selfClosing)
            stack.push(node.i);
        // 防御：异常 dump 可能被截断，节点数设上限避免内存爆炸
        if (nodes.length > 20000) {
            truncated = true;
            break;
        }
    }
    return { rotation, nodes, truncated };
}

export default { parseHierarchy, sliceHierarchy, decodeEntities };
