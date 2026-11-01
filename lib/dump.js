/**
 * 把扁平节点列表加工成「可直接用于决策」的界面模型：
 * 补标签、算签名、抽可点击目标——这是替代整屏识图的核心产物。
 * @module dsh-quick-adb/dump
 */
import { fnv1a, normalizeText, shortClass, shortId, trunc } from './util.js';
import { parseHierarchy, sliceHierarchy } from './xml.js';

/** 为无文本的可点击容器补上子孙文本（按钮常是「容器 + 内部 TextView」）。 */
function fillLabels(nodes) {
    const children = new Map();
    for (const node of nodes) {
        if (node.parent < 0)
            continue;
        const list = children.get(node.parent);
        if (list === undefined)
            children.set(node.parent, [node.i]);
        else
            list.push(node.i);
    }
    for (const node of nodes) {
        const own = normalizeText(node.text) !== '' ? normalizeText(node.text) : normalizeText(node.desc);
        if (own !== '') {
            node.label = own;
            continue;
        }
        if (!node.clickable && !node.longClickable) {
            node.label = '';
            continue;
        }
        // 广度优先收集子孙文本，最多 4 段 / 40 字；用索引指针而非 shift()（避免 O(n²)）
        const parts = [];
        const queue = [...(children.get(node.i) ?? [])];
        let head = 0;
        let guard = 0;
        while (head < queue.length && parts.length < 4 && guard < 200) {
            guard++;
            const idx = queue[head++];
            const child = nodes[idx];
            const t = normalizeText(child.text) !== '' ? normalizeText(child.text) : normalizeText(child.desc);
            if (t !== '' && !parts.includes(t))
                parts.push(t);
            const grand = children.get(idx);
            if (grand !== undefined)
                queue.push(...grand);
        }
        node.label = trunc(parts.join(' '), 40);
    }
}

/**
 * 解析 dump 文本为界面树。
 * @param {string} xml - 原始 dump 输出（可含状态行）。
 * @returns {object} tree
 */
export function buildTree(xml) {
    const sliced = sliceHierarchy(xml);
    if (sliced === '') {
        const error = new Error('dump 输出中没有 <hierarchy> 节点');
        error.kind = 'dump-empty';
        throw error;
    }
    const { rotation, nodes, truncated } = parseHierarchy(sliced);
    fillLabels(nodes);
    const counts = new Map();
    for (const node of nodes) {
        if (node.pkg !== '')
            counts.set(node.pkg, (counts.get(node.pkg) ?? 0) + 1);
    }
    let pkg = '';
    let best = 0;
    for (const [name, count] of counts) {
        if (count > best) {
            best = count;
            pkg = name;
        }
    }
    const tree = {
        pkg,
        rotation,
        nodes,
        truncated,
        signature: computeSignature(pkg, nodes),
        // 节点级计数（不做去重/启用过滤），仅用于诊断；对外展示统一用 collectTargets 的「目标数」
        clickableNodes: nodes.filter(n => (n.clickable || n.longClickable) && n.visible && !n.offscreen).length,
        texts: nodes.filter(n => n.visible && normalizeText(n.text) !== '').length,
    };
    return tree;
}

/** 界面签名：包名 + 可见文本/可点击项的位置与文案的稳定哈希。 */
export function computeSignature(pkg, nodes) {
    const parts = [];
    for (const node of nodes) {
        if (!node.visible)
            continue;
        const label = normalizeText(node.text) !== '' ? normalizeText(node.text) : normalizeText(node.desc);
        if (label === '' && !node.clickable && !node.longClickable)
            continue;
        parts.push(`${label}|${shortId(node.id)}|${node.bounds.left},${node.bounds.top},${node.bounds.width},${node.bounds.height}`);
        if (parts.length >= 400)
            break;
    }
    return fnv1a(pkg + '#' + parts.join(';'));
}

/**
 * 抽取可点击目标，按阅读顺序（上到下、左到右）排序并去重。
 * @param {object} tree
 * @param {{max?: number}} options
 */
