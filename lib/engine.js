/**
 * 引擎：把「感知 → 定位 → 动作 → 再感知」编排成一条最短路径。
 *
 * 与 v0.1 的差别（审计整改）：
 *   - 感知下沉到 `perceive.js`，动作收尾统一走 `actions.js#runAction`，
 *     批量在 `batch.js`；本文件只做编排、校验与兜底阶梯。
 *   - `adb_app` 的包名/Activity 先做白名单校验再拼命令（P0-1）。
 *   - `adb_shell` 的开关抽成 `assertShellAllowed()`，供 batch 复用（P0-2）。
 *   - `wait` 增加预算保护，超时不再被一次整树解析拖长（P2-2）。
 * @module dsh-quick-adb/engine
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { keyCommands, runAction, settleMs, tapCommand } from './actions.js';
import { runBatch } from './batch.js';
import { candidateTexts, collectTargets, summarize } from './dump.js';
import { ActionError } from './errors.js';
import { Perception } from './perceive.js';
import { describeSelector, resolve as resolveSelector } from './selector.js';
import { capture, matchVisionItems, runVisionCommand } from './vision.js';
import { clamp, createLock, secondsLiteral, shQuote, sleep, trunc } from './util.js';

export { ActionError };

const KEYCODES = {
    back: 4,
    home: 3,
    enter: 66,
    delete: 67,
    tab: 61,
    menu: 82,
    power: 26,
    recents: 187,
    escape: 111,
    up: 19,
    down: 20,
    left: 21,
    right: 22,
    'move-end': 123,
    'volume-up': 24,
    'volume-down': 25,
};

/** 包名白名单：至少两段，只允许字母数字下划线与点。 */
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
/** Activity 名：允许 `$` 用于内部类。 */
const ACTIVITY_PATTERN = /^[A-Za-z0-9_.$]+$/;

/** 文本注入的告警文案。 */
function noteFor(ascii, hasPercent) {
    const notes = [];
    if (!ascii)
        notes.push('非 ASCII 文本：多数设备 input text 只接受 ASCII，中文会丢失；装 ADBKeyboard 后设 inputMode=adbkeyboard-b64');
    if (hasPercent)
        notes.push('文本含 %：input text 会把 %s 当空格，字面 %s 无法表达；需精确输入请用 ADBKeyboard（base64）');
    return notes.join('；');
}

/** dsh 数据目录。 */
export function dshHome() {
    const fromEnv = process.env.DSH_HOME ?? '';
    if (fromEnv !== '')
        return fromEnv;
    return join(homedir() || '/tmp', '.dsh');
}

export class AndroidEngine {
    constructor({ config, adb, timing, cache, log = () => {} }) {
        this.config = config;
        this.adb = adb;
        this.timing = timing;
        this.cache = cache;
        this.log = log;
        this.serial = config.serial ?? '';
        this.screenSizeCache = null;
        this.lock = createLock();
        this.perception = new Perception({
            config,
            adb,
            cache,
            timing,
            log,
            serialOf: () => this.serial,
            ensureSerial: () => this.device(),
        });
    }

    get caps() {
        return this.perception.caps;
    }

    // ---------------------------------------------------------------- 设备

    async device() {
        if (this.serial !== '') {
            if (this.adb.serial !== this.serial)
                this.adb.serial = this.serial;
            return this.serial;
        }
        const serial = await this.adb.ensureSerial();
        this.serial = serial;
        this.adb.serial = serial;
        return serial;
    }

    async screenSize() {
        if (this.screenSizeCache !== null)
            return this.screenSizeCache;
        let size = { width: 1080, height: 2400, source: 'fallback' };
        try {
            const result = await this.adb.shell('wm size', { timeoutMs: 6000, op: 'wm-size' });
            const text = String(result.stdout ?? '');
            const override = /Override size:\s*(\d+)x(\d+)/.exec(text);
            const physical = /Physical size:\s*(\d+)x(\d+)/.exec(text);
            const matched = override ?? physical;
            if (matched !== null)
                size = { width: Number(matched[1]), height: Number(matched[2]), source: override !== null ? 'override' : 'physical' };
        }
        catch (error) {
            this.log('warn', `读取屏幕尺寸失败，使用默认值：${error instanceof Error ? error.message : String(error)}`);
        }
        this.screenSizeCache = size;
        return size;
    }

