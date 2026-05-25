import type { QueueStateItem, QueueDeltaPayload, QueueSummary } from '../webview/messages';

type DirtyAdd = { kind: 'add'; item: QueueStateItem };
type DirtyRemove = { kind: 'remove' };
type DirtyUpdate = { kind: 'update'; fields: Partial<QueueStateItem> };
type DirtyEntry = DirtyAdd | DirtyRemove | DirtyUpdate;

export type QueueDeltaListener = (delta: QueueDeltaPayload) => void;

/**
 * Per-tick coalescing emitter. All queue mutations call into this — adds,
 * removes, and field updates pile into a dirty Map keyed by taskId. A single
 * microtask drains the Map into one {@link QueueDeltaPayload} delivered to
 * subscribers. This collapses the 400-enqueue burst of fixIssues into one
 * delta and removes the O(N) full-snapshot rebroadcast per task lifecycle
 * event.
 *
 * Conflict resolution within one tick:
 *   - `added` × 2 of same id → last write wins (single added entry)
 *   - `added` then `removed` → no-op (entry not emitted)
 *   - `removed` then `added` → final-state `added`
 *   - `updated` × 2 → merged shallow (later fields win)
 */
export class QueueEventEmitter {
    private dirty = new Map<string, DirtyEntry>();
    private flushScheduled = false;
    private listeners = new Set<QueueDeltaListener>();

    constructor(private readonly getSummary: () => QueueSummary) {}

    subscribe(listener: QueueDeltaListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    added(item: QueueStateItem): void {
        const existing = this.dirty.get(item.id);
        if (existing && existing.kind === 'remove') {
            this.dirty.set(item.id, { kind: 'add', item });
        } else {
            this.dirty.set(item.id, { kind: 'add', item });
        }
        this.scheduleFlush();
    }

    removed(id: string): void {
        const existing = this.dirty.get(id);
        if (existing && existing.kind === 'add') {
            this.dirty.delete(id);
        } else {
            this.dirty.set(id, { kind: 'remove' });
        }
        this.scheduleFlush();
    }

    updated(id: string, fields: Partial<QueueStateItem>): void {
        const existing = this.dirty.get(id);
        if (existing && existing.kind === 'add') {
            existing.item = { ...existing.item, ...fields };
        } else if (existing && existing.kind === 'update') {
            existing.fields = { ...existing.fields, ...fields };
        } else if (!existing) {
            this.dirty.set(id, { kind: 'update', fields: { ...fields } });
        }
        // 'remove' entry: ignore the update — the task is gone in this tick.
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (this.flushScheduled) {
            return;
        }
        this.flushScheduled = true;
        queueMicrotask(() => {
            this.flushScheduled = false;
            this.flushNow();
        });
    }

    /** Synchronous drain. Public for unit tests and explicit flush sites. */
    flushNow(): void {
        if (this.dirty.size === 0) {
            return;
        }
        const added: QueueStateItem[] = [];
        const removed: string[] = [];
        const updated: Array<Partial<QueueStateItem> & { id: string }> = [];
        for (const [id, entry] of this.dirty) {
            if (entry.kind === 'add') {
                added.push(entry.item);
            } else if (entry.kind === 'remove') {
                removed.push(id);
            } else {
                updated.push({ id, ...entry.fields });
            }
        }
        this.dirty.clear();
        const delta: QueueDeltaPayload = {
            ...(added.length ? { added } : {}),
            ...(removed.length ? { removed } : {}),
            ...(updated.length ? { updated } : {}),
            summary: this.getSummary(),
        };
        for (const listener of this.listeners) {
            try {
                listener(delta);
            } catch {
                // Swallow — one bad subscriber must not block the others or
                // poison the next tick.
            }
        }
    }
}