export function collectTargets(tree, { max = 40 } = {}) {
    const seen = new Set();
    const targets = [];
    for (const node of tree.nodes) {
        if (!(node.clickable || node.longClickable))
            continue;
        if (!node.visible || node.offscreen || !node.enabled)
            continue;
        const label = node.label !== '' ? node.label : shortClass(node.cls) || '未命名控件';
        const key = `${label}@${node.cx},${node.cy}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        targets.push({
            label,
            point: { x: node.cx, y: node.cy },
            id: shortId(node.id),
            cls: shortClass(node.cls),
            bounds: node.bounds,
            scrollable: node.scrollable,
            longClickable: node.longClickable,
            i: node.i,
        });
        if (targets.length >= max * 3)
            break;
    }
    targets.sort((a, b) => (a.bounds.top - b.bounds.top) || (a.bounds.left - b.bounds.left));
    return targets.slice(0, max);
}

/** 抽取可见文本（去重，保序）。 */
export function collectTexts(tree, { max = 60 } = {}) {
    const seen = new Set();
    const out = [];
    if (max <= 0)
        return out;
    for (const node of tree.nodes) {
        if (!node.visible || node.offscreen)
            continue;
        const text = normalizeText(node.text);
        if (text === '' || seen.has(text))
            continue;
        seen.add(text);
        out.push(trunc(text, 40));
        if (out.length >= max)
            break;
    }
    return out;
}

/**
 * 渲染成模型可读的紧凑文本：这是「一步」感知的全部输入，通常 300–900 字。
 * @param {object} tree
 * @param {{maxTargets?: number, maxTexts?: number, maxChars?: number, header?: string}} options
 */
export function summarize(tree, { maxTargets = 40, maxTexts = 60, maxChars = 6000, header = '', targets = null } = {}) {
    const list = Array.isArray(targets) ? targets : collectTargets(tree, { max: maxTargets });
    const texts = collectTexts(tree, { max: maxTexts });
    const lines = [];
    lines.push(header !== '' ? header : `# 界面 ${tree.pkg || '?'} 节点=${tree.nodes.length} 目标=${list.length} 签名=${tree.signature}`);
    if (list.length > 0) {
        lines.push('[可点击目标]');
        for (let i = 0; i < list.length; i++) {
            const t = list[i];
            const meta = [t.id !== '' ? `id=${t.id}` : '', t.scrollable ? 'scrollable' : '', t.longClickable ? 'long' : '']
                .filter(Boolean)
                .join(' ');
            lines.push(`${i + 1}. ${trunc(t.label, 28)} @(${t.point.x},${t.point.y})${meta !== '' ? ' ' + meta : ''}`);
        }
    }
    else {
        lines.push('[可点击目标] 无（可能是 WebView/Flutter/游戏等自绘界面，需视觉兜底）');
    }
    if (texts.length > 0)
        lines.push('[可见文本] ' + texts.join(' / '));
    let out = lines.join('\n');
    if (out.length > maxChars)
        out = out.slice(0, maxChars) + '\n…（已截断，用 adb_screen selector=… 精确取）';
    return out;
}

/** 失配时给模型看的候选文本，帮助一次改对选择器而不是盲目重试。 */
export function candidateTexts(tree, selector, { max = 8 } = {}) {
    const needle = normalizeText(selector?.text ?? selector?.textContains ?? '').toLowerCase();
    const scored = [];
    for (const node of tree.nodes) {
        if (!node.visible)
            continue;
        const label = node.label || normalizeText(node.text) || normalizeText(node.desc);
        if (label === '')
            continue;
        let score = 0;
        if (needle !== '' && label.toLowerCase().includes(needle))
            score = 100;
        else if (node.clickable || node.longClickable)
            score = 10;
        if (score > 0)
            scored.push({ label, score, depth: node.depth });
    }
    scored.sort((a, b) => (b.score - a.score) || (a.depth - b.depth));
    const out = [];
    for (const item of scored) {
        if (out.includes(item.label))
            continue;
        out.push(item.label);
        if (out.length >= max)
            break;
    }
    return out;
}

export default { buildTree, summarize, collectTargets, collectTexts, candidateTexts, computeSignature };
