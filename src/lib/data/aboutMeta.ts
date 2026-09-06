/* Loader for the About modal's data-source metadata: one Promise.all over
 * every per-publisher meta sidecar. Overlay and per-country metas are
 * optional (a fresh clone may lack them), so each is caught to null and
 * blanks just its own card. The modal owns the in-flight race guard; this
 * module only fetches and assembles. */

import {
	loadFrenchAirspacesMeta,
	loadFrenchAirspacesNextMeta,
	loadAirportsMeta,
	loadFrAirportsMeta,
	loadFrAirportsNextMeta,
	loadPruatlasFirsMeta,
	loadFaaAirspacesMeta,
	loadFaaAirportsMeta,
	loadFacilitiesMeta,
	loadBeFacilitiesMeta,
	loadDeFacilitiesMeta,
	loadUkFacilitiesMeta,
	loadEsFacilitiesMeta,
	loadGeFacilitiesMeta,
	loadFaaNavaidsMeta,
	loadFaaObstaclesMeta,
	loadGeAirspacesMeta,
	loadGeAirportsMeta,
	loadGeNavaidsMeta,
	loadNlAirspacesMeta,
	loadNlAirportsMeta,
	loadNlNavaidsMeta,
	loadChObstaclesMeta,
	loadFiObstaclesMeta,
	loadItAirspacesMeta,
	loadItAirportsMeta,
	loadItNavaidsMeta,
	loadObstaclesMeta,
	loadNavaidsMeta,
	loadUkAirspacesMeta,
	loadUkAirportsMeta,
	loadUkObstaclesMeta,
	loadUkNavaidsMeta,
	loadSkAirspacesMeta,
	loadIeAirspacesMeta,
	loadSkNavaidsMeta,
	loadIeNavaidsMeta,
	loadRsAirspacesMeta,
	loadRsNavaidsMeta,
	loadXkAirspacesMeta,
	loadEsAirspacesMeta,
	loadEsAirportsMeta,
	loadEsObstaclesMeta,
	loadEsNavaidsMeta,
	loadBeAirspacesMeta,
	loadBeAirportsMeta,
	loadBeObstaclesMeta,
	loadBeNavaidsMeta,
	loadBeNatureMeta,
	loadNatureMeta,
	loadItNatureMeta,
	loadBeSupAipMeta,
	loadEsSupAipMeta,
	loadDeAirspacesMeta,
	loadDeAirportsMeta,
	loadDeObstaclesMeta,
	loadDeNavaidsMeta,
	loadAtAirspacesMeta,
	loadAtAirportsMeta,
	loadAtObstaclesMeta,
	loadAtNavaidsMeta,
	loadAtAdChartsMeta,
	loadUkAdChartsMeta,
	loadUsAdChartsMeta,
	loadDeAdChartsMeta,
	loadSupAipMeta,
	loadFrAdChartsMeta,
	loadFrVacGeoMeta,
	loadAircraftMeta,
	loadMetarStationsMeta,
	loadFaaDesignatorsMeta,
	type FrenchAirspacesMeta,
	type AirportsMeta,
	type FrAirportsMeta,
	type PruatlasFirsMeta,
	type FaaAirspacesMeta,
	type ObstaclesMeta,
	type NavaidsMeta,
	type AixmAirspacesMeta,
	type AixmAirportsMeta,
	type AixmObstaclesMeta,
	type AixmNavaidsMeta,
	type SupAipMeta,
	type FrAdChartsMeta,
	type FrVacGeoMeta,
	type AtAdChartsMeta,
	type UkAdChartsMeta,
	type UsAdChartsMeta,
	type DeAdChartsMeta,
	type NatureMeta,
	type FacilitiesMeta,
	type AircraftMeta,
	type MetarStationsMeta,
	type FaaDesignatorsMeta,
} from './meta';

/** The AIXM 5.x publisher countries the About modal renders one card each
 *  for. This is the FETCH order, not the card order: AboutModal owns the
 *  order the cards appear in, and the two have never matched. Anything
 *  reading this list wants "which publishers have a per-country meta
 *  record", which is what it means. */
export const AIXM_COUNTRIES = ['uk', 'be', 'de', 'at', 'es', 'ge', 'nl', 'it', 'sk', 'ie', 'rs', 'xk'] as const;
export type AixmCountry = (typeof AIXM_COUNTRIES)[number];

/** One AIXM publisher's dataset sidecars, each null when absent.
 *  `facilities` is the AD 2 aerodrome directory (services, fuel,
 *  customs, hours), which only the publishers carrying typed
 *  annotations produce. */
