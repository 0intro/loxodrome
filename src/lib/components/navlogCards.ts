/* Pure kneeboard-card chunking for the printed nav logs AND the printed
 * radio/airspace schedules (the NavLogModal all-routes kneeboard and the
 * flight dossier's per-trip cards): a card that outgrows one A5 panel is
 * split into numbered continuation cards instead of letting the content
 * fragment mid-row across sheets. Kept free of Svelte and I/O (the
 * $lib/state/navlogSchedule.ts pattern) so it is unit-testable in Node.
 *
 * The PRIMARY split is MEASURED: packMeasuredChunks packs real rendered
 * band heights (px), delivered by the navlogMeasure.ts sibling's
 * print-prep DOM mount, against the A5 card budget. The line-cost
 * estimator below (kneeboardLegCosts + kneeboardCardChunks) remains the
 * no-DOM FALLBACK for when a measure fails: each leg costs an estimated
 * line count and cards pack up to a line budget, so a standard route
 * fills ~7 legs per card while frequency-heavy aerodrome chains split
 * earlier. Calibrated 2026-07 with the printToPDF + pdftotext harness: a
 * standard leg (short name, a note line) runs ~6 lines and 7 of them
 * fill one A5 panel; an all-aerodrome chain with multi-line frequency
 * banners runs ~10 lines per leg and fits 4. The estimate only has to be
 * roughly right: the row-level break-inside rules and the sheets' cloned
 * padding keep a rare mis-estimate tidy on its continuation fragment. */

import { coalesceRadioLines, type Radio } from '$lib/format/radio';
import { freqDisplayLines } from '$lib/route/format';
import type { Waypoint } from '$lib/state/route.svelte';

/** One printed card of a route's nav log or radio/airspace schedule:
 *  the whole content, or one numbered continuation part of it. The shape
 *  both print flows render (NavLogModal kneeboard + dossier PrintDoc). */
export interface RouteCard<R extends { id: string }> {
	route: R;
	/** Absolute leg / row range this card renders; absent = the whole
	 *  content. */
	range?: { from: number; to: number };
	/** 1-based part marker, present only when the content is split. */
	part?: { index: number; count: number };
	/** Measured minWaypoints for THIS part (blank form rows capped by the
	 *  card's leftover budget); absent = the caller's per-route value. */
	pad?: number;
}

/** {#each} key of one printed card (NavLogModal kneeboard + the dossier
 *  PrintDoc): the route id alone for an unsplit card, suffixed with the
 *  1-based part index for a continuation card. */
export function cardKey(c: {
	route: { id: string };
	part?: { index: number; count: number } | undefined;
}): string {
	return c.part ? `${c.route.id}:${c.part.index}` : c.route.id;
}

/** Expand one route's chunk ranges into its printed cards: several chunks
 *  become numbered continuation cards; one chunk (or none, the unmeasured
 *  schedule case) stays a single whole-content card. */
export function expandCards<R extends { id: string }>(
	route: R,
	chunks: readonly { from: number; to: number }[],
	pads?: readonly number[],
): RouteCard<R>[] {
	return chunks.length > 1
		? chunks.map((c, i) => ({
				route,
				range: c,
				part: { index: i + 1, count: chunks.length },
				...(pads?.[i] !== undefined ? { pad: pads[i] } : {}),
			}))
		: [{ route }];
}

/** Group cards in pairs, one pair per landscape sheet (two A5 cards side
 *  by side): six cards print as exactly three sheets. */
export function pairCards<T>(cards: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < cards.length; i += 2) {
		out.push(cards.slice(i, i + 2));
	}
	return out;
}

/** The no-DOM estimator both print flows fall back to when a route's
 *  measured split is missing: the line-cost chunker with the banner
 *  inputs both mounts price the same way. `airportRadios` resolves an
 *  ident to its published radios and is null while the dataset is absent
 *  or the frequencies column is off (freq-change resolution is a
 *  per-line refinement, not a line-count change). */
