/* Top-level fetch orchestrator: validate inputs, derive the ICAO list from
 * the current viewport, page through /notam, hand the rows to the parser.
 *
 * The transport (autorouter -> proxy -> proxied JSON) is in session.ts;
 * the viewport math is in viewport.ts; this module is the user-visible
 * action behind the NotamLoader's "Fetch this view" row. */

import { t } from '$lib/state/i18n.svelte';
import { errorTextOf } from '$lib/i18n/errorText';
import { airspacesOver } from '$lib/data/airspaces';
import { DEFAULT_CORRIDOR_RADIUS_NM } from '$lib/route/notamCorridor';
import { rowToIcaoText, type AutorouterRow } from './client';
import { getJson } from './session';
import { autorouter, proxyBase } from './state.svelte';
import {
	MAX_VIEWPORT_DEG_PER_SIDE,
	describeEmptyViewport,
	routeIcaos,
	unionRouteIcaos,
	viewportBbox,
	viewportIcaos,
	viewportTooLarge,
} from './viewport';
import {
	airportByIdent,
	ensureAirports,
	ensureAirspaces,
	ensureNavaids,
	getAirspaces,
} from '$lib/state/data.svelte';
import type { FetchScope } from '$lib/state/fetchScope.svelte';
import { commitBriefing } from '$lib/state/notam.svelte';
import { notamFetchBusy } from '$lib/state/notamSource.svelte';
import { routes, routeSettings } from '$lib/state/route.svelte';

// Per-call `itemas` chunk size. autorouter silently drops entries past an
// undocumented cutoff; passing the whole viewport at once means the
// airports past that point return no NOTAMs even when they exist. The
// sibling Go tool at github.com/0intro/notam/autorouter/notam.go pins
// this at maxBatch = 40 (notam.go:26); we use the same value here.
const ITEMAS_CHUNK_SIZE = 40;

// Forward-looking window the request asks for; NOTAMs starting later than
// this aren't returned.
const VALIDITY_WINDOW_DAYS = 30;

export async function fetchNotamsForViewport(): Promise<void> {
	// Decline before touching any status field, so a call made while another
	// fetch runs cannot clobber that fetch's report. Every source counts: all
	// three fetches commit through commitBriefing, replacing one briefing.
	if (notamFetchBusy()) {
		return;
	}
	// Claim the shared status for this button before the pre-flight guards
	// below, which report an error without ever reaching `fetching`.
	autorouter.error = null;
	autorouter.lastKind = 'viewport';

	if (!autorouter.proxyUrl) {
		autorouter.error = () => t.errors.proxyNotConfigured;
		return;
	}

	// Hard viewport-size limit. Whole-world doesn't work: no global FIR
	// data, and 41k airports would explode the call count.
	const bbox = viewportBbox();
	if (bbox && viewportTooLarge(bbox)) {
		const latH = bbox.maxLat - bbox.minLat;
		const lonW = bbox.maxLon - bbox.minLon;
		const hDeg = latH.toFixed(0);
		const wDeg = lonW.toFixed(0);
		autorouter.error = () =>
			t.errors.viewportTooLarge({ hDeg, wDeg, maxDeg: MAX_VIEWPORT_DEG_PER_SIDE });
		return;
	}

	autorouter.fetching = 'viewport';
	try {
		// Ensure reference datasets are loaded before we look up airports
		// / FIRs by viewport. Normally they are by the time the user
		// opens the panel; on a cold session they may not be.
		await Promise.all([ensureAirports(), ensureAirspaces()]);

		const { airports, firs } = viewportIcaos();
		// The exact region this fetch covers; viewportIcaos() selected its
		// airports + FIRs from this same box. Captured before the await so it
		// matches what we fetch even if the user pans while paging. A viewport
		// IS a rectangle, so here the box is the exact test and not a
		// simplification of one.
		const box = viewportBbox();
		const fetchScope: FetchScope | null = box ? { kind: 'bbox', bbox: box } : null;
		const itemas = [...airports, ...firs];
		if (itemas.length === 0) {
			autorouter.error = describeEmptyViewport();
			return;
		}

		const rows = await fetchAllNotamRows(itemas);

		// Reconstruct ICAO text per row and run it through the existing
		// parser. Same E-section coord extraction + Q-line fallback as
		// paste/upload: PSN markers (red) when the comment has parseable
		// coordinates, qualifier-line markers (blue) when it doesn't.
		// fetchScope restricts the displayed NOTAMs to those whose area of
		// effect reaches this viewport: a fetch pulls in every FIR overlapping
		// the view, and each FIR returns NOTAMs spread across its whole
		// (multi-hundred-NM) extent, so without it the map fills with NOTAMs
		// far outside the screen. briefed is null because the autorouter pulls
		// whole FIRs with no look-ahead window of its own.
		commitBriefing(
			rows
				.map(rowToIcaoText)
				.filter((s) => s.length > 0)
				.join('\n\n'),
			{ source: 'autorouter', kind: 'viewport', briefed: null, fetchScope },
		);
		// Don't fit the map: the user just picked the viewport by
		// panning, so re-centring fights their intent. The Fit button
		// in the toolbar is still there for an explicit recentre.
	} catch (e) {
		autorouter.error = errorTextOf(e);
	} finally {
		autorouter.fetching = null;
	}
}

