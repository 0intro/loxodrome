/* A derived read the way a component reads it: `fn` inside a $derived,
 * copied out by an effect, so a spec in the client project sees exactly
 * what a panel would show and when it changes. */

export function mountDerived<T>(fn: () => T): { value: () => T | undefined; stop: () => void } {
	let value: T | undefined;
	const stop = $effect.root(() => {
		const shown = $derived(fn());
		$effect(() => {
			value = shown;
		});
	});
	return { value: () => value, stop };
}

/** An effect the way a component runs one, counting its runs: a spec asks
 *  whether something it calls subscribes it to state it must not follow. */
export function mountEffect(fn: () => void): { runs: () => number; stop: () => void } {
	let runs = 0;
	const stop = $effect.root(() => {
		$effect(() => {
			runs++;
			fn();
		});
	});
	return { runs: () => runs, stop };
}
