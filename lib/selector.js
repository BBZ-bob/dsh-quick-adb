/**
 * 控件定位器：把「文案 / id / 类名 / 相对位置」翻译成一个可点击坐标。
 *
 * 三个关键设计：
 * 1. 文本可点性提升（lift）：Android 上大量按钮是「可点击容器 + 内部 TextView」，
 *    文本节点自身 clickable=false。直接把文本节点中心当点击点，命中率很高但
 *    在部分 ROM 上会落到非可点区域，所以优先提升到最近的、面积合理的可点击祖先。
 * 2. 评分而非首个命中：同一文案常有多个节点（列表项、隐藏副本），按「精确 >
 *    包含 > 正则」「自身文本 > 子孙聚合标签」「面积小 > 面积大」排序。
 * 3. 未命中时返回候选文案，让模型一次改对，而不是盲目重复感知。
 * @module dsh-quick-adb/selector
 */
import { normalizeText, shortClass, shortId } from './util.js';
import { candidateTexts } from './dump.js';

/** 把简写（字符串）还原成选择器对象。 */
export function normalizeSelector(selector) {
    if (typeof selector === 'string')
        return { text: selector };
    if (selector === null || typeof selector !== 'object')
        return null;
    return { ...selector };
}

function asRegex(value) {
    if (value instanceof RegExp)
        return value;
    const s = String(value ?? '');
    if (s.length >= 2 && s.startsWith('/') && s.endsWith('/'))
        return new RegExp(s.slice(1, -1));
    return new RegExp(s);
}

function idMatches(nodeId, wanted) {
    const target = String(wanted ?? '');
    if (target === '')
        return false;
    if (target.startsWith('/') && target.endsWith('/') && target.length > 2)
        return asRegex(target).test(nodeId);
    if (nodeId === target)
        return 100;
    if (target.includes(':id/') || target.includes('/'))
        return 0;
    // 简写：只写 btn_ok 也能命中 com.foo:id/btn_ok
    return shortId(nodeId) === target ? 90 : 0;
}

/**
 * 单个节点的匹配得分；-Infinity 表示不匹配。
 * 得分同时用于排序，因此数值有语义分层。
 */
function scoreNode(node, selector) {
    let score = 0;
    const text = normalizeText(node.text);
    const desc = normalizeText(node.desc);
    const label = node.label || text || desc;

    if (selector.text !== undefined) {
        const wanted = normalizeText(selector.text);
        if (text !== '' && text.toLowerCase() === wanted.toLowerCase())
            score += 1000;
        else if (label !== '' && label.toLowerCase() === wanted.toLowerCase())
            score += 700;
        else
            return -Infinity;
    }
    if (selector.textContains !== undefined) {
        const wanted = normalizeText(selector.textContains).toLowerCase();
        if (wanted === '')
            return -Infinity;
        if (text.toLowerCase().includes(wanted))
            score += 500;
        else if (label.toLowerCase().includes(wanted))
            score += 350;
        else
            return -Infinity;
    }
    if (selector.textRegex !== undefined) {
        let re;
        try {
            re = asRegex(selector.textRegex);
        }
        catch {
            return -Infinity;
        }
        if (!re.test(label) && !re.test(text))
            return -Infinity;
        score += 400;
    }
    if (selector.id !== undefined) {
        const idScore = idMatches(node.id, selector.id);
        if (idScore === 0)
            return -Infinity;
        score += idScore;
    }
    if (selector.desc !== undefined) {
        const wanted = normalizeText(selector.desc);
        if (desc !== '' && desc.toLowerCase() === wanted.toLowerCase())
            score += 800;
        else if (desc.toLowerCase().includes(wanted.toLowerCase()) && wanted !== '')
            score += 300;
        else
            return -Infinity;
    }
    if (selector.descContains !== undefined) {
        const wanted = normalizeText(selector.descContains).toLowerCase();
        if (wanted === '' || !desc.toLowerCase().includes(wanted))
            return -Infinity;
        score += 300;
    }
    if (selector.cls !== undefined) {
        const wanted = String(selector.cls);
        const full = node.cls;
        const short = shortClass(node.cls);
        if (wanted.startsWith('/') && wanted.endsWith('/')) {
            if (!asRegex(wanted).test(full))
                return -Infinity;
            score += 80;
        }
        else if (full === wanted || short === wanted || full.endsWith('.' + wanted) || short.endsWith(wanted)) {
            score += 80;
        }
        else {
            return -Infinity;
        }
    }
    if (selector.clickable !== undefined) {
        const wantClickable = selector.clickable === true;
        if ((node.clickable || node.longClickable) !== wantClickable)
            return -Infinity;
    }
    // 通用加权
    if (node.clickable || node.longClickable)
        score += 30;
    if (node.focused)
        score += 5;
    score -= node.depth * 0.5;
    score -= (node.bounds.width * node.bounds.height) / 200000;
    return score;
}