    // ---------------------------------------------------------------- 校验

    assertPackage(pkg) {
        if (!PACKAGE_PATTERN.test(pkg))
            throw new ActionError(`非法包名：${trunc(pkg, 60)}。包名只允许字母、数字、下划线、点，且至少两段（如 com.example.app）`, { kind: 'bad-args' });
    }

    assertActivity(activity) {
        if (!ACTIVITY_PATTERN.test(activity))
            throw new ActionError(`非法 Activity 名：${trunc(activity, 60)}。只允许字母、数字、下划线、点和 $`, { kind: 'bad-args' });
    }

    /**
     * 动作计划：settle 只管等待时长；confirm 独立决定「要不要事后重新解析」。
     * P3d 实测：显式 settle=fast 的调用方不应被迫多付一遍确认 dump（慢设备 ~2.7s）。
     * confirm='auto' 表示在定位之后按本机 dump 成本决定——那时才知道这台设备贵不贵。
     */
    actionPlan(args) {
        if (args.perceive === false)
            return { wait: 'none', confirm: false, auto: false, explicitWait: false };
        const explicitWait = args.settle !== undefined && args.settle !== null;
        const wait = explicitWait ? args.settle : undefined;
        if (args.confirm === true || args.confirm === false)
            return { wait, confirm: args.confirm, auto: false, explicitWait };
        return { wait, confirm: 'auto', auto: true, explicitWait };
    }

    /**
     * 把计划落成实际参数。
     * 关键：auto 判定「不做确认」时，如果调用方也没显式要求等待，就一并省掉那段 sleep——
     * 否则纯动作会比基线多睡 250ms（P3e 实测 home 197→234、back 162→296）。
     */
    materializePlan(plan) {
        const confirm = this.resolveConfirm(plan);
        const wait = (!confirm && !plan.explicitWait) ? 'none' : plan.wait;
        return { confirm, wait };
    }

    /** 把 confirm='auto' 落成布尔：本机 dump 贵就不做确认。 */
    resolveConfirm(plan) {
        if (plan.confirm !== 'auto')
            return plan.confirm;
        return !this.perception.slowDumpDevice();
    }

    /** 唯一的 shell 开关出口，batch 与 adb_shell 共用。 */
    assertShellAllowed() {
        if (!this.config.allowShell)
            throw new ActionError('adb_shell 已被配置禁用（allowShell=false）。批量里的 {"shell":...} 步骤同样被禁用', { kind: 'forbidden' });
    }

    // ---------------------------------------------------------------- 定位

    async locate(selector, { force = false } = {}) {
        const first = await this.perception.perceive({ reason: 'locate', force });
        let loc = resolveSelector(first.tree, selector);
        if (loc.ok)
            return { loc, tree: first.tree, percept: first, retried: false };
        const second = await this.perception.perceive({ reason: 'locate.miss', force: true });
        loc = resolveSelector(second.tree, selector);
        return { loc, tree: second.tree, percept: second, retried: true };
    }

    /** 定位失败的错误文案：带候选与具体原因，避免模型反复试探。 */
    notFoundError(selector, tree, extra = '', loc = null) {
        const safeTree = tree ?? { pkg: '', signature: '-', nodes: [], clickableNodes: 0 };
        const candidates = Array.isArray(loc?.candidates) && loc.candidates.length > 0
            ? loc.candidates
            : (tree === null || tree === undefined ? [] : candidateTexts(tree, selector, { max: 8 }));
        const lines = [`未找到控件：${describeSelector(selector)}`];
        if (loc?.reason === 'nth-out-of-range')
            lines.push(`nth=${loc.nth} 超出匹配数 ${loc.matches}（nth 从 0 开始，删掉 nth 取第一个）`);
        lines.push(tree === null || tree === undefined
            ? '当前界面无法解析控件树（已尝试视觉兜底）'
            : `当前界面 ${safeTree.pkg || '?'}（签名 ${safeTree.signature}，节点 ${safeTree.nodes.length}，可点击节点 ${safeTree.clickableNodes ?? 0}）`);
        lines.push(candidates.length > 0 ? `候选文案：${candidates.join(' / ')}` : '界面几乎没有可用文案（可能是自绘/WebView）');
        if (extra !== '')
            lines.push(extra);
        return new ActionError(lines.join('；'), { kind: 'not-found', detail: { selector, signature: tree.signature, candidates, reason: loc?.reason ?? null } });
    }

