/* Real-DOM kneeboard-card measurement, run at print-prep time (both packs:
 * the NavLogModal all-routes kneeboard and the FlightPrep dossier): mount
 * one NavLogSheet (and one NavLogSchedule) per route in a detached
 * card-width host with the `kneeboard` prop (the A5 compaction is
 * prop-scoped and media-independent for exactly this, so screen layout IS
 * the printed card layout), read the rendered row geometry, and pack the
 * REAL row heights against the A5 card budget (packMeasuredChunks /
 * packScheduleChunks in the pure navlogCards sibling). Replaces the
 * line-cost estimate for the nav-log split decision; the estimator
 * remains those callers' no-DOM fallback when a measure returns null,
 * while a failed SCHEDULE measure just keeps its route on one card. */

import { mount, unmount, tick } from 'svelte';
import NavLogSheet from './NavLogSheet.svelte';
import NavLogSchedule from './NavLogSchedule.svelte';
import { affordablePadWaypoints, packMeasuredChunks, packScheduleChunks,
	partPadWaypoints,
} from './navlogCards';
import { routeTitle } from '$lib/route/routeLabel';
import type { Route } from '$lib/state/route.svelte';

const PX_PER_MM = 96 / 25.4;

/** Printed card content width: A4 landscape 297 mm minus the sheet's two
 *  8 mm paddings and the 16 mm central gap, halved (132.5 mm), in CSS px. */
export const KB_CARD_CONTENT_WIDTH_PX = ((297 - 2 * 8 - 16) / 2) * PX_PER_MM;

/** One card's total height allowance inside the sheet padding: A4 landscape
 *  210 mm minus the two 8 mm paddings (194 mm, ~733 px). */
export const KB_CARD_BUDGET_PX = (210 - 2 * 8) * PX_PER_MM;

export interface KneeboardMeasure {
	/** Per-leg band height: consecutive waypoint-banner top deltas (each
	 *  covers the two grid rows between banner tops, which are also the
	 *  from-waypoint's own report band by the half-band offset). */
	legPx: number[];
	/** Everything above the first banner: the sheet title block plus the
	 *  grid's header row and top frame; repeats on every continuation card. */
	headerPx: number;
	/** Everything below the last banner's top: the final banner band, the
	 *  totals row beside its lower half, and the bottom frame. */
	totalsPx: number;
}

/** Mount `route`'s nav log at card geometry off-viewport and measure its
 *  rendered bands. `legMinFt` must be the caller's prefetched MSA (or []):
 *  a provided prop keeps the sheet from starting its own async MSA fetch.
 *  Null on any inconsistency (SSR, missing elements, degenerate rects);
 *  callers then fall back to the line-cost estimator. */
/** The shared measuring host: card content width, off-viewport, hidden
 *  but LAID OUT (display none would zero every rect). */
function makeCardHost(): HTMLDivElement {
	const host = document.createElement('div');
	host.style.position = 'fixed';
	host.style.left = '-10000px';
	host.style.top = '0';
	host.style.width = `${KB_CARD_CONTENT_WIDTH_PX}px`;
	host.style.visibility = 'hidden';
	return host;
}

export async function measureKneeboardCards(
	route: Route,
	legMinFt: (number | null)[] | undefined,
): Promise<KneeboardMeasure | null> {
	if (typeof document === 'undefined') {
		return null;
	}
	const host = makeCardHost();
	document.body.appendChild(host);
	let sheet: Record<string, unknown> | null = null;
	try {
		sheet = mount(NavLogSheet, {
			target: host,
			props: { route, legMinFt: legMinFt ?? [], minWaypoints: 0, kneeboard: true },
		});
		await tick();
		// i18n-ignore-start: CSS selectors, not user-visible text
		const grid = host.querySelector('.navlog');
		const reports = host.querySelectorAll('.report');
		// i18n-ignore-end
		const n = route.waypoints.length;
		if (!grid || n < 2 || reports.length !== n) {
			return null;
		}
		const hostTop = host.getBoundingClientRect().top;
		// Grid bottom, NOT host scrollHeight: the on-screen-only radial
		// footnote (.no-print) renders in the measuring host but never prints.
		const gridBottom = grid.getBoundingClientRect().bottom;
		const tops = Array.from(reports, (r) => r.getBoundingClientRect().top);
		const legPx: number[] = [];
		for (let k = 0; k + 1 < n; k++) {
			legPx.push(tops[k + 1] - tops[k]);
		}
		const headerPx = tops[0] - hostTop;
		const totalsPx = gridBottom - tops[n - 1];
		if (!(headerPx > 0) || !(totalsPx > 0) || legPx.some((v) => !(v > 0))) {
			return null;
		}
		return { legPx, headerPx, totalsPx };
	} catch {
		return null;
	} finally {
		if (sheet) {
			// Synchronous teardown (no outro transitions in the sheet); the
			// returned promise resolves immediately and carries nothing.
			void unmount(sheet);
		}
		host.remove();
	}
}

