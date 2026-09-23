/* Loader and types for the static worldwide METAR station catalog
 * (public/data/metar-stations.json), built by cmd/metar from NOAA AWC's
 * stationinfo API. The catalog supplies canonical station metadata
 * (position, name, ICAO / IATA / FAA / WMO ids, country, elevation, METAR /
 * TAF capability) that MetarStationDetail joins onto the live /wx observation
 * BY IDENT. The live METAR / TAF feed (weather.svelte.ts) and the map's
 * observed-weather draw (metarLayer.ts) are unchanged; this is a metadata
 * layer, not a draw source. Same shape as data/navaids.ts: positional rows,
 * mirroring cmd/metar/build.go. */

export interface MetarStation {
	/** The ident the live /wx feed serves the station under: the ICAO id, or a
	 *  numeric WMO id for platform stations. Matches AwcMetar.icaoId. */
	icaoId: string;
	/** IATA code, or '' when none. */
	iata: string;
	/** FAA location id (US stations), or ''. */
	faa: string;
	/** WMO / SYNOP number, or ''. */
	wmo: string;
	/** Site name, e.g. "London/Heathrow Intl". */
	site: string;
	lat: number;
	lon: number;
	/** Station elevation in METRES MSL (the AWC unit, like AwcMetar.elev;
	 *  convert to feet at the display edge), or null when the feed omitted it. */
	elevM: number | null;
	/** ISO country code, e.g. "GB". */
	country: string;
	/** State / region code, e.g. "EN" / "CO"; '' when none. */
	region: string;
	/** True when the station also issues a TAF (siteType includes TAF). */
	taf: boolean;
}

// Positional row layout, matching outputFields in cmd/metar/build.go. Keep the
// two in lockstep; index 10 (priority) is emitted but unused by the UI.
type MetarStationRow = readonly [
	icaoId: string,
	iata: string,
	faa: string,
	wmo: string,
	site: string,
	lat: number,
	lon: number,
	elev: number | null,
	country: string,
	region: string,
	priority: number,
	taf: boolean,
];

interface RawMetarStations {
	fields: string[];
	rows: readonly MetarStationRow[];
}

function rowToMetarStation(r: MetarStationRow): MetarStation {
	return {
		icaoId: r[0],
		iata: r[1] ?? '',
		faa: r[2] ?? '',
		wmo: r[3] ?? '',
		site: r[4] ?? '',
		lat: r[5],
		lon: r[6],
		elevM: r[7],
		country: r[8] ?? '',
		region: r[9] ?? '',
		taf: r[11] ?? false,
	};
}

export const METAR_STATIONS_URL = '/data/metar-stations.json';

/** Load the METAR station catalog. Fail-soft: an HTTP error OR a non-JSON
 *  200 (Vite dev's SPA fallback, or the file simply not committed yet)
 *  returns [] so the map's live observations still render. */
export async function loadMetarStations(
	url: string = METAR_STATIONS_URL,
): Promise<MetarStation[]> {
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`${url}: HTTP ${res.status}`);
		return [];
	}
	const ct = res.headers.get('content-type') ?? '';
	if (!ct.includes('json')) {
		console.warn(`${url}: not JSON (got ${ct || 'no content-type'})`);
		return [];
	}
	const data = (await res.json()) as RawMetarStations;
	return data.rows.map(rowToMetarStation);
}