    async visionLocate(selector, { reason = 'vision' } = {}) {
        const serial = await this.device();
        this.cache.note('vision', serial);
        const shotDir = this.config.screenshotDir !== '' ? this.config.screenshotDir : join(dshHome(), 'quick-adb', 'shots');
        mkdirSync(shotDir, { recursive: true });
        const shot = await capture(this.adb, {
            dir: shotDir,
            serial,
            timeoutMs: this.config.actionTimeoutMs,
            maxShots: this.config.maxShots,
            log: this.log,
        });
        this.timing.record({ op: 'screencap', kind: 'internal', wallMs: shot.ms, adbCalls: 1, source: 'vision', serial, extra: { reason } });
        if (this.config.visionCommand === '')
            return { ok: false, mode: 'screenshot-only', shot, error: '未配置 visionCommand，只产出截图' };
        const result = await runVisionCommand({
            command: this.config.visionCommand,
            shotPath: shot.path,
            serial,
            query: describeSelector(selector),
            timeoutMs: this.config.visionTimeoutMs,
            log: this.log,
        });
        const matched = result.ok ? matchVisionItems(result.items, selector) : null;
        if (matched === null)
            return { ok: false, mode: 'command', shot, error: result.error !== '' ? result.error : '视觉结果中没有匹配文案', items: result.items?.length ?? 0 };
        return { ok: true, mode: 'command', point: matched.point, shot, item: matched.item };
    }

    /** 定位 + 兜底：树命中 → 视觉命中 → 抛错。 */
    async resolveWithFallback(selector, { allowVision = true } = {}) {
        let located;
        try {
            located = await this.locate(selector);
        }
        catch (error) {
            // 控件树不可用（视频/自绘/卡死）：直接降到视觉，别把错误抛给模型
            if (!allowVision || !this.config.visionFallback)
                throw error;
            const reason = error instanceof Error ? error.message : String(error);
            const vision = await this.visionLocate(selector);
            if (vision.ok)
                return { point: vision.point, node: null, mode: 'vision', lifted: false, tree: null, percept: null, vision, dumpError: trunc(reason, 160) };
            const detail = vision.mode === 'screenshot-only'
                ? `已截图兜底：${vision.shot.path}（配置 visionCommand 可自动换算坐标）`
                : `视觉兜底也失败：${vision.error}`;
            throw new ActionError(`${trunc(reason, 200)}；${detail}`, { kind: 'dump-failed' });
        }
        if (located.loc.ok)
            return { point: located.loc.point, node: located.loc.node, mode: 'tree', lifted: located.loc.lifted, tree: located.tree, percept: located.percept, vision: null };
        if (!allowVision || !this.config.visionFallback)
            throw this.notFoundError(selector, located.tree, allowVision ? '' : '（本次调用禁用了视觉兜底）', located.loc);
        const vision = await this.visionLocate(selector);
        if (vision.ok)
            return { point: vision.point, node: null, mode: 'vision', lifted: false, tree: located.tree, percept: located.percept, vision };
        const extra = vision.mode === 'screenshot-only'
            ? `已截图兜底：${vision.shot.path}（配置 visionCommand 可自动换算坐标）`
            : `视觉兜底也失败：${vision.error}`;
        throw this.notFoundError(selector, located.tree, extra, located.loc);
    }

    // ---------------------------------------------------------------- 计时

    async meter(op, fn) {
        const before = this.adb.calls;
        const started = Date.now();
        try {
            const value = await fn();
            this.timing.record({ op, kind: 'op', wallMs: Date.now() - started, adbCalls: this.adb.calls - before, source: value?.source ?? value?.settle ?? '', serial: this.serial });
            return value;
        }
        catch (error) {
            this.timing.record({ op, kind: 'op', wallMs: Date.now() - started, adbCalls: this.adb.calls - before, ok: false, serial: this.serial, extra: { error: trunc(error instanceof Error ? error.message : String(error), 160) } });
            throw error;
        }
    }

    /** 动作结果里附带的界面摘要（可用 includeScreenInAction 关闭）。 */
    screenResult(tree) {
        if (!this.config.includeScreenInAction || tree === null || tree === undefined)
            return null;
        return {
            pkg: tree.pkg,
            signature: tree.signature,
            nodes: tree.nodes.length,
            text: summarize(tree, { maxTargets: 15, maxTexts: 20, maxChars: 1600 }),
        };
    }

