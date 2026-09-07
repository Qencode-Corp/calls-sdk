/** Minimal typed event emitter. Handlers run synchronously on the calling thread; a throwing
 *  handler is reported through console.error and never breaks the emitter or the SDK. */
export type Listener<T extends unknown[]> = (...args: T) => void;

export class Emitter<M extends Record<string, unknown[]>> {
  private readonly handlers = new Map<keyof M, Set<Listener<any>>>();

  on<K extends keyof M>(event: K, handler: Listener<M[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(handler);
    return () => this.off(event, handler);
  }

  once<K extends keyof M>(event: K, handler: Listener<M[K]>): () => void {
    const off = this.on(event, ((...args: M[K]) => { off(); handler(...args); }) as Listener<M[K]>);
    return off;
  }

  off<K extends keyof M>(event: K, handler: Listener<M[K]>): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit<K extends keyof M>(event: K, ...args: M[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of Array.from(set)) {
      try { h(...args); } catch (err) { console.error(`[qencode-calls] handler for "${String(event)}" threw`, err); }
    }
  }

  removeAll(): void { this.handlers.clear(); }
}
