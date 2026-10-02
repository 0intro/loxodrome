/* Pure row helpers over the flights library's stored metas: the footer
 * check-sums, the spreadsheet TSV row, and the AMC-shaped CSV mapping.
 * Plain TS (no Svelte, no storage I/O) so the pins run without an
 * IndexedDB harness; every value is locale-free by construction (idents,
 * UTC clocks, h:mm), per the state-module i18n rule. */

import { hm, isoDateUtc, type FlightSummary, type LogbookRow } from '$lib/nav/logbook';
import { fmtClockUtc } from '$lib/route/format';
import { routeEndpointLabel } from '$lib/route/routeLabel';
import type { RouteSegment } from '$lib/nav/routeAssign';
import type { Waypoint } from './route.svelte';
import type { OutingMeta } from './flightsDb';

/** The minimal route shape the flown-plan helpers read: the live registry's
 *  routes and the batch importer's standalone candidates alike. */
export interface FlownRoute {
	id: string;
	name: string | null;
	alternate?: boolean | undefined;
	waypoints: Waypoint[];
}

/** The flown plan's route-chain labels, first-flown order, locale-free (the
 *  '' fallback never writes a localized word into storage, the state-module
 *  i18n rule; an unnamed route with waypoints labels by its endpoints). */
export function flownRouteLabelsFor(
	list: readonly FlownRoute[],
	segments: readonly RouteSegment[],
): string[] {
	const seen: string[] = [];
	for (const s of segments) {
		if (!seen.includes(s.routeId)) {
			seen.push(s.routeId);
		}
	}
	const labels: string[] = [];
	for (const id of seen) {
		const r = list.find((x) => x.id === id);
		if (r && r.waypoints.length >= 2) {
			const label = routeEndpointLabel(r, '');
			if (label !== '') {
				labels.push(label);
			}
		}
	}
	return labels;
}

/** The wall-clock span an outing's flights cover: first block-off to the
 *  last block-on (falling back to landing, then block-off, for an open
 *  tail). Null when the outing has no flights. */
export function outingSpan(meta: OutingMeta): { fromMs: number; toMs: number } | null {
	let fromMs = Infinity;
	let toMs = -Infinity;
	for (const f of meta.flights) {
		fromMs = Math.min(fromMs, f.blockOffMs);
		toMs = Math.max(toMs, f.blockOnMs ?? f.landingMs ?? f.blockOffMs);
	}
	return Number.isFinite(fromMs) ? { fromMs, toMs } : null;
}

/** Whether [fromMs, toMs] overlaps one outing's span (endpoints touching
 *  is NOT an overlap: block times are minute-coarse and one flight may
 *  land the minute the next departs). An OPEN row - one whose flight has
 *  no arrival, so the two ends are the same instant - would never overlap
 *  anything under that rule, yet a departure standing inside a filed
 *  flight's span plainly describes it; that case tests inclusively, which
 *  is what stops an exported-then-reimported CSV from filing a second
 *  copy of every open flight (and, since the ids collide, overwriting the
 *  trace that recorded it). */
export function spansOverlap(
	span: { fromMs: number; toMs: number },
	fromMs: number,
	toMs: number,
): boolean {
	if (fromMs === toMs) {
		return fromMs >= span.fromMs && fromMs <= span.toMs;
	}
	return fromMs < span.toMs && toMs > span.fromMs;
}

/** Whether [fromMs, toMs] overlaps any listed outing's span. The logbook
 *  import's duplicate gate: a CSV row whose span meets a filed outing
 *  describes a flight the library already holds. */
export function overlapsAnyOuting(metas: readonly OutingMeta[], fromMs: number, toMs: number): boolean {
	for (const m of metas) {
		const s = outingSpan(m);
		if (s && spansOverlap(s, fromMs, toMs)) {
			return true;
		}
	}
	return false;
}

/** The 'logbook' rows [fromMs, toMs] supersedes: a trace of the same
 *  flight is strictly better than the CSV row that described it, so the
 *  archive deletes these when the real outing files. */
export function supersededLogbookIds(
	metas: readonly OutingMeta[],
	fromMs: number,
	toMs: number,
): number[] {
	const ids: number[] = [];
	for (const m of metas) {
		if (m.source !== 'logbook') {
			continue;
		}
		const s = outingSpan(m);
		if (s && spansOverlap(s, fromMs, toMs)) {
			ids.push(m.id);
		}
	}
	return ids;
}

export interface RouteLabelToken {
	text: string;
	touched: boolean;
}

interface ChainNode {
	id: string;
	touches: number;
}

