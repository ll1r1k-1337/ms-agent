export type DisposeFn = () => void;

export interface Disposable {
    dispose(): void;
}

/**
 * Registers any number of dispose callbacks and runs them in reverse-registration
 * order on `dispose()`. Idempotent; once disposed, further registrations run
 * immediately so callers don't leak.
 */
export class DisposableStore implements Disposable {
    private callbacks: DisposeFn[] = [];
    private disposed = false;

    add(fn: DisposeFn | Disposable): void {
        const cb: DisposeFn = typeof fn === 'function' ? fn : () => fn.dispose();
        if (this.disposed) {
            this.runSafely(cb);
            return;
        }
        this.callbacks.push(cb);
    }

    addTimer(timer: NodeJS.Timeout | NodeJS.Immediate): void {
        this.add(() => clearAny(timer));
    }

    isDisposed(): boolean {
        return this.disposed;
    }

    size(): number {
        return this.callbacks.length;
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const cbs = this.callbacks.splice(0);
        for (let i = cbs.length - 1; i >= 0; i--) {
            this.runSafely(cbs[i]);
        }
    }

    private runSafely(cb: DisposeFn): void {
        try {
            cb();
        } catch {
            // Swallow: dispose must never throw or partial cleanup leaves resources alive.
        }
    }
}

function clearAny(t: NodeJS.Timeout | NodeJS.Immediate): void {
    try { clearTimeout(t as NodeJS.Timeout); } catch { /* ignore */ }
    try { clearInterval(t as NodeJS.Timeout); } catch { /* ignore */ }
    try { clearImmediate(t as NodeJS.Immediate); } catch { /* ignore */ }
}
