/* The data retry banner's sentence (components/DataRetryBanner.svelte,
 * docs/data-retry.md): what did not load, each group followed by its
 * missing publishers in brackets. Locale-free: the words come in as a
 * vocabulary pack, the catalog's own (docs/i18n.md). */

import type { BannerEntry, RetryGroup } from '$lib/state/dataRetry.svelte';

export interface DataRetryWords {
	/** The sentence around the list. */
	sentence: (p: { what: string }) => string;
	/** Each group's name, as it reads inside the sentence. */
	groups: Readonly<Record<RetryGroup, string>>;
	/** The publishers' names (t.layers.publisherNames). */
	publishers: Readonly<Record<string, string>>;
	/** A part that is no publisher (a held State's chart index, Denmark's)
	 *  named by its region in the reading language, the About dialog's
	 *  rule; undefined when it is no region. */
	regionName?: ((code: string) => string | undefined) | undefined;
}

/** "Some aeronautical data did not load: airspaces (Germany, Austria),
 *  obstacles. Retrying." A publisher without a name reads as its region's,
 *  else as its code. */
export function describeMissing(entries: readonly BannerEntry[], words: DataRetryWords): string {
	const what = entries
		.map((e) => {
			const label = words.groups[e.group];
			if (e.parts.length === 0) {
				return label;
			}
			const names = e.parts.map((p) => words.publishers[p] ?? words.regionName?.(p) ?? p.toUpperCase());
			return `${label} (${names.join(', ')})`;
		})
		.join(', ');
	return words.sentence({ what });
}
