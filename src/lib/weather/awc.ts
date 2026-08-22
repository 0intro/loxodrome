/* NOAA Aviation Weather Center data API: response types (verified against
 * the live JSON) and thin fetch wrappers over the notam-proxy /wx routes.
 * The proxy exists because aviationweather.gov sends no CORS headers; see
 * notam-proxy/worker.js handleWx. Pure helpers over the decoded values live
 * in ./metar.ts; the session cache in $lib/state/weather.svelte.ts. */

import { proxyBase } from '$lib/autorouter/state.svelte';

/** One cloud group of a METAR or TAF forecast period. */
export interface AwcCloud {
	/** FEW / SCT / BKN / OVC / NSC / CLR ... */
	cover: string;
	/** Base AGL in feet; null for NSC-like groups. */
	base: number | null;
}

/** One observation from /api/data/metar?format=json (the fields the app
 *  reads; the API sends more). Units as delivered: temp / dewp degC, wdir
 *  degrees TRUE (or 'VRB'), wspd / wgst kt, visib statute miles (number or
 *  a '6+' / '10+' string), altim hPa (already converted from inHg for US
 *  stations), obsTime epoch seconds. */
export interface AwcMetar {
	icaoId: string;
	obsTime: number;
	temp?: number | null;
	dewp?: number | null;
	wdir?: number | 'VRB' | null;
	wspd?: number | null;
	wgst?: number | null;
	visib?: number | string | null;
	altim?: number | null;
	wxString?: string | null;
	/** AWC's precomputed flight category. Withheld upstream (absent) when a
	 *  sensor failure leaves the ceiling unknown (raw '/////////'), which is
	 *  exactly why the client reads it rather than classifying locally. */
	fltCat?: 'VFR' | 'MVFR' | 'IFR' | 'LIFR' | null;
	/** 'METAR' or 'SPECI'. */
	metarType?: string | null;
	rawOb: string;
	lat: number;
	lon: number;
	/** Station elevation in METRES MSL (the AWC feed's unit; the rest of the
	 *  app works in feet, so convert at the display edge). */
	elev?: number | null;
	name?: string | null;
	clouds?: AwcCloud[];
	/** Present when the metar endpoint is asked for taf=true. */
	rawTaf?: string | null;
}

/** One forecast period of a decoded TAF. */
export interface AwcTafPeriod {
	timeFrom: number;
	timeTo: number;
	/** FM / BECMG / TEMPO; null for the base period. */
	fcstChange?: string | null;
	probability?: number | null;
}

/** One TAF from /api/data/taf?format=json. */
export interface AwcTaf {
	icaoId: string;
	/** Validity, epoch seconds. */
	validTimeFrom: number;
	validTimeTo: number;
	rawTAF: string;
	fcsts?: AwcTafPeriod[];
}

/** A latitude / longitude box for the area METAR query. */
export interface WxBbox {
	minLat: number;
	minLon: number;
	maxLat: number;
	maxLon: number;
}

/** Hung requests must settle: a record stuck in 'loading' blocks its
 *  in-flight slot (and with it the refresh button) forever. */
const FETCH_TIMEOUT_MS = 15_000;

async function wxFetch<T>(
	endpoint: 'metar' | 'taf' | 'isigmet' | 'airsigmet',
	params: URLSearchParams,
): Promise<T[]> {
	const res = await fetch(`${proxyBase()}/wx/${endpoint}?${params.toString()}`, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) {
		// A SIGMET 404 means the deployed worker predates the endpoint (the
		// /wx precedent: the user must redeploy notam-proxy).
		const sigmet = endpoint === 'isigmet' || endpoint === 'airsigmet';
		// i18n-ignore-start: wire / operator-deploy diagnostics, stay EN (docs/i18n.md rule 7)
		throw new Error(
			res.status === 404 && sigmet
				? 'Deploy the updated notam-proxy worker to enable SIGMETs.'
				: `weather fetch failed: ${res.status}`,
		);
		// i18n-ignore-end
	}
	// An ident with no station answers 204 / an empty body upstream; treat
	// it as the empty list rather than a JSON parse error.
	const text = await res.text();
	if (!text.trim()) {
		return [];
	}
	const body = JSON.parse(text) as T[];
	return Array.isArray(body) ? body : [];
}

/** Latest METARs for an ident list; idents without a METAR station are
 *  silently absent from the result. */
export function fetchMetarsByIds(idents: readonly string[]): Promise<AwcMetar[]> {
	return wxFetch<AwcMetar>('metar', new URLSearchParams({ ids: idents.join(',') }));
}

/** Latest METARs of every station inside the box. */
export function fetchMetarsByBbox(bbox: WxBbox): Promise<AwcMetar[]> {
	const v = [bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon];
	return wxFetch<AwcMetar>(
		'metar',
		new URLSearchParams({ bbox: v.map((n) => n.toFixed(2)).join(',') }),
	);
}

/** Latest TAFs for an ident list; idents without a TAF are absent. */
export function fetchTafs(idents: readonly string[]): Promise<AwcTaf[]> {
	return wxFetch<AwcTaf>('taf', new URLSearchParams({ ids: idents.join(',') }));
}

/** One international SIGMET from /api/data/isigmet?format=json (fields
 *  verified against the live JSON). Altitudes are FEET (FL x 100), base
 *  null = unbounded below; validity epoch seconds; `coords` may be absent
 *  on a FIR-wide advisory. */
export interface AwcIsigmet {
	icaoId: string;
	firId?: string | null;
	firName?: string | null;
	seriesId?: string | null;
	hazard?: string | null;
	/** SEV / EMBD / FRQ / ISOL / OBSC, a volcano or cyclone name, or ''. */
	qualifier?: string | null;
	base?: number | null;
	top?: number | null;
	/** 'AREA' or 'AREAS'. */
	geom?: string | null;
	coords?: { lat: number; lon: number }[] | null;
	dir?: number | null;
	spd?: number | null;
	validTimeFrom: number;
	validTimeTo: number;
	rawSigmet?: string | null;
}

/** One US SIGMET from /api/data/airsigmet?format=json (parallel schema,
 *  different names; nulls in the altitude pairs mean surface / unbounded). */
export interface AwcAirsigmet {
	icaoId: string;
	airSigmetType?: string | null;
	seriesId?: string | null;
	hazard?: string | null;
	severity?: number | null;
	altitudeLow1?: number | null;
	altitudeLow2?: number | null;
	altitudeHi1?: number | null;
	altitudeHi2?: number | null;
	movementDir?: number | null;
	movementSpd?: number | null;
	coords?: { lat: number; lon: number }[] | null;
	validTimeFrom: number;
	validTimeTo: number;
	rawAirSigmet?: string | null;
}

/** The worldwide active international SIGMET set (one small global feed). */
export function fetchIsigmets(): Promise<AwcIsigmet[]> {
	return wxFetch<AwcIsigmet>('isigmet', new URLSearchParams());
}

/** The active US SIGMET set. */
export function fetchAirsigmets(): Promise<AwcAirsigmet[]> {
	return wxFetch<AwcAirsigmet>('airsigmet', new URLSearchParams());
}
