/* Search keys cached per row. A WeakMap: a row a merge replaces takes its
 * key with it, and a country landing late folds only its own rows. Pure. */

import type { SearchKey } from './match';

/** `build`, remembered per row object. */
export function keyCache<T extends object>(build: (row: T) => SearchKey): (row: T) => SearchKey {
	const cache = new WeakMap<T, SearchKey>();
	return (row) => {
		let k = cache.get(row);
		if (!k) {
			k = build(row);
			cache.set(row, k);
		}
		return k;
	};
}

// Rows folded between two clock reads.
const WARM_STRIDE = 64;

/** Build the keys of `rows` ahead of the first query, in slices of about
 *  `sliceMs` with a macrotask between them, so folding fifty thousand names
 *  on a phone never holds a frame. A query arriving first folds what is left
 *  itself; the work is never done twice. */
export async function warmKeys<T extends object>(
	rows: readonly T[],
	key: (row: T) => SearchKey,
	sliceMs = 8,
): Promise<void> {
	let i = 0;
	while (i < rows.length) {
		const t0 = performance.now();
		while (i < rows.length && performance.now() - t0 < sliceMs) {
			const end = Math.min(rows.length, i + WARM_STRIDE);
			for (; i < end; i++) {
				key(rows[i]);
			}
		}
		if (i < rows.length) {
			await new Promise((r) => setTimeout(r, 0));
		}
	}
}
