/* Live weather (METAR / TAF) session cache. Follows the data.svelte.ts
 * ensure pattern: reactive status records keyed by airport ident, module
 * level in-flight promises for dedup, a soft TTL, and read accessors that
 * never write. Two record kinds: the airport's OWN station (the detail
 * panel's Weather section, METAR + TAF by ident) and the NEAREST station
 * around a position (the flight-prep performance defaults, plus the panel's
 * fallback for aerodromes without a METAR). Everything is ephemeral: the
 * fetched values are read-time defaults and are never persisted. Every
 * fetch is disabled by the Display tab's "Live weather" preference.
 *
 * The two kinds part company on FAILURE, deliberately. A nearest record keeps
 * its last observation across a failed refresh, because it feeds computation
 * defaults (the flight-prep performance grid) and an observation goes stale by
 * its own age, never by the state of the request that would have replaced it;
 * its readers annotate the failure. An own-station record clears, because its
 * panel renders the observation first and a retained one would hide the
 * outage. */

import {
	fetchMetarsByBbox,
	fetchMetarsByIds,
	fetchTafs,
	type AwcMetar,
	type AwcTaf,
} from '$lib/weather/awc';
import {
	isMetarCapableIdent,
	latestByStation,
	nearestMetar,
	nearestSearchBbox,
	usableForDefaults,
	type NearestPick,
} from '$lib/weather/metar';
import { display } from './display.svelte';
import { isFresh } from './asyncCache';

/** Records older than this refetch on the next ensure. */
const TTL_MS = 5 * 60_000;

export type WxStatus = 'loading' | 'ok' | 'error';

export interface AirportWx {
	status: WxStatus;
	/** Latest observation of the airport's own station; null with status
	 *  'ok' = the ident has no METAR station. */
	metar: AwcMetar | null;
	/** The station's TAF; null when it publishes none. */
	taf: AwcTaf | null;
	fetchedAt: number;
}

export interface NearestWx {
	status: WxStatus;
	/** The nearest reporting station within the lookup cap; null with
	 *  status 'ok' = nothing reports within range. */
	metar: AwcMetar | null;
	distanceM: number | null;
	fetchedAt: number;
}

export const weatherState = $state<{
	byIdent: Record<string, AirportWx>;
	nearest: Record<string, NearestWx>;
}>({
	byIdent: {},
	nearest: {},
});

// In-flight dedup + the nearest lookup's anchor; plain module collections,
// deliberately non-reactive (the reactive face is weatherState).
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const inflight = new Map<string, Promise<void>>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const nearestAnchor = new Map<string, { lat: number; lon: number }>();

function fresh(rec: { fetchedAt: number } | undefined): boolean {
	return rec != null && isFresh(rec.fetchedAt, TTL_MS);
}

/** The airport's own-station record (no write on read). */
export function airportWx(ident: string): AirportWx | null {
	return weatherState.byIdent[ident] ?? null;
}

/** The nearest-station record for an aerodrome (no write on read). */
export function nearestWx(ident: string): NearestWx | null {
	return weatherState.nearest[ident] ?? null;
}

/** The record's observation when it may supply flight-prep defaults: present,
 *  close enough and fresh enough (usableForDefaults, 50 NM / 180 min). The
 *  fetch STATUS is deliberately not part of the test. A refetch in flight and
 *  a failed refresh both keep the observation they had, and an observation is
 *  stale by its own age, not by the request that would replace it; gating on
 *  the status instead is what used to blank a whole performance grid for the
 *  length of a TTL refresh, print included. */
export function usableNearest(rec: NearestWx | null, nowMs: number): NearestPick | null {
	if (!rec?.metar || rec.distanceM == null) {
		return null;
	}
	const pick = { metar: rec.metar, distanceM: rec.distanceM };
	return usableForDefaults(pick, nowMs) ? pick : null;
}

/** Fetch the ident's own METAR + TAF unless a fresh record or an in-flight
 *  fetch already covers it. Reactive on display.liveWeather and on the
 *  record, so calling effects re-run when the toggle flips or the fetch
 *  lands. */
export function ensureAirportWx(ident: string): void {
	if (!display.liveWeather) {
		return;
	}
	const key = `own:${ident}`;
	if (inflight.has(key) || fresh(weatherState.byIdent[ident])) {
		return;
	}
	if (!isMetarCapableIdent(ident)) {
		// A local-code ident (FR-JCA, LF5722) can never name a station; the
		// worker would reject it anyway. Settle as "no METAR" without a
		// fetch so the panel moves straight to the nearest-station card.
		weatherState.byIdent[ident] = { status: 'ok', metar: null, taf: null, fetchedAt: Date.now() };
		return;
	}
	startAirportWx(ident, key);
}