    // ---------------------------------------------------------------- 公开动作

    async screen(args = {}) {
        return this.lock(() => this.meter('screen', async () => {
            if (args.invalidate === true) {
                const serial = await this.device();
                this.cache.invalidate(serial, 'manual', { keepTree: false });
            }
            let percept;
            try {
                percept = await this.perception.perceive({ reason: 'screen', force: args.invalidate === true || args.force === true });
            }
            catch (error) {
                if (!this.config.visionFallback)
                    throw error;
                const serial = await this.device();
                const vision = await this.visionLocate(args.selector ?? { text: '' });
                const shotPath = vision.shot?.path ?? '';
                return {
                    source: 'vision',
                    ageMs: 0,
                    pkg: '',
                    signature: '-',
                    nodes: 0,
                    targetCount: 0,
                    find: null,
                    screenshot: shotPath,
                    text: `# 界面无法解析控件树\n原因：${trunc(error instanceof Error ? error.message : String(error), 200)}\n截图：${shotPath}\n下一步：用 adb_tap 带 selector 让它走视觉兜底；或配置 skipDumpPatterns 把该应用加入名单。\n设备：${serial}`,
                };
            }
            const tree = percept.tree;
            const maxTargets = clamp(args.maxTargets ?? 40, 5, 120);
            const targets = collectTargets(tree, { max: maxTargets });
            const header = `# 界面 ${tree.pkg || '?'} 节点=${tree.nodes.length} 目标=${targets.length} 来源=${percept.source}${percept.ageMs > 0 ? `(age=${percept.ageMs}ms)` : ''} 签名=${tree.signature}`;
            const text = summarize(tree, {
                maxTargets,
                maxTexts: clamp(args.maxTexts ?? 60, 0, 200),
                maxChars: clamp(args.maxChars ?? 6000, 600, 20000),
                header,
                targets,
            });
            let find = null;
            if (args.selector !== undefined && args.selector !== null && args.selector !== '') {
                const loc = resolveSelector(tree, args.selector);
                find = loc.ok
                    ? { ok: true, point: loc.point, label: loc.node?.label ?? '', id: loc.node?.id ?? '', matches: loc.matches, lifted: loc.lifted }
                    : { ok: false, candidates: loc.candidates, reason: loc.reason ?? null, matches: loc.matches ?? 0 };
            }
            return {
                source: percept.source,
                ageMs: percept.ageMs,
                pkg: tree.pkg,
                signature: tree.signature,
                nodes: tree.nodes.length,
                targetCount: targets.length,
                text,
                find,
            };
        }));
    }

    async tap(args = {}) {
        return this.lock(() => this.meter('tap', async () => {
            const serial = await this.device();
            const long = args.long === true;
            const plan = this.actionPlan(args);
            const nx = Number(args.x);
            const ny = Number(args.y);
            let point;
            let mode = 'point';
            let note = '';
            let locateInfo = null;
            if (Number.isFinite(nx) && Number.isFinite(ny)) {
                point = { x: Math.round(nx), y: Math.round(ny) };
            }
            else {
                if (args.selector === undefined || args.selector === null)
                    throw new ActionError('adb_tap 需要 selector 或数字坐标 (x, y)。若已拿到坐标，请传数字：{"x":540,"y":1200}', { kind: 'bad-args' });
                try {
                    locateInfo = await this.resolveWithFallback(args.selector, { allowVision: args.allowVision !== false });
                }
                catch (error) {
                    // 定位彻底失败也不抛错：返回 ok:false，让调用方的脚本继续跑（P3b：抛错崩过整轮）
                    return {
                        ok: false,
                        error: trunc(error instanceof Error ? error.message : String(error), 300),
                        note: '未执行点击：控件树与视觉均未能定位',
                    };
                }
                point = locateInfo.point;
                mode = locateInfo.mode;
                if (mode === 'vision')
                    note = `控件树定位失败，已回退视觉（confidence=medium，截图 ${locateInfo.vision?.shot?.path ?? ''}）`;
            }
            const outcome = await runAction({
                perception: this.perception,
                adb: this.adb,
                cache: this.cache,
                config: this.config,
                serial,
                op: 'tap',
                commands: [tapCommand(point, { long, longMs: args.longMs })],
                settle: this.materializePlan(plan).wait,
                confirm: this.materializePlan(plan).confirm,
                reason: 'tap',
            });
            const out = {
                ok: true,
                point,
                mode,
                settle: outcome.settle,
                note,
                locate: locateInfo?.node !== null && locateInfo?.node !== undefined
                    ? { label: locateInfo.node.label, id: locateInfo.node.id, lifted: locateInfo.lifted }
                    : null,
            };
            if (plan.auto && !this.resolveConfirm(plan)) {
                out.autoSettle = 'single-dump';
                out.note = [note, `设备 dump 较慢（约 ${Math.round(this.perception.dumpCostMs)}ms），已自动跳过确认 dump${plan.explicitWait ? '（保留你指定的等待）' : '与多余等待'}；需要看界面时再调 adb_screen`].filter(Boolean).join('；');
            }
            if (outcome.settle === 'failed')
                out.note = [note, '点击已生效但界面重建失败，下一步会自动重新解析'].filter(Boolean).join('；');
            if (outcome.tree !== null)
                out.screen = this.screenResult(outcome.tree);
            return out;
        }));
    }

