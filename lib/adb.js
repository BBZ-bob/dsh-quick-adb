/**
 * 低层 ADB 封装。
 *
 * 一条铁律：**一次 `run()` = 一次往返**。上层把多条设备命令拼进同一个
 * `shell` 脚本，就是把 N 次往返压成 1 次——这是本插件提速的主要来源。
 * @module dsh-quick-adb/adb
 */
import { spawn } from 'node:child_process';

export class AdbError extends Error {
    constructor(message, info = {}) {
        super(message);
        this.name = 'AdbError';
        this.kind = info.kind ?? 'adb';
        this.code = info.code ?? null;
        this.stderr = info.stderr ?? '';
        this.args = info.args ?? [];
        this.ms = info.ms ?? 0;
        this.timedOut = info.timedOut === true;
    }
}

export class Adb {
    /**
     * @param {{adbPath?: string, serial?: string, timeoutMs?: number, maxBuffer?: number, log?: Function, exec?: Function}} options
     */
    constructor({ adbPath = 'adb', serial = '', timeoutMs = 20000, maxBuffer = 32 * 1024 * 1024, log = () => {}, exec = null } = {}) {
        this.adbPath = adbPath;
        this.serial = serial;
        this.timeoutMs = timeoutMs;
        this.maxBuffer = maxBuffer;
        this.log = log;
        // 测试注入点：完全替身 ADB（不必真机即可跑 selftest / bench）
        this.exec = exec;
        this.calls = 0;
    }

    baseArgs() {
        return this.serial !== '' ? ['-s', this.serial] : [];
    }

    /**
     * 执行一次 adb 调用。
     * @param {string[]} args - 不含 serial 前缀的参数
     * @param {{timeoutMs?: number, encoding?: 'utf8'|'buffer', op?: string, withSerial?: boolean}} options
     */
    async run(args, { timeoutMs = this.timeoutMs, encoding = 'utf8', op = 'exec', withSerial = true } = {}) {
        const argv = withSerial ? [...this.baseArgs(), ...args] : [...args];
        const started = Date.now();
        this.calls++;
        if (typeof this.exec === 'function') {
            const result = await this.exec(argv, { timeoutMs, encoding, op });
            return { code: 0, stderr: '', ms: Date.now() - started, ...result };
        }
        return await new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn(this.adbPath, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            }
            catch (error) {
                reject(new AdbError(`无法启动 ${this.adbPath}：${error instanceof Error ? error.message : String(error)}`, { kind: 'adb-spawn', args: argv }));
                return;
            }
            const chunks = [];
            const errChunks = [];
            let received = 0;
            let truncated = false;
            let killed = false;
            const timer = setTimeout(() => {
                killed = true;
                try {
                    child.kill('SIGKILL');
                }
                catch { /* 进程可能已退出 */ }
            }, Math.max(1000, timeoutMs));
            child.stdout.on('data', (chunk) => {
                if (received >= this.maxBuffer) {
                    truncated = true;
                    return;
                }
                received += chunk.length;
                chunks.push(chunk);
            });
            child.stderr.on('data', (chunk) => {
                if (errChunks.length < 64)
                    errChunks.push(chunk);
            });
            child.on('error', (error) => {
                clearTimeout(timer);
                reject(new AdbError(`adb 运行失败：${error.message}`, { kind: 'adb-spawn', args: argv }));
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                const ms = Date.now() - started;
                const stdoutBuffer = Buffer.concat(chunks);
                const stderr = Buffer.concat(errChunks).toString('utf8').trim();
                if (killed) {
                    reject(new AdbError(`adb 调用超时（${timeoutMs}ms）：${argv.join(' ')}`, { kind: 'adb-timeout', code: 'ETIMEDOUT', stderr, args: argv, ms, timedOut: true }));
                    return;
                }
                if (truncated)
                    this.log('warn', `adb 输出超过 ${this.maxBuffer} 字节已截断：${op}`);
                resolve({
                    code: code ?? 0,
                    stdout: encoding === 'buffer' ? stdoutBuffer : stdoutBuffer.toString('utf8'),
                    stderr,
                    ms,
                    truncated,
                });
            });
        });
    }

    /** 在设备 shell 中执行一段脚本（可含 `;`，整段只算一次往返）。 */
    async shell(script, options = {}) {
        return this.run(['shell', script], options);
    }

    /** 二进制安全输出（screencap 等）。 */
    async execOut(args, options = {}) {
        return this.run(['exec-out', ...args], options);
    }

    /** 列出设备。 */
    async devices() {
        const result = await this.run(['devices', '-l'], { withSerial: false, timeoutMs: 8000, op: 'devices' });
        const devices = [];
        const blocked = [];
        const lines = String(result.stdout).split('\n');
        for (const line of lines) {
            const text = line.trim();
            if (text === '' || text.startsWith('List of devices') || text.startsWith('*'))
                continue;
            const parts = text.split(/\s+/);
            if (parts.length < 2)
                continue;
            const serial = parts[0];
            const state = parts[1];
            const extra = {};
            for (const token of parts.slice(2)) {
                const idx = token.indexOf(':');
                if (idx > 0)
                    extra[token.slice(0, idx)] = token.slice(idx + 1);
            }
            const item = { serial, state, model: extra.model ?? '', product: extra.product ?? '', device: extra.device ?? '' };
            if (state === 'device')
                devices.push(item);
            else if (state === 'unauthorized' || state === 'offline' || state === 'no permissions')
                blocked.push(item);
        }
        return { devices, blocked, raw: String(result.stdout).trim() };
    }

    /** 解析出唯一可用 serial（未配置时要求恰好一台在线设备）。 */
    async ensureSerial() {
        if (this.serial !== '')
            return this.serial;
        const { devices, blocked, raw } = await this.devices();
        if (devices.length === 1) {
            this.serial = devices[0].serial;
            this.log('info', `自动选择设备 ${this.serial}`);
            return this.serial;
        }
        if (devices.length === 0) {
            const blockedText = blocked.length > 0 ? `；被拒绝/离线：${blocked.map(d => `${d.serial}(${d.state})`).join(', ')}` : '';
            throw new AdbError(`没有可用的 Android 设备。先执行 adb connect <ip:5555> 并确认 adb devices 显示 device${blockedText}。原始输出：${raw}` , { kind: 'device-missing' });
        }
        throw new AdbError(`检测到 ${devices.length} 台设备，请在插件配置项 serial 中指定其一：${devices.map(d => d.serial).join(', ')}`, { kind: 'device-ambiguous' });
    }

    /** 连接网络设备（USB 之外的服务器部署常见形态）。 */
    async connect(target) {
        const result = await this.run(['connect', target], { withSerial: false, timeoutMs: 8000, op: 'connect' });
        const text = `${result.stdout} ${result.stderr}`.trim();
        const ok = /connected to/i.test(text) && !/cannot|failed|unable/i.test(text);
        return { ok, message: text };
    }
}

export default { Adb, AdbError };