/** Fetch NOTAMs for every drawn route: derive the airports within each route's
 *  corridor plus the FIRs each corridor crosses, union (and dedup) those ICAO
 *  sets, page through /notam for them, and gate the display to the union of the
 *  corridor bounding boxes. Parallels fetchNotamsForViewport but keyed off the
 *  routes instead of the viewport. */
export async function fetchNotamsForRoute(): Promise<void> {
	if (notamFetchBusy()) {
		return;
	}
	autorouter.error = null;
	autorouter.lastKind = 'route';

	if (!autorouter.proxyUrl) {
		autorouter.error = () => t.errors.proxyNotConfigured;
		return;
	}
	// Every route with a drawable corridor (the empty / single-waypoint ones are
	// skipped, not an error, so a half-built route doesn't block the rest).
	const drawn = routes.list.filter((r) => r.waypoints.length >= 2);
	if (drawn.length === 0) {
		autorouter.error = () => t.errors.needTwoWaypoints;
		return;
	}

	autorouter.fetching = 'route';
	try {
		// Reference datasets: airports for the corridor scan, airspaces for the
		// FIR derivation, navaids so the nav-log frequencies resolve.
		await Promise.all([ensureAirports(), ensureAirspaces(), ensureNavaids()]);

		const radius = routeSettings.corridorRadiusNM;
		// Per-route corridors, unioned: dedup the airports + FIRs (a shared one
		// is fetched once) and envelope the corridor boxes for the display gate.
		const { airports, firs } = unionRouteIcaos(
			drawn.map((r) => routeIcaos(r.waypoints, radius)),
		);
		const fetchScope: FetchScope = {
			kind: 'corridor',
			tracks: drawn.map((r) => r.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }))),
			halfWidthNM: radius,
		};
		const itemas = [...airports, ...firs];
		if (itemas.length === 0) {
			autorouter.error = () => t.errors.corridorEmpty;
			return;
		}

		const rows = await fetchAllNotamRows(itemas);
		// fetchScope gates the displayed NOTAMs to the union of the corridors,
		// by the SAME point-to-polyline test that selected the airports above.
		// It used to be the union of their bounding boxes, which on a long
		// diagonal route showed NOTAMs in the box corners well beyond the
		// radius: the selection was exact and the display was not.
		commitBriefing(
			rows
				.map(rowToIcaoText)
				.filter((s) => s.length > 0)
				.join('\n\n'),
			{ source: 'autorouter', kind: 'route', briefed: null, fetchScope },
		);
	} catch (e) {
		autorouter.error = errorTextOf(e);
	} finally {
		autorouter.fetching = null;
	}
}

/** The FIRs the named aerodromes sit in. The fallback for a briefing whose
 *  idents this app's own airports dataset does not carry, so no track can be
 *  drawn through them: an aerodrome briefing that omitted the enroute NOTAMs
 *  of its own FIR would not be one. */
function firsForAerodromes(idents: readonly string[]): string[] {
	const all = getAirspaces();
	if (!all) {
		return [];
	}
	// A local dedup index, not reactive state.
	const out = new Set<string>();
	for (const ident of idents) {
		const ap = airportByIdent(ident);
		if (!ap) {
			continue;
		}
		for (const sp of airspacesOver(all, ap.lat, ap.lon)) {
			const id = sp.id.toUpperCase();
			if (sp.category === 'fir' && /^[A-Z]{4}$/.test(id)) {
				out.add(id);
			}
		}
	}
	return [...out];
}

/** Fetch NOTAMs for a list of aerodrome idents, plus the FIRs they sit in.
 *
 *  The one autorouter path that needs neither a map viewport nor a route
 *  workspace, which is what a NOTAM viewer has. Unknown idents are still
 *  asked for: the airports dataset is this app's, not the service's, and a
 *  field it does not carry may well be briefed.
 *
 *  The rule behind the display gate, worth stating once: fetchScope is set
 *  when the source returns MORE than was asked for, never when it returns
 *  exactly what was asked for. A corridor request does over-return, because
 *  autorouter answers whole FIRs, so this commits the corridor it briefed;
 *  a briefing too short to draw one commits null and shows whole, every row
 *  of it having been asked for by name. */