export function estimatorCardChunks(
	waypoints: readonly Pick<Waypoint, 'kind' | 'ident' | 'label' | 'notes' | 'freqsManual'>[],
	airportRadios: ((ident: string) => readonly Radio[]) | null,
	cols: { enrouteFreqs: boolean; vorRadials: boolean },
): { from: number; to: number }[] {
	return kneeboardCardChunks(
		kneeboardLegCosts(waypoints, {
			radioLines: (ident: string): number =>
				airportRadios ? coalesceRadioLines(airportRadios(ident)).length : 0,
			enrouteLine: cols.enrouteFreqs,
			radialLine: cols.vorRadials,
		}),
	);
}

/** Line budget of one A5 card at the kneeboard row heights, calibrated by
 *  bisection with the printToPDF harness: a plain 6-unit leg fits 7 per
 *  card (7 x 6 + totals = 45), a full-house aerodrome leg (frequencies +
 *  enroute + radial columns, ~9-10 units) fits 4. The estimate covers the
 *  drivers the mounts can price (labels, notes, radio lines, the enroute
 *  and radial columns); residual growth (multi-entry radial notes, class-A
 *  chips) can spill a worst-case row, which the sheets' cloned padding and
 *  row-level break-inside keep tidy. */
export const KNEEBOARD_BUDGET_LINES = 45;
/** Fixed cost of one leg: its two 40px grid rows, which absorb up to two
 *  banner lines and two note lines before the row grows; each further
 *  content line adds one unit. */
export const LEG_BASE_LINES = 6;
/** The totals band, reserved on the LAST card beside its legs. */
export const TOTALS_LINES = 3;
/** Content lines the base rows absorb before growing. */
const ABSORBED_LINES = 2;
/** Characters per wrapped line in the banner name / notes columns (A5
 *  compaction widths, conservative). */
const WRAP_CHARS = 24;

const wrapLines = (text: string): number =>
	text
		.split('\n')
		.reduce((n, line) => n + Math.max(1, Math.ceil(line.length / WRAP_CHARS)), 0);

/** Estimated line cost of each leg: the band skeleton plus the taller of
 *  the from-waypoint's banner stack (label + frequency lines) and its
 *  notes stack. `radioLines(ident)` supplies the airport's published
 *  radio-line count (null/absent = 1, the typical single A/A line);
 *  `enrouteLine` adds one line per leg when the enroute-frequencies
 *  nav-log column is on. */
export function kneeboardLegCosts(
	waypoints: readonly Pick<Waypoint, 'kind' | 'ident' | 'label' | 'notes' | 'freqsManual'>[],
	opts: {
		radioLines?: (ident: string) => number | null;
		enrouteLine?: boolean;
		/** The VOR-radials nav-log column is on: its station + bearing note
		 *  can grow any row; priced flat, one line per leg. */
		radialLine?: boolean;
	} = {},
): number[] {
	const costs: number[] = [];
	for (let i = 0; i + 1 < waypoints.length; i++) {
		const wp = waypoints[i];
		let freq = 0;
		if (wp.freqsManual != null) {
			freq = freqDisplayLines(wp.freqsManual).length;
		} else if (wp.kind === 'airport' && wp.ident) {
			freq = opts.radioLines?.(wp.ident) ?? 1;
		}
		if (opts.enrouteLine) {
			freq += 1;
		}
		if (opts.radialLine) {
			freq += 1;
		}
		const nameLines = wrapLines(wp.label ?? wp.ident ?? '');
		const banner = Math.max(1, nameLines) + freq;
		const notes = wp.notes ? wrapLines(wp.notes) : 0;
		const extra = Math.max(0, Math.max(banner, notes) - ABSORBED_LINES);
		costs.push(LEG_BASE_LINES + extra);
	}
	return costs;
}

/** Pack per-leg line costs into per-card leg ranges (ABSOLUTE leg indices,
 *  end-exclusive). Greedy fill up to the budget (a single over-budget leg
 *  still gets a card), then one smoothing pass pulls legs backward so the
 *  parts even out (a 42/6 split never prints a near-empty trailing card).
 *  The LAST card additionally reserves `totalsCost` lines for the totals
 *  band. Empty costs -> no cards. */
