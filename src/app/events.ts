// Typed event bus (architecture.md, A change). Views subscribe to "changed" and re-render from
// the store, which keeps every open view consistent.

export type Listener<T> = (payload: T) => void;

export class EventBus<Events extends { [K in keyof Events]: unknown }> {
	private listeners = new Map<keyof Events, Set<Listener<never>>>();

	on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
		let set = this.listeners.get(event);
		if (set === undefined) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
		return () => set.delete(listener);
	}

	emit<K extends keyof Events>(event: K, payload: Events[K]): void {
		const set = this.listeners.get(event);
		if (set === undefined) return;
		for (const l of [...set]) (l as Listener<Events[K]>)(payload);
	}

	clear(): void {
		this.listeners.clear();
	}
}

/** Serialized command queue: one mutation at a time, in order. */
export class CommandQueue {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(fn: () => T | Promise<T>): Promise<T> {
		const result = this.tail.then(fn, fn);
		this.tail = result.catch(() => undefined);
		return result;
	}
}
