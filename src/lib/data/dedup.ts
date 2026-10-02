/* List identity: de-duplicating lists, and keying the items of one whose
 * names can repeat. A keyed Svelte each throws on a duplicate key, in
 * production too, and a pick stored by name resolves a repeat to the first,
 * so a list is either made of distinct items or keyed by something that is. */

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

/** Keys unique within `items` that read like their names: the first occurrence
 *  keeps its bare name and a repeat takes `#2`, `#3`..., the convention
 *  mergeAirspaces and uniqueSigmetIds follow, so a list whose names are unique
 *  keys (and saves) exactly as before. A suffix another item bears as its own
 *  name ("Seat#2") is skipped for the next free number, so the keys are unique
 *  by construction. Index-aligned with `items`, in list order. */
export function occurrenceKeys<T>(items: readonly T[], name: (item: T) => string): string[] {
	const names = items.map(name);
	// Every bare name first: a repeat must not take a key a later item owns.
	const bare = new Set(names);
	const used = new Set<string>();
	const count = new Map<string, number>();
	return names.map((n) => {
		const c = (count.get(n) ?? 0) + 1;
		count.set(n, c);
		if (c === 1 && !used.has(n)) {
			used.add(n);
			return n;
		}
		let k = Math.max(c, 2);
		while (bare.has(`${n}#${k}`) || used.has(`${n}#${k}`)) {
			k++;
		}
		const key = `${n}#${k}`;
		used.add(key);
		return key;
	});
}

/** The first item per key, in list order: for lists where a repeat is the same
 *  fact said twice (a NOTAM restating one change, a catalogue listing one chart
 *  twice), which a keyed list would otherwise refuse. */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		const k = key(item);
		if (!seen.has(k)) {
			seen.add(k);
			out.push(item);
		}
	}
	return out;
}

/** Dataset rows made unique by id. A row identical in every field to an earlier
 *  row of its id is dropped (a publisher emitting it twice: ENAIRE's obstacles),
 *  and a DIFFERENT row sharing an id takes an occurrence id (`#2`...: two FAA
 *  NDBs under one id), so every id-keyed index, list and selection addresses
 *  one row. The first row of each id keeps it. Only rows whose id repeats are
 *  compared, and a dataset without repeats comes back as the same array. */
export function uniqueRowIds<T extends { id: string }>(rows: T[]): T[] {
	const count = new Map<string, number>();
	for (const r of rows) {
		count.set(r.id, (count.get(r.id) ?? 0) + 1);
	}
	if (rows.length === count.size) {
		return rows;
	}
	const kept = new Map<string, string[]>(); // repeated id -> its kept rows, as JSON
	const survivors: T[] = [];
	for (const r of rows) {
		if (count.get(r.id) === 1) {
			survivors.push(r);
			continue;
		}
		const sig = JSON.stringify(r);
		const seen = kept.get(r.id) ?? [];
		if (seen.includes(sig)) {
			continue;
		}
		seen.push(sig);
		kept.set(r.id, seen);
		survivors.push(r);
	}
	const ids = occurrenceKeys(survivors, (r) => r.id);
	return survivors.map((r, i) => (ids[i] === r.id ? r : { ...r, id: ids[i] }));
}