export function kneeboardCardChunks(
	costs: readonly number[],
	budget = KNEEBOARD_BUDGET_LINES,
	totalsCost = TOTALS_LINES,
): { from: number; to: number }[] {
	const n = costs.length;
	if (n <= 0) {
		return [];
	}
	const sum = (from: number, to: number): number => {
		let s = 0;
		for (let i = from; i < to; i++) {
			s += costs[i];
		}
		return s;
	};
	// Greedy forward fill; the final leg carries the totals reserve, so the
	// last card is born with room for its totals band (a single leg too big
	// for any budget still gets a card: parts never go below one leg).
	const bounds: number[] = [0];
	let acc = 0;
	for (let i = 0; i < n; i++) {
		const reserve = i === n - 1 ? totalsCost : 0;
		if (acc > 0 && acc + costs[i] + reserve > budget) {
			bounds.push(i);
			acc = 0;
		}
		acc += costs[i];
	}
	bounds.push(n);
	// Smoothing: move single legs from a heavier part to a lighter NEXT
	// part while it reduces the imbalance and respects the budget.
	for (let pass = 0; pass < n; pass++) {
		let moved = false;
		for (let b = 1; b < bounds.length - 1; b++) {
			const loSum = sum(bounds[b - 1], bounds[b]);
			const hiReserve = b + 1 === bounds.length - 1 ? totalsCost : 0;
			const hiSum = sum(bounds[b], bounds[b + 1]) + hiReserve;
			const legCost = costs[bounds[b] - 1];
			if (
				bounds[b] - bounds[b - 1] > 1 &&
				loSum > hiSum + legCost &&
				hiSum + legCost <= budget
			) {
				bounds[b] -= 1;
				moved = true;
			}
		}
		if (!moved) {
			break;
		}
	}
	const out: { from: number; to: number }[] = [];
	for (let b = 0; b + 1 < bounds.length; b++) {
		out.push({ from: bounds[b], to: bounds[b + 1] });
	}
	return out;
}

/** The shared greedy-fill + balancing core behind the two measured
 *  packers: `closing(to)` prices whatever a part ending at row/leg `to`
 *  renders AFTER its last row (a repeated boundary band, a totals block,
 *  or nothing when rows are self-closing). Empty costs -> no cards; a
 *  single over-budget row still gets a card. */
function packChunksWithClosing(
	costs: readonly number[],
	budget: number,
	closing: (to: number) => number,
): { from: number; to: number }[] {
	const n = costs.length;
	if (n <= 0) {
		return [];
	}
	const sum = (from: number, to: number): number => {
		let s = 0;
		for (let i = from; i < to; i++) {
			s += costs[i];
		}
		return s;
	};
	// Greedy forward fill: leg i joins the current part while the part still
	// fits WITH its closing cost at i+1 (a single leg too big for any budget
	// still gets a card: parts never go below one leg).
	const bounds: number[] = [0];
	let acc = 0;
	for (let i = 0; i < n; i++) {
		if (acc > 0 && acc + costs[i] + closing(i + 1) > budget) {
			bounds.push(i);
			acc = 0;
		}
		acc += costs[i];
	}
	bounds.push(n);
	// Smoothing: move single legs from a heavier part to a lighter NEXT
	// part while it reduces the imbalance and respects the budget; loads
	// compare closing-inclusive, so the balance is over real card heights.
	// (Under the boundary-repeat closing shape, moving the cut from `to` to
	// `to - 1` also swaps which band is the repeated closer; the
	// closing-inclusive comparison prices that exactly.)
	for (let pass = 0; pass < n; pass++) {
		let moved = false;
		for (let b = 1; b < bounds.length - 1; b++) {
			const lo = sum(bounds[b - 1], bounds[b]) + closing(bounds[b]);
			const hi = sum(bounds[b], bounds[b + 1]) + closing(bounds[b + 1]);
			const legCost = costs[bounds[b] - 1];
			if (
				bounds[b] - bounds[b - 1] > 1 &&
				lo > hi + legCost &&
				hi + legCost <= budget
			) {
				bounds[b] -= 1;
				moved = true;
			}
		}
		if (!moved) {
			break;
		}
	}
	const out: { from: number; to: number }[] = [];
	for (let b = 0; b + 1 < bounds.length; b++) {
		out.push({ from: bounds[b], to: bounds[b + 1] });
	}
	return out;
}