export interface AixmCountryMeta {
	airspaces: AixmAirspacesMeta | null;
	airports: AixmAirportsMeta | null;
	obstacles: AixmObstaclesMeta | null;
	navaids: AixmNavaidsMeta | null;
	facilities: FacilitiesMeta | null;
}

// Per-country sidecar loaders behind `aixm`; all optional, so a fresh
// clone before a country's first workflow run blanks just that card. A
// null loader means the publisher does not carry that dataset at all,
// which is a different thing from a sidecar that failed to load, and
// saves a pointless 404 on every About open.
const AIXM_META_LOADERS: Record<
	AixmCountry,
	{ [K in keyof AixmCountryMeta]: (() => Promise<AixmCountryMeta[K]>) | null }
> = {
	uk: {
		airspaces: loadUkAirspacesMeta,
		airports: loadUkAirportsMeta,
		obstacles: loadUkObstaclesMeta,
		navaids: loadUkNavaidsMeta,
		facilities: loadUkFacilitiesMeta,
	},
	be: {
		airspaces: loadBeAirspacesMeta,
		airports: loadBeAirportsMeta,
		obstacles: loadBeObstaclesMeta,
		navaids: loadBeNavaidsMeta,
		facilities: loadBeFacilitiesMeta,
	},
	de: {
		airspaces: loadDeAirspacesMeta,
		airports: loadDeAirportsMeta,
		obstacles: loadDeObstaclesMeta,
		navaids: loadDeNavaidsMeta,
		facilities: loadDeFacilitiesMeta,
	},
	at: {
		airspaces: loadAtAirspacesMeta,
		airports: loadAtAirportsMeta,
		obstacles: loadAtObstaclesMeta,
		navaids: loadAtNavaidsMeta,
		facilities: null,
	},
	// Georgia's obstacles are a separate product, not part of the AIP
	// data set, so there is no sidecar for them to load.
	ge: {
		airspaces: loadGeAirspacesMeta,
		airports: loadGeAirportsMeta,
		obstacles: null,
		navaids: loadGeNavaidsMeta,
		facilities: loadGeFacilitiesMeta,
	},
	// LVNL publishes no obstacle dataset.
	nl: {
		airspaces: loadNlAirspacesMeta,
		airports: loadNlAirportsMeta,
		obstacles: null,
		navaids: loadNlNavaidsMeta,
		facilities: null,
	},
	// The Italian OFMX snapshot carries no obstacles.
	it: {
		airspaces: loadItAirspacesMeta,
		airports: loadItAirportsMeta,
		obstacles: null,
		navaids: loadItNavaidsMeta,
		facilities: null,
	},
	sk: {
		airspaces: loadSkAirspacesMeta,
		airports: null,
		obstacles: null,
		navaids: loadSkNavaidsMeta,
		facilities: null,
	},
	ie: {
		airspaces: loadIeAirspacesMeta,
		airports: null,
		obstacles: null,
		navaids: loadIeNavaidsMeta,
		facilities: null,
	},
	rs: {
		airspaces: loadRsAirspacesMeta,
		airports: null,
		obstacles: null,
		navaids: loadRsNavaidsMeta,
		facilities: null,
	},
	xk: {
		airspaces: loadXkAirspacesMeta,
		airports: null,
		obstacles: null,
		// KANS publishes ENR 4.1 and it reads NIL, so there is no navaid
		// dataset to credit.
		navaids: null,
		facilities: null,
	},
	es: {
		airspaces: loadEsAirspacesMeta,
		airports: loadEsAirportsMeta,
		obstacles: loadEsObstaclesMeta,
		navaids: loadEsNavaidsMeta,
		facilities: loadEsFacilitiesMeta,
	},
};

async function loadAixmCountryMeta(country: AixmCountry): Promise<AixmCountryMeta> {
	const l = AIXM_META_LOADERS[country];
	const load = <T>(f: (() => Promise<T | null>) | null): Promise<T | null> =>
		f ? f().catch(() => null) : Promise.resolve(null);
	const [airspaces, airports, obstacles, navaids, facilities] = await Promise.all([
		load(l.airspaces),
		load(l.airports),
		load(l.obstacles),
		load(l.navaids),
		load(l.facilities),
	]);
	return { airspaces, airports, obstacles, navaids, facilities };
}

/** Every data-source meta the About modal renders. The French airspaces
 *  and worldwide airports metas are required; the rest are nullable, a
 *  missing sidecar blanks its card without breaking the modal. The AIXM
 *  publisher countries live under `aixm`, one record each. */