function startAirportWx(ident: string, key: string): void {
	weatherState.byIdent[ident] = {
		status: 'loading',
		metar: weatherState.byIdent[ident]?.metar ?? null,
		taf: weatherState.byIdent[ident]?.taf ?? null,
		fetchedAt: weatherState.byIdent[ident]?.fetchedAt ?? 0,
	};
	const p = (async () => {
		try {
			const [metars, tafs] = await Promise.all([
				fetchMetarsByIds([ident]),
				fetchTafs([ident]),
			]);
			weatherState.byIdent[ident] = {
				status: 'ok',
				metar: latestByStation(metars).find((m) => m.icaoId === ident) ?? null,
				taf: tafs.find((t) => t.icaoId === ident) ?? null,
				fetchedAt: Date.now(),
			};
		} catch {
			weatherState.byIdent[ident] = {
				status: 'error',
				metar: null,
				taf: null,
				fetchedAt: Date.now(),
			};
		} finally {
			inflight.delete(key);
		}
	})();
	inflight.set(key, p);
}

/** Fetch the stations around an aerodrome and record the nearest one,
 *  unless fresh or in flight. The position is the airport's, read once per
 *  fetch (aerodromes don't move). */
export function ensureNearestMetar(ident: string, lat: number, lon: number): void {
	if (!display.liveWeather) {
		return;
	}
	const key = `near:${ident}`;
	if (inflight.has(key) || fresh(weatherState.nearest[ident])) {
		return;
	}
	nearestAnchor.set(ident, { lat, lon });
	startNearestMetar(ident, key, lat, lon);
}

function startNearestMetar(ident: string, key: string, lat: number, lon: number): void {
	weatherState.nearest[ident] = {
		status: 'loading',
		metar: weatherState.nearest[ident]?.metar ?? null,
		distanceM: weatherState.nearest[ident]?.distanceM ?? null,
		fetchedAt: weatherState.nearest[ident]?.fetchedAt ?? 0,
	};
	const bbox = nearestSearchBbox(lat, lon);
	const p = (async () => {
		try {
			const metars = await fetchMetarsByBbox(bbox);
			const pick = nearestMetar(metars, lat, lon);
			weatherState.nearest[ident] = {
				status: 'ok',
				metar: pick?.metar ?? null,
				distanceM: pick?.distanceM ?? null,
				fetchedAt: Date.now(),
			};
		} catch {
			// The observation outlives the failed refresh (the tile cache's own
			// rule, state/metarStations.svelte.ts): dropping it turned one 502
			// into a whole performance grid silently reverting to ISA.
			weatherState.nearest[ident] = {
				status: 'error',
				metar: weatherState.nearest[ident]?.metar ?? null,
				distanceM: weatherState.nearest[ident]?.distanceM ?? null,
				fetchedAt: Date.now(),
			};
		} finally {
			inflight.delete(key);
		}
	})();
	inflight.set(key, p);
}

/** Record a pick the caller has already fetched (the print prefetch's own area
 *  query in weather/tripWx.ts, which runs the identical nearestSearchBbox +
 *  nearestMetar recipe), so the printed weather annex and the performance grid
 *  quote ONE observation and the print document's own mount finds the record
 *  fresh instead of starting a fetch that cannot land in time.
 *
 *  docs/metar-stations.md's decision NOT to hydrate this module from the map's
 *  tile feed does not reach here: what it protects is the own-station record's
 *  TAF, which a tile observation cannot carry and a fresh-looking record would
 *  hide. A nearest record carries no TAF, and this pick comes off the same
 *  query the ensure would have made.
 *
 *  An EMPTY pick (nothing reports within range) is adopted only over a record
 *  with no usable observation of its own, so a query that came back empty can
 *  never delete a good one; a FAILED lookup is not adopted at all (the caller
 *  skips it), leaving the session record as it stands. */
export function adoptNearestMetar(
	ident: string,
	lat: number,
	lon: number,
	pick: NearestPick | null,
	fetchedAtMs: number,
): void {
	if (!pick && usableNearest(weatherState.nearest[ident] ?? null, fetchedAtMs)) {
		return;
	}
	// The refresh buttons refetch from the anchor, so an adopted ident needs one
	// or it drops out of every later refresh.
	nearestAnchor.set(ident, { lat, lon });
	weatherState.nearest[ident] = {
		status: 'ok',
		metar: pick?.metar ?? null,
		distanceM: pick?.distanceM ?? null,
		fetchedAt: fetchedAtMs,
	};
}

/** Refetch every record now (the refresh buttons). The 60 s edge / browser
 *  cache still bounds the upstream rate. */
export function refreshWeather(): void {
	if (!display.liveWeather) {
		return;
	}
	for (const ident of Object.keys(weatherState.byIdent)) {
		const key = `own:${ident}`;
		if (!inflight.has(key)) {
			startAirportWx(ident, key);
		}
	}
	for (const ident of Object.keys(weatherState.nearest)) {
		const key = `near:${ident}`;
		const anchor = nearestAnchor.get(ident);
		if (anchor && !inflight.has(key)) {
			startNearestMetar(ident, key, anchor.lat, anchor.lon);
		}
	}
}