/** Pack MEASURED per-leg band heights (px) into per-card leg ranges
 *  (ABSOLUTE leg indices, end-exclusive): the closing-cost-aware sibling
 *  of kneeboardCardChunks (same greedy fill + balancing pass). A
 *  continuation card renders its legs PLUS the bounding waypoint's band
 *  repeated at the cut, so a NON-final part closes with costs[to]: the
 *  boundary waypoint's report element spans exactly the two grid rows
 *  whose heights costs[to] sums (legPx[k] = report[k+1].top -
 *  report[k].top = report[k]'s own band), so the repeated banner costs
 *  the next part's opening leg over again. The FINAL part closes with
 *  totalsPx (the last banner + totals band + bottom frame, measured).
 *  `budget` is the card allowance MINUS the per-part header (title +
 *  grid header row), which repeats on every part. Empty costs -> no
 *  cards; a single over-budget leg still gets a card. */
export function packMeasuredChunks(
	costs: readonly number[],
	budget: number,
	totalsPx: number,
): { from: number; to: number }[] {
	return packChunksWithClosing(costs, budget, (to) =>
		to >= costs.length ? totalsPx : costs[to],
	);
}

/** Pack MEASURED schedule row heights (px) into per-card row ranges
 *  (ABSOLUTE event indices, end-exclusive), for the radio/airspace
 *  schedule cards (navlogMeasure's measureScheduleCards). Schedule rows
 *  are SELF-closing: the collapsed table draws each tr's own
 *  border-bottom whether or not a next row follows, and a cut repeats no
 *  boundary row, so interior cuts cost NOTHING; only the FINAL part
 *  closes with `footPx`, whatever the section renders below the last row
 *  (measured; ~0 today, the table ends at its last border). `budget` is
 *  the card allowance MINUS the per-part header (heading + thead), which
 *  repeats on every part. */
export function packScheduleChunks(
	costs: readonly number[],
	budget: number,
	footPx: number,
): { from: number; to: number }[] {
	return packChunksWithClosing(costs, budget, (to) => (to >= costs.length ? footPx : 0));
}

/** The minWaypoints value one measured PART affords: the part's load is
 *  the packer's own closing-inclusive quantity (the repeated boundary
 *  band on an interior cut, the totals block on the final part), so the
 *  blank form rows fill exactly the leftover packChunksWithClosing
 *  proved free and a pad can never overflow the card. */
export function partPadWaypoints(
	costs: readonly number[],
	chunk: { from: number; to: number },
	budgetPx: number,
	totalsPx: number,
	padPairPx: number,
	want = 8,
): number {
	let load = 0;
	for (let i = chunk.from; i < chunk.to; i++) {
		load += costs[i];
	}
	load += chunk.to >= costs.length ? totalsPx : costs[chunk.to];
	return affordablePadWaypoints(chunk.to - chunk.from + 1, load, budgetPx, padPairPx, want);
}

/** The minWaypoints value a measured single card can afford: blank filler
 *  rows are only added while they fit the budget beside the real content
 *  (a frequency-heavy short route previously overflowed its card by a few
 *  px because the pad count was blind). realWps at or above `want` needs
 *  no pads; otherwise pads are capped by the leftover budget at
 *  `padPairPx` per blank waypoint row pair. */
export function affordablePadWaypoints(
	realWps: number,
	usedPx: number,
	budgetPx: number,
	padPairPx: number,
	want = 8,
): number {
	if (realWps >= want) {
		return want;
	}
	const afford = Math.max(0, Math.floor((budgetPx - usedPx) / padPairPx));
	return Math.min(want, realWps + afford);
}