    async swipe(args = {}) {
        return this.lock(() => this.meter('swipe', async () => {
            const serial = await this.device();
            const durationMs = Math.round(Number(args.durationMs) || 300);
            const direction = args.direction ?? 'up';
            let from;
            let to;
            let note = '';
            if (args.selector !== undefined && args.selector !== null) {
                // 与 tap 保持一致：定位失败会走视觉兜底（审计 P3-10）
                const located = await this.resolveWithFallback(args.selector, { allowVision: args.allowVision !== false });
                if (located.mode === 'vision') {
                    note = '控件区域内滑动退化为以视觉命中点为中心的滑动';
                    const size = await this.screenSize();
                    const travel = Math.round(size.height * 0.15);
                    from = { x: located.point.x, y: located.point.y + travel };
                    to = { x: located.point.x, y: located.point.y - travel };
                }
                else {
                    const box = located.node.bounds;
                    const inset = Math.round(Math.min(box.width, box.height) * 0.2);
                    const vertical = direction === 'up' || direction === 'down';
                    if (vertical) {
                        from = { x: located.point.x, y: direction === 'up' ? box.bottom - inset : box.top + inset };
                        to = { x: located.point.x, y: direction === 'up' ? box.top + inset : box.bottom - inset };
                    }
                    else {
                        from = { x: direction === 'left' ? box.right - inset : box.left + inset, y: located.point.y };
                        to = { x: direction === 'left' ? box.left + inset : box.right - inset, y: located.point.y };
                    }
                }
            }
            else if (args.from !== undefined && args.to !== undefined) {
                from = { x: Math.round(Number(args.from.x)), y: Math.round(Number(args.from.y)) };
                to = { x: Math.round(Number(args.to.x)), y: Math.round(Number(args.to.y)) };
            }
            else {
                const size = await this.screenSize();
                const scale = clamp(args.scale ?? 0.6, 0.1, 1);
                const cx = Math.round(size.width / 2);
                const cy = Math.round(size.height / 2);
                const verticalTravel = Math.round(size.height * scale / 2);
                const horizontalTravel = Math.round(size.width * scale / 2);
                if (direction === 'up') {
                    from = { x: cx, y: cy + verticalTravel };
                    to = { x: cx, y: cy - verticalTravel };
                }
                else if (direction === 'down') {
                    from = { x: cx, y: cy - verticalTravel };
                    to = { x: cx, y: cy + verticalTravel };
                }
                else if (direction === 'left') {
                    from = { x: cx + horizontalTravel, y: cy };
                    to = { x: cx - horizontalTravel, y: cy };
                }
                else {
                    from = { x: cx - horizontalTravel, y: cy };
                    to = { x: cx + horizontalTravel, y: cy };
                }
            }
            if (!Number.isFinite(from.x) || !Number.isFinite(from.y) || !Number.isFinite(to.x) || !Number.isFinite(to.y))
                throw new ActionError('adb_swipe 的 from/to 必须是数字坐标 {x, y}', { kind: 'bad-args' });
            const outcome = await runAction({
                perception: this.perception,
                adb: this.adb,
                cache: this.cache,
                config: this.config,
                serial,
                op: 'swipe',
                commands: [`input swipe ${from.x} ${from.y} ${to.x} ${to.y} ${durationMs}`],
                settle: this.materializePlan(this.actionPlan(args)).wait,
                confirm: this.materializePlan(this.actionPlan(args)).confirm,
                reason: 'swipe',
            });
            const out = { ok: true, from, to, durationMs, settle: outcome.settle, note };
            if (outcome.tree !== null)
                out.screen = this.screenResult(outcome.tree);
            return out;
        }));
    }

