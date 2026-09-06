/* De-duplicate NOTAM link lists by source id. */

/**
 * Keep the first entry per `notam.id`, preserving order. A source NOTAM
 * split into several area-entries appears once per area in the link lists;
 * the detail panels group all areas of a NOTAM internally, so they want
 * one row per source NOTAM. Uses a plain record (not a Set) so it stays
 * out of the `svelte/prefer-svelte-reactivity` rule and matches the
 * pattern the call sites used inline.
 */
export function dedupeById<T extends { notam: { id: string } }>(items: T[]): T[] {
	const seen: Record<string, true> = {};
	const out: T[] = [];
	for (const item of items) {
		if (seen[item.notam.id]) {
			continue;
		}
		seen[item.notam.id] = true;
		out.push(item);
	}
	return out;
}
