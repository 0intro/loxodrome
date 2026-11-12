/* Web Locks for the specs that must see WHO holds what: the sync layer's
 * presence and writer locks (state/account.svelte.ts, state/syncRegistry.ts).
 * Node has its own navigator.locks, but a spec stubbing this one can ask
 * isHeld() at any moment and hold a lock as "another tab" would.
 * Stub it with vi.stubGlobal('navigator', { locks: fakeLocks() }). */

/** Web Locks, one process's worth: an exclusive request queues behind
 *  whatever holds its name, shared requests never wait on each other. */
export function fakeLocks() {
	type Mode = 'shared' | 'exclusive';
	const held = new Map<string, { mode: Mode; count: number }>();
	const waiting = new Map<string, { mode: Mode; start: () => void }[]>();
	const free = (name: string, mode: Mode): boolean => {
		const h = held.get(name);
		return !h || (mode === 'shared' && h.mode === 'shared');
	};
	const release = (name: string): void => {
		const h = held.get(name);
		if (h && --h.count === 0) {
			held.delete(name);
		}
		const q = waiting.get(name) ?? [];
		while (q.length > 0 && free(name, q[0].mode)) {
			q.shift()!.start();
		}
	};
	return {
		isHeld: (name: string): boolean => held.has(name),
		request(name: string, opts: { mode?: Mode }, cb: () => unknown): Promise<unknown> {
			const mode = opts.mode ?? 'exclusive';
			return new Promise((resolve, reject) => {
				const start = (): void => {
					const h = held.get(name);
					held.set(name, { mode, count: (h?.count ?? 0) + 1 });
					Promise.resolve()
						.then(cb)
						.then(
							(v) => {
								release(name);
								resolve(v);
							},
							(e: unknown) => {
								release(name);
								reject(e instanceof Error ? e : new Error(String(e)));
							},
						);
				};
				const q = waiting.get(name) ?? [];
				if (q.length === 0 && free(name, mode)) {
					start();
				} else {
					q.push({ mode, start });
					waiting.set(name, q);
				}
			});
		},
		query: () =>
			Promise.resolve({
				held: [...held].map(([name, h]) => ({ name, mode: h.mode })),
				pending: [],
			}),
	};
}