    async input(args = {}) {
        return this.lock(() => this.meter('input', async () => {
            const serial = await this.device();
            const text = String(args.text ?? '');
            if (text === '' && args.clear !== true)
                throw new ActionError('adb_input 需要 text（或 clear:true 清空）', { kind: 'bad-args' });
            const commands = [];
            let note = '';
            if (args.selector !== undefined && args.selector !== null) {
                const located = await this.resolveWithFallback(args.selector, { allowVision: args.allowVision !== false });
                commands.push(`input tap ${located.point.x} ${located.point.y}`);
                commands.push(`sleep ${secondsLiteral(this.config.inputFocusDelayMs)}`);
            }
            if (args.clear === true) {
                commands.push('input keyevent 123');
                commands.push(`input keyevent ${Array.from({ length: 40 }, () => 67).join(' ')}`);
                commands.push('sleep 0.1');
            }
            if (text !== '') {
                const injected = this.textCommand(text);
                commands.push(injected.command);
                if (injected.note !== '')
                    note = injected.note;
            }
            if (args.submit === true)
                commands.push('input keyevent 66');
            const outcome = await runAction({
                perception: this.perception,
                adb: this.adb,
                cache: this.cache,
                config: this.config,
                serial,
                op: 'input',
                commands,
                settle: this.materializePlan(this.actionPlan(args)).wait,
                confirm: this.materializePlan(this.actionPlan(args)).confirm,
                reason: 'input',
            });
            const out = { ok: true, chars: text.length, settle: outcome.settle, note };
            if (outcome.tree !== null)
                out.screen = this.screenResult(outcome.tree);
            return out;
        }));
    }

    /**
     * 文本注入命令。
     *
     * `input text` 用 `%s` 表示空格，设备侧会对整串做一次字面替换，因此字面
     * `%s` 无法表达、含 `%` 的文本有歧义（审计 P2-1）。这里不再假装成功：
     * 能走 ADBKeyboard 就走 base64，走不了就在 note 里明确告警。
     */
    textCommand(text) {
        const ascii = /^[\x20-\x7E]*$/.test(text);
        const mode = this.config.inputMode;
        const hasPercent = text.includes('%');
        const base64 = () => `am broadcast -a ADB_INPUT_B64 --es msg ${shQuote(Buffer.from(text, 'utf8').toString('base64'))}`;
        const plain = () => `input text ${shQuote(text.replace(/ /g, '%s'))}`;
        if (mode === 'adbkeyboard' || mode === 'adbkeyboard-b64')
            return { command: base64(), note: '' };
        if (mode === 'input')
            return { command: plain(), note: noteFor(ascii, hasPercent) };
        if (this.config.adbKeyboardInstalled)
            return { command: base64(), note: '' };
        return { command: plain(), note: noteFor(ascii, hasPercent) };
    }

    async key(args = {}) {
        return this.lock(() => this.meter('key', async () => {
            const serial = await this.device();
            const name = String(args.key ?? 'back');
            const named = KEYCODES[name] ?? KEYCODES[name.toLowerCase()];
            const code = named ?? (/^\d+$/.test(name) ? Number(name) : undefined);
            if (code === undefined)
                throw new ActionError(`未知按键 ${name}，可用：${Object.keys(KEYCODES).join(' / ')} 或直接给 keycode 数字`, { kind: 'bad-args' });
            const times = clamp(args.times ?? 1, 1, 20);
            const outcome = await runAction({
                perception: this.perception,
                adb: this.adb,
                cache: this.cache,
                config: this.config,
                serial,
                op: 'key',
                commands: keyCommands(code, times, this.config.keyDelayMs),
                settle: this.materializePlan(this.actionPlan(args)).wait,
                confirm: this.materializePlan(this.actionPlan(args)).confirm,
                reason: 'key',
            });
            const out = { ok: true, key: name, code, times, settle: outcome.settle };
            if (outcome.tree !== null)
                out.screen = this.screenResult(outcome.tree);
            return out;
        }));
    }

