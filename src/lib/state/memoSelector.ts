/* A plain memoised selector for module-level derived values that bridge
 * reactive state into pure functions without an import cycle and cannot
 * be a $derived (they are free functions called from many components).
 *
 * CONTRACT: keyOf must read every reactive input, unconditionally, while
 * building the signature; a call inside any $derived / $effect then
 * tracks exactly what a derived would, and compute reruns only when the
 * signature changed. Guard clauses that bypass the memo (an inactive
 * feature returning null) belong in the caller, before the memoised
 * function, so the gate's own inputs stay tracked. */

export function memoised<A extends unknown[], V>(
	keyOf: (...args: A) => string,
	compute: (...args: A) => V,
): (...args: A) => V {
	let cacheKey: string | null = null;
	let cache!: V;
	return (...args: A): V => {
		const sig = keyOf(...args);
		if (sig === cacheKey) {
			return cache;
		}
		cache = compute(...args);
		cacheKey = sig;
		return cache;
	};
}
