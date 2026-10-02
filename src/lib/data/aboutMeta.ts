/* Loader for the About modal's data-source metadata: one Promise.all over
 * every per-publisher meta sidecar. Overlay and per-country metas are
 * optional (a fresh clone may lack them), so each is caught to null and
 * blanks just its own card. The modal owns the in-flight race guard; this
 * module only fetches and assembles. */

import {
	aipChartsMeta,
	datasetMeta,
	loadFrenchAirspacesMeta,
	loadFrenchAirspacesNextMeta,
	loadAirportsMeta,
	loadFrAirportsMeta,
	loadFrAirportsNextMeta,
	loadPruatlasFirsMeta,
	loadFaaAirspacesMeta,
	loadFaaAirportsMeta,
	loadFacilitiesMeta,
	loadFaaNavaidsMeta,
	loadFaaObstaclesMeta,
	loadObstaclesMeta,
	loadNavaidsMeta,
	loadNatureMeta,
	loadBeSupAipMeta,
	loadEsSupAipMeta,
	loadAtAdChartsMeta,
	loadUkAdChartsMeta,
	loadUsAdChartsMeta,
	loadDeAdChartsMeta,
	loadSupAipMeta,
	loadFrAdChartsMeta,
	loadFrFuelMeta,
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
	type FrFuelMeta,
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
	type AipChartsMeta,
} from './meta';
import { REGISTRY_PUBLISHERS, publishes, type RegistryPublisher } from './publishers';
import { AIP_CHART_INDEXES } from './aipCharts';

/** The publishers the registry reads datasets from ($lib/data/publishers),
 *  one per-publisher meta record each. This is the FETCH order, not the card
 *  order: AboutModal owns the order the cards appear in. Anything reading
 *  this list wants "which publishers have a per-country meta record", which
 *  is what it means. */
export const AIXM_COUNTRIES = REGISTRY_PUBLISHERS;
export type AixmCountry = RegistryPublisher;

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
	nature: NatureMeta | null;
}

/** One publisher's sidecars, each null when absent. A dataset the registry
 *  says the publisher does not file is null without a request: a different
 *  thing from a sidecar that failed to load, and no pointless 404 on every
 *  About open. */
async function loadAixmCountryMeta(country: AixmCountry): Promise<AixmCountryMeta> {
	const load = <T>(kind: Parameters<typeof publishes>[1]): Promise<T | null> =>
		publishes(country, kind) ? datasetMeta<T>(country, kind)().catch(() => null) : Promise.resolve(null);
	const [airspaces, airports, obstacles, navaids, facilities, nature] = await Promise.all([
		load<AixmAirspacesMeta>('airspaces'),
		load<AixmAirportsMeta>('airports'),
		load<AixmObstaclesMeta>('obstacles'),
		load<AixmNavaidsMeta>('navaids'),
		load<FacilitiesMeta>('facilities'),
		load<NatureMeta>('nature'),
	]);
	return { airspaces, airports, obstacles, navaids, facilities, nature };
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
	pruatlas: PruatlasFirsMeta | null;
	faa: FaaAirspacesMeta | null;
	faaAirports: AixmAirportsMeta | null;
	faaNavaids: AixmNavaidsMeta | null;
	faaObstacles: AixmObstaclesMeta | null;
	obstacles: ObstaclesMeta | null;
	navaids: NavaidsMeta | null;
	aixm: Record<AixmCountry, AixmCountryMeta>;
	beSupaip: SupAipMeta | null;
	esSupaip: SupAipMeta | null;
	atAdCharts: AtAdChartsMeta | null;
	supaip: SupAipMeta | null;
	frAdCharts: FrAdChartsMeta | null;
	frVacGeo: FrVacGeoMeta | null;
	frFuel: FrFuelMeta | null;
	ukAdCharts: UkAdChartsMeta | null;
	usAdCharts: UsAdChartsMeta | null;
	deAdCharts: DeAdChartsMeta | null;
	/** The eAIP States' chart indexes, by id ($lib/data/aipCharts); an
	 *  index whose first build has not run is absent. */
	aipCharts: Record<string, AipChartsMeta>;
	aircraft: AircraftMeta | null;
	metarStations: MetarStationsMeta | null;
	faaDesignators: FaaDesignatorsMeta | null;
}

/** Fetch and assemble every data-source meta. The French airspaces and
 *  worldwide airports loaders reject on failure (their cards are core);
 *  the overlay and per-country loaders resolve to null when absent. */
export async function loadAboutMeta(): Promise<AboutMeta> {
	const [
		french, frenchNext, airports, frAirports, frAirportsNext, frFacilities, frNature,
		pruatlas, faa, faaAirports, faaNavaids, faaObstacles, obstacles, navaids,
		aixmEntries,
		beSupaip, esSupaip, atAdCharts,
		supaip, frAdCharts, frVacGeo, frFuel, ukAdCharts, usAdCharts, deAdCharts, aircraft, metarStations, faaDesignators,
		aipChartsEntries,
	] = await Promise.all([
		loadFrenchAirspacesMeta(),
		loadFrenchAirspacesNextMeta().catch(() => null),
		loadAirportsMeta(),
		loadFrAirportsMeta().catch(() => null),
		loadFrAirportsNextMeta().catch(() => null),
		loadFacilitiesMeta().catch(() => null),
		loadNatureMeta().catch(() => null),
		loadPruatlasFirsMeta().catch(() => null),
		loadFaaAirspacesMeta().catch(() => null),
		loadFaaAirportsMeta().catch(() => null),
		loadFaaNavaidsMeta().catch(() => null),
		loadFaaObstaclesMeta().catch(() => null),
		loadObstaclesMeta().catch(() => null),
		loadNavaidsMeta().catch(() => null),
		Promise.all(AIXM_COUNTRIES.map(loadAixmCountryMeta)),
		loadBeSupAipMeta().catch(() => null),
		loadEsSupAipMeta().catch(() => null),
		loadAtAdChartsMeta().catch(() => null),
		loadSupAipMeta().catch(() => null),
		loadFrAdChartsMeta().catch(() => null),
		loadFrVacGeoMeta().catch(() => null),
		loadFrFuelMeta().catch(() => null),
		loadUkAdChartsMeta().catch(() => null),
		loadUsAdChartsMeta().catch(() => null),
		loadDeAdChartsMeta().catch(() => null),
		loadAircraftMeta().catch(() => null),
		loadMetarStationsMeta().catch(() => null),
		loadFaaDesignatorsMeta().catch(() => null),
		Promise.all(AIP_CHART_INDEXES.map((x) => aipChartsMeta(x.id)().catch(() => null))),
	]);
	const aixm = Object.fromEntries(
		AIXM_COUNTRIES.map((c, i) => [c, aixmEntries[i]]),
	) as Record<AixmCountry, AixmCountryMeta>;
	const aipCharts: Record<string, AipChartsMeta> = {};
	AIP_CHART_INDEXES.forEach((x, i) => {
		const m = aipChartsEntries[i];
		if (m) {
			aipCharts[x.id] = m;
		}
	});
	return {
		french, frenchNext, airports, frAirports, frAirportsNext, frFacilities, frNature,
		pruatlas, faa, faaAirports, faaNavaids, faaObstacles, obstacles, navaids,
		aixm,
		beSupaip, esSupaip, atAdCharts,
		supaip, frAdCharts, frVacGeo, frFuel, ukAdCharts, usAdCharts, deAdCharts, aircraft, metarStations, faaDesignators,
		aipCharts,
	};
}