    /**
     * 等元素出现/消失/界面稳定。
     *
     * 先用 ~110ms 的焦点探测判断「界面是否真的换了」，再 dump 确认；
     * 并给截止时间留出解析预算，避免超时后又被一次 600ms 的 dump 拖长（P2-2）。
     */
    async wait(args = {}) {
        return this.lock(() => this.meter('wait', async () => {
            await this.device();
            const until = args.until ?? 'appear';
            const timeoutMs = clamp(args.timeoutMs ?? this.config.waitTimeoutMs, 100, 120000);
            const intervalMs = clamp(args.intervalMs ?? 250, 50, 5000);
            const stableMs = clamp(args.stableMs ?? 300, 0, 10000);
            const deadline = Date.now() + timeoutMs;
            const started = Date.now();
            const budget = Math.min(this.config.dumpTimeoutMs * 0.6, 400);
            let attempts = 0;
            let baseProbe = null;
            let lastTree = null;
            let lastSignature = '';
            let stableSince = 0;
            while (Date.now() < deadline) {
                if (attempts > 0 && deadline - Date.now() < budget)
                    break;
                if (attempts > 0 && this.config.waitProbeFirst && baseProbe?.ok === true && until !== 'idle') {
                    const probe = await this.perception.probe();
                    const unchanged = probe.ok && probe.pkg === baseProbe.pkg && probe.activity === baseProbe.activity;
                    if (unchanged && Date.now() - started < this.config.probeFirstMaxMs) {
                        await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
                        continue;
                    }
                }
                attempts++;
                const percept = await this.perception.perceive({ reason: 'wait', force: attempts > 1 });
                lastTree = percept.tree;
                let satisfied = false;
                if (until === 'idle') {
                    if (lastSignature === percept.tree.signature) {
                        if (stableSince === 0)
                            stableSince = Date.now();
                        satisfied = Date.now() - stableSince >= Math.max(intervalMs, stableMs);
                    }
                    else {
                        lastSignature = percept.tree.signature;
                        stableSince = 0;
                    }
                }
                else {
                    if (args.selector === undefined || args.selector === null)
                        throw new ActionError('adb_wait 的 until=appear/disappear 需要 selector', { kind: 'bad-args' });
                    const loc = resolveSelector(lastTree, args.selector);
                    satisfied = until === 'disappear' ? !loc.ok : loc.ok;
                    if (satisfied) {
                        return {
                            ok: true,
                            until,
                            waitedMs: Date.now() - started,
                            attempts,
                            source: percept.source,
                            point: loc.ok ? loc.point : null,
                            screen: this.screenResult(lastTree),
                        };
                    }
                }
                if (satisfied) {
                    return {
                        ok: true,
                        until,
                        waitedMs: Date.now() - started,
                        attempts,
                        source: percept.source,
                        screen: this.screenResult(percept.tree),
                    };
                }
                if (baseProbe === null) {
                    const probe = await this.perception.probe();
                    if (probe.ok)
                        baseProbe = probe;
                }
                await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
            }
            const tail = lastTree !== null
                ? `最后界面 ${lastTree.pkg}（签名 ${lastTree.signature}）：\n${summarize(lastTree, { maxTargets: 18, maxTexts: 25, maxChars: 1400 })}`
                : '未取到界面';
            // 不抛错：抛错会打断调用方的整条脚本（P3b 现场崩过两次）
            return {
                ok: false,
                timedOut: true,
                until,
                waitedMs: Date.now() - started,
                attempts,
                source: lastTree === null ? 'none' : 'wait',
                point: null,
                note: `等待超时（${timeoutMs}ms，${attempts} 次探测）`,
                screen: this.screenResult(lastTree),
                text: tail,
            };
        }));
    }

    async batch(args = {}) {
        return this.lock(() => this.meter('batch', async () => {
            await this.device();
            return runBatch(this, args);
        }));
    }