function pushNode(nodes: ChainNode[], id: string, isTouch: boolean): void {
	if (id === '') {
		return;
	}
	const last = nodes[nodes.length - 1];
	if (last && last.id === id) {
		last.touches += isTouch ? 1 : 0;
		return;
	}
	nodes.push({ id, touches: isTouch ? 1 : 0 });
}

function chainTokens(nodes: ChainNode[]): RouteLabelToken[] {
	const out: RouteLabelToken[] = [];
	nodes.forEach((n, i) => {
		if (i > 0) {
			out.push({ text: ' → ', touched: false });
		}
		// The ink marks intermediate touchdowns only (the endpoints are what
		// the Departure / Arrival columns already say), but the COUNT shows
		// wherever several wheels-downs collapsed, circuits at the home
		// field included: "LFPL -> LFPK (2x) -> LFPL (3x)".
		const touched = n.touches > 0 && i > 0 && i < nodes.length - 1;
		out.push({
			text: n.touches > 1 ? `${n.id} (${n.touches}x)` : n.id,
			touched,
		});
	});
	return out;
}

/** ONE flight's chain: the CHRONOLOGICAL aerodromes its wheels visited
 *  (departure, then touchPlaces: the detected touch-and-goes and the
 *  committed landing), consecutive repeats collapsed and counted, "LFPL
 *  -> LFPK (5x) -> LFPL" for the 2026-03-19 circuits day. Per FLIGHT on
 *  purpose: each table line is one flight (the AMC row unit), so its
 *  chain must describe that flight alone, never the whole trace. Old
 *  rows whose touchPlaces predates the chronological order fall back to
 *  the landed block-on place until the lazy re-derivation refreshes
 *  them. */
export function flightChainTokens(f: FlightSummary): RouteLabelToken[] {
	const nodes: ChainNode[] = [];
	pushNode(nodes, f.depPlace, false);
	const touches =
		f.touchPlaces ?? (f.landingMs != null && f.arrPlace !== '' ? [f.arrPlace] : []);
	for (const p of touches) {
		pushNode(nodes, p, true);
	}
	return chainTokens(nodes);
}

/** The WHOLE outing's flown chain as bare idents, which is what names the
 *  files it produces (files/fileName.ts, docs/file-names.md): the first
 *  flight's departure, then every flight's wheels-down places in order,
 *  consecutive repeats collapsed (no counts: a file name is an identifier,
 *  not a display) and unknown places dropped.
 *
 *  The trace's OWN evidence, never a linked plan's. Where the wheels went is
 *  what the file is of, it survives a diversion, and it answers with no plan
 *  catalog loaded at all. Empty when nothing it touched is in the airport
 *  dataset, which the grammar then omits. */
export function flownChainIdents(flights: readonly FlightSummary[]): string[] {
	const out: string[] = [];
	const push = (id: string): void => {
		if (id !== '' && out[out.length - 1] !== id) {
			out.push(id);
		}
	};
	for (const f of flights) {
		push(f.depPlace);
		const touches =
			f.touchPlaces ?? (f.landingMs != null && f.arrPlace !== '' ? [f.arrPlace] : []);
		for (const p of touches) {
			push(p);
		}
	}
	return out;
}

/** What the Route cell SHOWS for one flight: its chain when it says more
 *  than the Departure / Arrival columns already do (an intermediate
 *  touchdown exists, or a multiple-touchdown count), else the LINKED
 *  plan's labels on a SINGLE-flight outing (the route identity a
 *  no-intermediate round trip would otherwise reduce to one bare ident;
 *  a multi-flight outing's labels describe the whole trace, not this
 *  line, so they stay in the cell's tooltip), else the chain again.
 *  `labels` come from the DYNAMIC link (state/flightLinks) for trace
 *  rows and the frozen remark for logbook rows; the meta itself stores
 *  no link. */
export function routeCellTokens(
	labels: readonly string[],
	meta: OutingMeta,
	f: FlightSummary,
): RouteLabelToken[] {
	const chain = flightChainTokens(f);
	const places = chain.filter((tk) => tk.text !== ' → ').length;
	const counted = chain.some((tk) => /\(\d+x\)$/.test(tk.text));
	if (places >= 3 || counted) {
		return chain;
	}
	if (meta.flights.length === 1 && labels.length > 0) {
		return [{ text: labels.join(' / '), touched: false }];
	}
	return chain;
}

export interface LibraryTotals {
	/** Sum of the closed flights' block minutes. */
	totalMin: number;
	landings: number;
	nightLandings: number;
	nightMin: number;
}

