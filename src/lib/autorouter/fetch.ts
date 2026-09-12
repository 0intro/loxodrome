/* Top-level fetch orchestrator: validate inputs, derive the ICAO list from
 * the current viewport, page through /notam, hand the rows to the parser.
 *
 * The transport (autorouter -> proxy -> proxied JSON) is in session.ts;
 * the viewport math is in viewport.ts; this module is the user-visible
 * action behind the NotamLoader's "Fetch this view" row. */

import { t } from '$lib/state/i18n.svelte';
import { errorTextOf } from '$lib/i18n/errorText';
import { rowToIcaoText, type AutorouterRow } from './client';
import { getJson } from './session';
import { autorouter, proxyBase } from './state.svelte';
import {
	MAX_VIEWPORT_DEG_PER_SIDE,
	describeEmptyViewport,
	routeCorridorBbox,
	routeIcaos,
	unionBboxes,
	unionRouteIcaos,
	viewportBbox,
	viewportIcaos,
	viewportTooLarge,
} from './viewport';
import { ensureAirports, ensureAirspaces, ensureNavaids } from '$lib/state/data.svelte';
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
		// matches what we fetch even if the user pans while paging.
		const fetchBbox = viewportBbox();
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
		// fetchBbox restricts the displayed NOTAMs to those whose area of
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
			{ source: 'autorouter', kind: 'viewport', briefed: null, fetchBbox },
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
		const fetchBbox = unionBboxes(drawn.map((r) => routeCorridorBbox(r.waypoints, radius)));
		const itemas = [...airports, ...firs];
		if (itemas.length === 0) {
			autorouter.error = () => t.errors.corridorEmpty;
			return;
		}

		const rows = await fetchAllNotamRows(itemas);
		// fetchBbox gates the displayed NOTAMs to the union of the corridor
		// bounding boxes. They are axis-aligned, so a long diagonal route can
		// still show NOTAMs in the box corners beyond the radius; the airport
		// selection above used the true point-to-polyline corridor distance.
		commitBriefing(
			rows
				.map(rowToIcaoText)
				.filter((s) => s.length > 0)
				.join('\n\n'),
			{ source: 'autorouter', kind: 'route', briefed: null, fetchBbox },
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
