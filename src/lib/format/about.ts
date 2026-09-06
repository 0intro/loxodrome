/* Formatters for the About modal's data-source cards: AIRAC labels, UTC
 * timestamps, and freshness buckets derived from a workflow's last run. */

import { airacYYNN, airacCycleIndex } from '$lib/data/airac';

/** Freshness bucket for a dataset's "Generated" line, by AIRAC-cycle age. */
export type Freshness = 'fresh' | 'stale' | 'expired' | '';

// "2026-05-22T10:46:26.605Z" → "2026-05-22 10:46 UTC"
export function fmtUTC(iso: string | undefined): string {
	if (!iso) {
		return '–';
	}
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		return iso;
	}
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/* Prose integer counts go through fmtInt() in $lib/state/i18n.svelte.ts
 * (locale grouping); this module stays locale-free. */

// "2026-05-14T..." → "AIRAC 2605 · 2026-05-14". Returns "–" for empty
// input. Used by every data-source card so the AIRAC label reads the
// same across SIA, pruatlas, FAA, and the airports overlay.
export function fmtAiracDate(iso: string | undefined | null): string {
	if (!iso) {
		return '–';
	}
	const yynn = airacYYNN(iso);
	const date = iso.slice(0, 10);
	return yynn ? `AIRAC ${yynn} · ${date}` : date;
}

/** Whether a publisher's pre-release is worth announcing in the About
 *  card, and which date to print.
 *
 *  Only a cycle that is BOTH unloaded and still ahead is news. Two cases
 *  used to be announced wrongly, both by reading the current-slot sidecar
 *  instead of the loader's own decision:
 *
 *  - The pre-release has been LOADED. Between a cycle becoming effective
 *    and the workflow rolling it into the current slot, the loader
 *    fetches the `.next` file, so the card called the cycle in use "next"
 *    and named the superseded one as current.
 *  - The pre-release has ARRIVED but the session predates it. That is
 *    real, but it is the AiracBanner's to say: the banner fires off the
 *    same state and carries a Reload button, which small print in a modal
 *    the user has to open cannot.
 *
 *  Structurally typed over the AiracSlot cell so this module keeps
 *  importing no state. */
export function announceNextCycle(
	cell: { nextEffective: string | null; slot: 'current' | 'next' } | null | undefined,
	fallback: string | undefined,
	now: Date = new Date(),
): string | undefined {
	// No cell: the publisher is outside the AIRAC matrix, or its fetch has
	// not landed. Nothing better than the caller's own sidecar to go on.
	if (!cell) {
		return fallback;
	}
	if (cell.slot === 'next' || !cell.nextEffective) {
		return undefined;
	}
	const ms = Date.parse(cell.nextEffective);
	if (!Number.isFinite(ms) || ms <= now.getTime()) {
		return undefined;
	}
	return cell.nextEffective;
}

/** Parts of the "active in N days" aside; the catalogs render the words
 *  (t.about.activeNow / activeSoon / activeInDays). */
export type RelativeActive =
	| { kind: 'none' }
	| { kind: 'now' }
	| { kind: 'soon' }
	| { kind: 'days'; days: number };

// 'days' counts to the effective instant; 'soon' is under a day away,
// 'now' already effective (a reload would load it).
export function relativeActive(iso: string | undefined): RelativeActive {
	if (!iso) {
		return { kind: 'none' };
	}
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) {
		return { kind: 'none' };
	}
	const diff = ms - Date.now();
	if (diff <= 0) {
		return { kind: 'now' };
	}
	const days = Math.round(diff / 86_400_000);
	if (days === 0) {
		return { kind: 'soon' };
	}
	return { kind: 'days', days };
}

// How many whole days since the workflow last produced this dataset (0 =
// today, null = unknown), for the aside beside the "Generated" line; the
// catalogs render the words (t.about.generatedToday / daysAgo). Pairs with
// freshnessClass(), which colours by AIRAC cycle rather than raw day count.
export function agoDays(iso: string | undefined): number | null {
	if (!iso) {
		return null;
	}
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) {
		return null;
	}
	return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

// Colour the "Generated" line by AIRAC-cycle distance, not raw age: the
// data workflows commit only when the JSON content changes, so generatedAt
// tracks the last AIRAC publication, and aeronautical data stays current
// for its whole 28-day cycle. Same cycle reads normal; one cycle behind (a
// newer cycle is effective, the auto-refresh still pending) warns amber;
// two or more cycles behind is a stalled feed and goes red.
export function freshnessClass(iso: string | undefined): Freshness {
	if (!iso) {
		return '';
	}
	const gen = airacCycleIndex(iso);
	if (!Number.isFinite(gen)) {
		return '';
	}
	const behind = airacCycleIndex(Date.now()) - gen;
	if (behind <= 0) {
		return 'fresh';
	}
	if (behind === 1) {
		return 'stale';
	}
	return 'expired';
}