export interface AboutMeta {
	french: FrenchAirspacesMeta;
	frenchNext: FrenchAirspacesMeta | null;
	airports: AirportsMeta;
	frAirports: FrAirportsMeta | null;
	frAirportsNext: FrAirportsMeta | null;
	frFacilities: FacilitiesMeta | null;
	frNature: NatureMeta | null;
	itNature: NatureMeta | null;
	pruatlas: PruatlasFirsMeta | null;
	faa: FaaAirspacesMeta | null;
	faaAirports: AixmAirportsMeta | null;
	faaNavaids: AixmNavaidsMeta | null;
	faaObstacles: AixmObstaclesMeta | null;
	chObstacles: AixmObstaclesMeta | null;
	fiObstacles: AixmObstaclesMeta | null;
	obstacles: ObstaclesMeta | null;
	navaids: NavaidsMeta | null;
	aixm: Record<AixmCountry, AixmCountryMeta>;
	beNature: NatureMeta | null;
	beSupaip: SupAipMeta | null;
	esSupaip: SupAipMeta | null;
	atAdCharts: AtAdChartsMeta | null;
	supaip: SupAipMeta | null;
	frAdCharts: FrAdChartsMeta | null;
	frVacGeo: FrVacGeoMeta | null;
	ukAdCharts: UkAdChartsMeta | null;
	usAdCharts: UsAdChartsMeta | null;
	deAdCharts: DeAdChartsMeta | null;
	aircraft: AircraftMeta | null;
	metarStations: MetarStationsMeta | null;
	faaDesignators: FaaDesignatorsMeta | null;
}

/** Fetch and assemble every data-source meta. The French airspaces and
 *  worldwide airports loaders reject on failure (their cards are core);
 *  the overlay and per-country loaders resolve to null when absent. */
export async function loadAboutMeta(): Promise<AboutMeta> {
	const [
		french, frenchNext, airports, frAirports, frAirportsNext, frFacilities, frNature, itNature,
		pruatlas, faa, faaAirports, faaNavaids, faaObstacles, chObstacles, fiObstacles, obstacles, navaids,
		aixmEntries,
		beNature, beSupaip, esSupaip, atAdCharts,
		supaip, frAdCharts, frVacGeo, ukAdCharts, usAdCharts, deAdCharts, aircraft, metarStations, faaDesignators,
	] = await Promise.all([
		loadFrenchAirspacesMeta(),
		loadFrenchAirspacesNextMeta().catch(() => null),
		loadAirportsMeta(),
		loadFrAirportsMeta().catch(() => null),
		loadFrAirportsNextMeta().catch(() => null),
		loadFacilitiesMeta().catch(() => null),
		loadNatureMeta().catch(() => null),
		loadItNatureMeta().catch(() => null),
		loadPruatlasFirsMeta().catch(() => null),
		loadFaaAirspacesMeta().catch(() => null),
		loadFaaAirportsMeta().catch(() => null),
		loadFaaNavaidsMeta().catch(() => null),
		loadFaaObstaclesMeta().catch(() => null),
		loadChObstaclesMeta().catch(() => null),
		loadFiObstaclesMeta().catch(() => null),
		loadObstaclesMeta().catch(() => null),
		loadNavaidsMeta().catch(() => null),
		Promise.all(AIXM_COUNTRIES.map(loadAixmCountryMeta)),
		loadBeNatureMeta().catch(() => null),
		loadBeSupAipMeta().catch(() => null),
		loadEsSupAipMeta().catch(() => null),
		loadAtAdChartsMeta().catch(() => null),
		loadSupAipMeta().catch(() => null),
		loadFrAdChartsMeta().catch(() => null),
		loadFrVacGeoMeta().catch(() => null),
		loadUkAdChartsMeta().catch(() => null),
		loadUsAdChartsMeta().catch(() => null),
		loadDeAdChartsMeta().catch(() => null),
		loadAircraftMeta().catch(() => null),
		loadMetarStationsMeta().catch(() => null),
		loadFaaDesignatorsMeta().catch(() => null),
	]);
	const aixm = Object.fromEntries(
		AIXM_COUNTRIES.map((c, i) => [c, aixmEntries[i]]),
	) as Record<AixmCountry, AixmCountryMeta>;
	return {
		french, frenchNext, airports, frAirports, frAirportsNext, frFacilities, frNature, itNature,
		pruatlas, faa, faaAirports, faaNavaids, faaObstacles, chObstacles, fiObstacles, obstacles, navaids,
		aixm,
		beNature, beSupaip, esSupaip, atAdCharts,
		supaip, frAdCharts, frVacGeo, ukAdCharts, usAdCharts, deAdCharts, aircraft, metarStations, faaDesignators,
	};
}