/** 收集某节点的全部子孙索引。 */
function descendantSet(tree, rootIndex) {
    const children = new Map();
    for (const node of tree.nodes) {
        if (node.parent < 0)
            continue;
        const list = children.get(node.parent);
        if (list === undefined)
            children.set(node.parent, [node.i]);
        else
            list.push(node.i);
    }
    const out = new Set();
    const queue = [...(children.get(rootIndex) ?? [])];
    while (queue.length > 0) {
        const idx = queue.shift();
        if (out.has(idx))
            continue;
        out.add(idx);
        const next = children.get(idx);
        if (next !== undefined)
            queue.push(...next);
    }
    return out;
}

/**
 * 沿祖先链找「合理的」可点击容器。
 * 屏幕级可点击容器（面积超过界面 70%）会被跳过，避免点到空白。
 */
function liftToClickable(tree, node, screenArea) {
    if (node.clickable || node.longClickable)
        return { node, lifted: false, from: null };
    let cursor = node;
    for (let hop = 0; hop < 8; hop++) {
        if (cursor.parent < 0)
            break;
        const parent = tree.nodes[cursor.parent];
        if (parent === undefined)
            break;
        cursor = parent;
        if (!(parent.clickable || parent.longClickable) || !parent.visible || parent.offscreen)
            continue;
        const area = parent.bounds.width * parent.bounds.height;
        if (screenArea > 0 && area > screenArea * 0.7)
            continue;
        return { node: parent, lifted: true, from: node };
    }
    return { node, lifted: false, from: null };
}

export function describeSelector(selector) {
    if (selector == null)
        return '(空选择器)';
    if (typeof selector === 'string')
        return `text="${selector}"`;
    const parts = [];
    for (const key of ['text', 'textContains', 'textRegex', 'id', 'desc', 'descContains', 'cls', 'index', 'nth']) {
        const value = selector[key];
        if (value !== undefined && value !== '')
            parts.push(`${key}=${String(value)}`);
    }
    return parts.length === 0 ? '(空选择器)' : parts.join(' ');
}

/** 界面总面积（取根节点边界，用于过滤屏幕级容器）。 */
function treeArea(tree) {
    let max = 0;
    for (const node of tree.nodes) {
        const area = node.bounds.width * node.bounds.height;
        if (area > max)
            max = area;
    }
    return max;
}

/**
 * 定位。
 * @param {object} tree - 界面树
 * @param {object|string} selector
 * @param {{includeDisabled?: boolean, noLift?: boolean, within?: object}} options
 * @returns {{ok: boolean, node: object|null, point: {x:number,y:number}|null, lifted: boolean, score: number, matches: number, candidates: string[]}}
 */
export function resolve(tree, selector, options = {}) {
    const sel = normalizeSelector(selector);
    const empty = { ok: false, node: null, point: null, lifted: false, score: 0, matches: 0, candidates: [], reason: null, nth: 0 };
    if (sel === null || tree == null)
        return empty;

    let restrict = null;
    if (options.within !== undefined && options.within !== null) {
        const parent = resolve(tree, options.within, { ...options, within: undefined, noLift: true });
        if (!parent.ok)
            return empty;
        restrict = descendantSet(tree, parent.node.i);
    }

    const pool = [];
    for (const node of tree.nodes) {
        if (restrict !== null && !restrict.has(node.i))
            continue;
        if (!node.visible || node.offscreen)
            continue;
        if (!options.includeDisabled && !node.enabled)
            continue;
        const score = scoreNode(node, sel);
        if (score === -Infinity)
            continue;
        pool.push({ node, score });
    }
    if (pool.length === 0)
        return { ...empty, candidates: candidateTexts(tree, sel) };

    pool.sort((a, b) => (b.score - a.score) || (a.node.i - b.node.i));
    const nthValue = Number(sel.nth ?? sel.index);
    const nth = Number.isFinite(nthValue) ? Math.max(0, Math.trunc(nthValue)) : 0;
    // 越界必须报错：静默取最后一个匹配会点到完全不相干的控件（审计 P1-2）
    if (nth >= pool.length) {
        return { ...empty, matches: pool.length, nth, reason: 'nth-out-of-range', candidates: candidateTexts(tree, sel) };
    }
    const picked = pool[nth];

    let target = picked.node;
    let lifted = false;
    if (!options.noLift) {
        const lift = liftToClickable(tree, picked.node, treeArea(tree));
        target = lift.node;
        lifted = lift.lifted;
    }
    if (selector.near !== undefined && Number.isFinite(pool[0]?.node?.cx)) {
        // near 仅用于同类多命中时挑最近的一个
        const near = selector.near;
        if (Number.isFinite(near?.x) && Number.isFinite(near?.y)) {
            let bestNode = target;
            let bestDist = Number.POSITIVE_INFINITY;
            for (const candidate of pool.slice(0, 10)) {
                const dx = candidate.node.cx - near.x;
                const dy = candidate.node.cy - near.y;
                const dist = dx * dx + dy * dy;
                if (dist < bestDist) {
                    bestDist = dist;
                    bestNode = candidate.node;
                }
            }
            const lift = liftToClickable(tree, bestNode, treeArea(tree));
            target = lift.node;
            lifted = lift.lifted;
        }
    }
    return {
        ok: true,
        node: target,
        point: { x: target.cx, y: target.cy },
        lifted,
        score: picked.score,
        matches: pool.length,
        candidates: [],
    };
}

export default { resolve, normalizeSelector, describeSelector };