/** Check-sums over exactly the flights the table LISTS, labelled with the
 *  period in force: a cross-check for the carnet's page totals, never an
 *  accumulated record. Taking flights rather than outings is what lets the
 *  footer follow the period scope, which is the only reading that makes a
 *  sum on screen mean anything (an open flight contributes no time). */
export function totalsOfFlights(flights: readonly FlightSummary[]): LibraryTotals {
	const t: LibraryTotals = { totalMin: 0, landings: 0, nightLandings: 0, nightMin: 0 };
	for (const f of flights) {
		if (f.blockOnMs != null) {
			t.totalMin += Math.round((f.blockOnMs - f.blockOffMs) / 60_000);
		}
		t.landings += (f.landingsDay ?? 0) + (f.landingsNight ?? 0);
		t.nightLandings += f.landingsNight ?? 0;
		t.nightMin += f.nightMin ?? 0;
	}
	return t;
}

/** The same check-sums over whole outings (every flight of each). */
export function libraryTotals(metas: readonly OutingMeta[]): LibraryTotals {
	return totalsOfFlights(metas.flatMap((m) => m.flights));
}

/** The UTC year a flight is filed under: the day its block opens, which
 *  is the date the row shows and the date AMC1 FCL.050 note (i)(1) asks
 *  for. */
export function flightYear(f: FlightSummary): string {
	return isoDateUtc(f.blockOffMs).slice(0, 4);
}

/** One flight as a tab-separated line (the spreadsheet paste path):
 *  date, dep, dep time, arr, arr time, aircraft, total, landings day,
 *  landings night, night, route. Empty cells where the flight is open. */
export function flightTsv(labels: readonly string[], meta: OutingMeta, f: FlightSummary): string {
	return [
		isoDateUtc(f.blockOffMs),
		f.depPlace,
		fmtClockUtc(f.blockOffMs),
		f.arrPlace,
		f.blockOnMs != null ? fmtClockUtc(f.blockOnMs) : '',
		meta.aircraftKey ?? '',
		hm(f.blockOnMs != null ? (f.blockOnMs - f.blockOffMs) / 60_000 : null),
		f.landingsDay == null ? '' : String(f.landingsDay),
		f.landingsNight == null ? '' : String(f.landingsNight),
		hm(f.nightMin),
		labels.join(' / '),
	].join('\t');
}

/** What the CSV export resolves AT EXPORT TIME (never stored): the
 *  aircraft's make / model / registration from the fleet and designator
 *  catalog, and the pilot name ('SELF' fallback, AMC note (i)(5)). */
export interface LibraryRowResolvers {
	make: (aircraftKey: string | null) => string;
	model: (aircraftKey: string | null) => string;
	registration: (aircraftKey: string | null) => string;
	picName: string;
	/** The DYNAMIC link's labels for a trace outing (state/flightLinks);
	 *  null when none computed. Logbook rows use their own frozen remark. */
	labelsFor: (outingId: number) => string[] | null;
}

/** The stored summaries as AMC-shaped LogbookRow[]: chronological ASC (a
 *  carnet import wants time order), one row per flight, decorated by the
 *  injected resolvers. */
export function libraryLogbookRows(
	metas: readonly OutingMeta[],
	resolve: LibraryRowResolvers,
): LogbookRow[] {
	const rows: LogbookRow[] = [];
	const asc = [...metas].sort((a, b) => a.id - b.id);
	for (const m of asc) {
		const remarks = m.source === 'logbook' ? m.remarks : (resolve.labelsFor(m.id)?.join(' / ') ?? '');
		for (const f of m.flights) {
			rows.push({
				slice: {
					blockOffMs: f.blockOffMs,
					takeoffMs: f.takeoffMs,
					landingMs: f.landingMs,
					blockOnMs: f.blockOnMs,
					distanceNM: f.distanceNM,
				},
				departurePlace: f.depPlace,
				arrivalPlace: f.arrPlace,
				aircraftMake: resolve.make(m.aircraftKey),
				aircraftModel: resolve.model(m.aircraftKey),
				registration: resolve.registration(m.aircraftKey),
				picName: resolve.picName,
				// An imported row's own declarations, carried straight back
				// out: the export must not restate this device's pilot as the
				// commander of a flight it only read about.
				...(m.declared ? { declared: m.declared } : {}),
				landingsDay: f.landingsDay,
				landingsNight: f.landingsNight,
				nightMin: f.nightMin,
				remarks,
			});
		}
	}
	return rows;
}