export async function fetchNotamsForIdents(idents: readonly string[]): Promise<void> {
	if (notamFetchBusy()) {
		return;
	}
	autorouter.error = null;
	autorouter.lastKind = 'aerodromes';

	if (!autorouter.proxyUrl) {
		autorouter.error = () => t.errors.proxyNotConfigured;
		return;
	}
	if (idents.length === 0) {
		autorouter.error = () => t.errors.needAerodrome;
		return;
	}

	autorouter.fetching = 'aerodromes';
	try {
		// Airports to place the idents and resolve the A)-ident links;
		// airspaces for the FIR containment and the airspace links. Not
		// navaids: those are the nav log's need and this app has none.
		await Promise.all([ensureAirports(), ensureAirspaces()]);

		// The TRACK the named aerodromes describe, in the order they were
		// named. With it the briefing is the same shape SOFIA answers for the
		// same question: the aerodromes ALONG the corridor, not only the two
		// typed, and the FIRs the corridor actually crosses.
		const track = idents
			.map((i) => airportByIdent(i))
			.filter((a): a is NonNullable<typeof a> => a !== null)
			.map((a) => ({ lat: a.lat, lon: a.lon }));
		const corridor = track.length >= 2 ? routeIcaos(track, DEFAULT_CORRIDOR_RADIUS_NM) : null;

		// Every ident is asked for by name whether or not it placed: the
		// airports dataset is this app's, not the service's, and a field it
		// does not carry may well be briefed.
		const named = idents.map((i) => i.toUpperCase());
		const itemas = [
			...new Set(
				corridor
					? [...named, ...corridor.airports, ...corridor.firs]
					: [...named, ...firsForAerodromes(idents)],
			),
		];

		// The gate follows the rule: a scope is set when the source returns MORE
		// than was asked for. A corridor request does, because autorouter
		// answers whole FIRs; without it a 170 NM track answers with every
		// NOTAM in two entire FIRs. It is the corridor itself, so what shows is
		// what SOFIA would have briefed for the same track. Without a track
		// there is nothing to gate against.
		const fetchScope: FetchScope | null =
			track.length >= 2
				? { kind: 'corridor', tracks: [track], halfWidthNM: DEFAULT_CORRIDOR_RADIUS_NM }
				: null;

		const rows = await fetchAllNotamRows(itemas);
		commitBriefing(
			rows
				.map(rowToIcaoText)
				.filter((s) => s.length > 0)
				.join('\n\n'),
			{ source: 'autorouter', kind: 'aerodromes', briefed: null, fetchScope },
		);
	} catch (e) {
		autorouter.error = errorTextOf(e);
	} finally {
		autorouter.fetching = null;
	}
}

async function fetchAllNotamRows(itemas: string[]): Promise<AutorouterRow[]> {
	const nowSec = Math.floor(Date.now() / 1000);
	const endSec = nowSec + VALIDITY_WINDOW_DAYS * 86400;
	const limit = 100;

	const all: AutorouterRow[] = [];
	// Chunk the ICAO list so the API can't silently drop entries past an
	// undocumented cutoff. Each chunk paginates independently via offset.
	for (let i = 0; i < itemas.length; i += ITEMAS_CHUNK_SIZE) {
		const chunk = itemas.slice(i, i + ITEMAS_CHUNK_SIZE);
		all.push(...(await fetchChunk(chunk, nowSec, endSec, limit)));
	}
	// parseNotams dedupes by NOTAM id at the parse step, so the same
	// NOTAM returned by two chunks (e.g. AE-scope on both an airport and
	// its FIR) collapses to one entry downstream.
	return all;
}

async function fetchChunk(
	chunk: string[],
	startSec: number,
	endSec: number,
	limit: number,
): Promise<AutorouterRow[]> {
	const out: AutorouterRow[] = [];
	let offset = 0;
	for (;;) {
		const url =
			proxyBase() +
			'/notam?' +
			new URLSearchParams({
				itemas: JSON.stringify(chunk),
				limit: String(limit),
				offset: String(offset),
				startvalidity: String(startSec),
				endvalidity: String(endSec),
			}).toString();
		const data = await getJson<{ total?: number; rows?: AutorouterRow[] }>(url);
		const rows = data.rows ?? [];
		out.push(...rows);
		offset += rows.length;
		if (rows.length === 0) {
			break;
		}
		const total = data.total;
		if (typeof total === 'number' && offset >= total) {
			break;
		}
		// Guard against runaway loops if total isn't returned.
		if (offset >= 5000) {
			break;
		}
	}
	return out;
}
