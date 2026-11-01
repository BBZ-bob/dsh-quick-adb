/**
 * 业务错误类型（独立模块，避免 engine ↔ batch 循环依赖）。
 * @module dsh-quick-adb/errors
 */

export class ActionError extends Error {
    constructor(message, info = {}) {
        super(message);
        this.name = 'ActionError';
        this.kind = info.kind ?? 'action';
        this.detail = info.detail ?? {};
    }
}

export default { ActionError };