    async app(args = {}) {
        return this.lock(() => this.meter('app', async () => {
            const serial = await this.device();
            const action = String(args.action ?? 'start');
            if (action === 'current') {
                const probe = await this.perception.probe();
                return { ok: probe.ok, action, pkg: probe.pkg, activity: probe.activity };
            }
            if (action === 'status')
                return await this.status();
            const pkg = String(args.package ?? '');
            const activity = args.activity === undefined || args.activity === null ? '' : String(args.activity);
            if (pkg === '')
                throw new ActionError('adb_app 需要 package（除 action=current/status 外）', { kind: 'bad-args' });
            this.assertPackage(pkg);
            if (activity !== '')
                this.assertActivity(activity);
            const launch = activity !== ''
                ? `am start -W -n ${shQuote(pkg)}/${shQuote(activity)}`
                : `monkey -p ${shQuote(pkg)} -c android.intent.category.LAUNCHER 1`;
            const commands = [];
            if (action === 'start')
                commands.push(launch);
            else if (action === 'stop')
                commands.push(`am force-stop ${shQuote(pkg)}`);
            else if (action === 'restart')
                commands.push(`am force-stop ${shQuote(pkg)}`, 'sleep 0.8', launch);
            else if (action === 'clear')
                commands.push(`pm clear ${shQuote(pkg)}`);
            else
                throw new ActionError('adb_app action 取值：start / stop / restart / clear / current / status', { kind: 'bad-args' });
            const outcome = await runAction({
                perception: this.perception,
                adb: this.adb,
                cache: this.cache,
                config: this.config,
                serial,
                op: 'app',
                commands,
                settle: args.settle ?? this.config.appSettle,
                confirm: args.confirm === undefined ? !this.perception.slowDumpDevice() : args.confirm,
                reason: 'app',
            });
            const out = { ok: true, action, pkg, settle: outcome.settle };
            if (outcome.tree !== null)
                out.screen = this.screenResult(outcome.tree);
            return out;
        }));
    }

    async shell(args = {}) {
        return this.lock(() => this.meter('shell', async () => {
            const serial = await this.device();
            this.assertShellAllowed();
            const command = String(args.command ?? '');
            if (command === '')
                throw new ActionError('adb_shell 需要 command', { kind: 'bad-args' });
            // 命令可能有副作用，无论成败都先作废缓存
            this.cache.invalidate(serial, 'shell');
            const timeoutMs = clamp(args.timeoutMs ?? this.config.actionTimeoutMs, 1000, 300000);
            const result = await this.adb.shell(command, { timeoutMs, op: 'shell' });
            const stdout = String(result.stdout ?? '');
            return {
                ok: result.code === 0,
                code: result.code,
                stdout: trunc(stdout, this.config.maxOutputChars),
                truncated: stdout.length > this.config.maxOutputChars,
                stderr: trunc(result.stderr, 800),
            };
        }));
    }

    /** 设备与缓存状态（排障用，adb_app action=status 暴露）。 */
    async status() {
        const serial = await this.device().catch(() => this.serial);
        const screen = await this.screenSize().catch(() => null);
        return {
            ok: true,
            action: 'status',
            serial,
            screen,
            caps: { ...this.perception.caps },
            adbCalls: this.adb.calls,
            cache: this.cache.snapshot(),
        };
    }

    /** 供 batch 使用的内部能力（不加锁、不单独计时）。 */
    internals() {
        return {
            adb: this.adb,
            config: this.config,
            cache: this.cache,
            perception: this.perception,
            absorb: (raw, reason) => this.perception.absorb(raw, reason),
            dumpScript: () => this.perception.dumpScriptFor(this.serial),
            settleMs: value => settleMs(this.config, value),
            resolve: (tree, selector) => resolveSelector(tree, selector),
            summarize: (tree, options) => summarize(tree, options),
            peekTree: () => this.perception.peek(),
            perceive: options => this.perception.perceive(options),
            notFound: (selector, tree, extra, loc) => this.notFoundError(selector, tree, extra, loc),
            describe: selector => describeSelector(selector),
            textCommand: text => this.textCommand(text),
            screenSize: () => this.screenSize(),
            keycode: name => KEYCODES[name] ?? KEYCODES[String(name).toLowerCase()],
            assertShellAllowed: () => this.assertShellAllowed(),
            invalidate: reason => this.perception.markDirty(reason),
            serial: () => this.serial,
        };
    }
}

export default { AndroidEngine, ActionError, dshHome, KEYCODES };
