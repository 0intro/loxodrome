/* The data retry banner's sentence (components/DataRetryBanner.svelte,
 * docs/data-retry.md): what did not load, each group followed by its
 * missing publishers in brackets. Locale-free: the words come in as a
 * vocabulary pack, the catalog's own (docs/i18n.md). */

import { DATA_IDLE_MS, sameFailure, type ReadFailure } from '$lib/data/fetchData';
import type { BannerEntry, RetryGroup, RetryView } from '$lib/state/dataRetry.svelte';

export interface DataRetryWords {
	/** The sentence around the list, and the failure the reads had when it
	 *  states one. */
	sentence: (p: { what: string; failure?: string }) => string;
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
 *  obstacles. Retrying automatically." A publisher without a name reads as
 *  its region's, else as its code. The failure the reads share, when the
 *  sentence states one, goes in its own sentence. */
export function describeMissing(entries: readonly BannerEntry[], words: DataRetryWords, failure?: string): string {
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
	return words.sentence(failure ? { what, failure } : { what });
}

/** The app's own words for the kinds of failure. */
export interface FailureWords {
	unanswered: string;
	stalled: (seconds: number) => string;
	unreadable: string;
	offline: string;
}

/** The failure every read the banner names had, when they had one kind:
 *  the device offline before anything else (the browser knows it). Null
 *  when they differ, or one had none worth stating. */
export function sharedFailure(views: readonly RetryView[], offline: boolean): ReadFailure | 'offline' | null {
	if (offline) {
		return 'offline';
	}
	const first = views[0]?.failure ?? null;
	return first && views.every((v) => sameFailure(v.failure, first)) ? first : null;
}

/** A failure in words: the HTTP status as the wire frames it, which stays
 *  English like every wire diagnostic (docs/i18n.md), else the app's own
 *  conclusion. */
export function failureText(f: ReadFailure | 'offline', words: FailureWords): string {
	if (f === 'offline') {
		return words.offline;
	}
	switch (f.kind) {
		case 'http':
			return `HTTP ${f.status}`;
		case 'stalled':
			return words.stalled(DATA_IDLE_MS / 1000);
		case 'unanswered':
			return words.unanswered;
		case 'unreadable':
			return words.unreadable;
	}
}