/** One blank filler waypoint row pair at the kneeboard 40px track
 *  minimum; blank rows carry no content, so they never grow past it. */
export const PAD_PAIR_PX = 80;

/** The minWaypoints a measured SINGLE card affords: its real content plus
 *  only as many blank form rows as still fit the budget. */
export function measuredMinWaypoints(m: KneeboardMeasure, realWps: number, want = 8): number {
	const used = m.headerPx + m.legPx.reduce((a, b) => a + b, 0) + m.totalsPx;
	return affordablePadWaypoints(realWps, used, KB_CARD_BUDGET_PX, PAD_PAIR_PX, want);
}

/** The measured card split: real row heights packed against the per-card
 *  budget net of the repeating header (the boundary banner / totals band
 *  close each part, see packMeasuredChunks). */
export function measuredChunks(m: KneeboardMeasure): { from: number; to: number }[] {
	return packMeasuredChunks(m.legPx, KB_CARD_BUDGET_PX - m.headerPx, m.totalsPx);
}

/** The per-part minWaypoints a measured SPLIT affords: each part's
 *  closing-inclusive load against the same net budget the packer used,
 *  so every card, continuation parts included, fills its blank form. */
export function measuredCardPads(
	m: KneeboardMeasure,
	chunks: readonly { from: number; to: number }[],
): number[] {
	return chunks.map((c) =>
		partPadWaypoints(m.legPx, c, KB_CARD_BUDGET_PX - m.headerPx, m.totalsPx, PAD_PAIR_PX),
	);
}

export interface ScheduleMeasure {
	/** Per-event row height: consecutive row-top deltas, the last row its
	 *  own rect height (collapsed borders make row tops contiguous). */
	rowPx: number[];
	/** Everything above the first row: the heading plus the table's header
	 *  row; repeats on every continuation card. */
	headerPx: number;
	/** Whatever the section renders below the last row (~0 today: each tr
	 *  closes itself with its own bottom border); the final part's closer. */
	footPx: number;
}

/** Mount `route`'s radio/airspace schedule at card geometry off-viewport
 *  and measure its rendered rows (the measureKneeboardCards sibling). The
 *  heading is the packs' own dep -> dest title, so the measured header is
 *  the printed one. Everything the schedule computes from (the airspaces
 *  dataset, the shared terrain / wind caches) is state the print prep has
 *  already ensured; null on any inconsistency (SSR, airspaces missing, no
 *  crossed airspace, degenerate rects), and the callers then keep that
 *  route on the single-card layout, never an estimator. */
export async function measureScheduleCards(route: Route): Promise<ScheduleMeasure | null> {
	if (typeof document === 'undefined' || route.waypoints.length < 2) {
		return null;
	}
	const host = makeCardHost();
	document.body.appendChild(host);
	let card: Record<string, unknown> | null = null;
	try {
		const heading = routeTitle(route);
		card = mount(NavLogSchedule, {
			target: host,
			props: { route, heading, kneeboard: true },
		});
		await tick();
		// i18n-ignore-start: CSS selectors, not user-visible text
		const sect = host.querySelector('.sched');
		const rows = host.querySelectorAll('tbody tr.ev');
		// i18n-ignore-end
		if (!sect || rows.length === 0) {
			return null;
		}
		const hostTop = host.getBoundingClientRect().top;
		const sectBottom = sect.getBoundingClientRect().bottom;
		const tops = Array.from(rows, (r) => r.getBoundingClientRect().top);
		const lastBottom = rows[rows.length - 1].getBoundingClientRect().bottom;
		const rowPx: number[] = [];
		for (let k = 0; k < tops.length; k++) {
			rowPx.push((k + 1 < tops.length ? tops[k + 1] : lastBottom) - tops[k]);
		}
		const headerPx = tops[0] - hostTop;
		const footPx = Math.max(0, sectBottom - lastBottom);
		if (!(headerPx > 0) || rowPx.some((v) => !(v > 0))) {
			return null;
		}
		return { rowPx, headerPx, footPx };
	} catch {
		return null;
	} finally {
		if (card) {
			void unmount(card);
		}
		host.remove();
	}
}

/** The measured schedule split: real row heights packed against the
 *  per-card budget net of the repeating header. Rows are self-closing
 *  (interior cuts cost nothing); the final part closes with the measured
 *  foot (see packScheduleChunks). */
export function measuredScheduleChunks(m: ScheduleMeasure): { from: number; to: number }[] {
	return packScheduleChunks(m.rowPx, KB_CARD_BUDGET_PX - m.headerPx, m.footPx);
}
