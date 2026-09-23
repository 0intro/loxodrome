/* Which datasets the NOTAM Viewer READS.
 *
 * It no longer ships any. The app is published at /notam/ inside Loxodrome's
 * site and its dataset paths are root-absolute, so it reads the surrounding
 * site's own /data/ and nothing is duplicated. What this list is now is the
 * statement of what the app reaches for, which two specs hold the site to:
 * tests/notamViewerDatasets.spec.ts drives the real ensure* functions against
 * a stub serving exactly these (and against the whole site, where the app must
 * read nothing else), and tests/notamViewerSite.spec.ts checks the built site
 * carries each one. The failure both guard is silent: a dataset the
 * app fetches and the site does not carry answers 404, and roughly fifteen of
 * the sidecar loaders THROW on that rather than degrading (src/lib/data/meta.ts,
 * metaLoader versus optionalMetaLoader).
 *
 * The choice, decided with the pilot: the datasets the NOTAM relationship
 * mechanisms need, and nothing else. Airspaces and FIRs carry ownership,
 * activation and the airspace links; airports carry Item A) ownership, the ARP
 * citations, the runway closures and the frequency changes; the SUP AIP sets
 * carry the trigger pairing; the facilities and the French fuel carry what a
 * fuel withdrawal is an exception to. No obstacles, no navaids, no chart
 * layers, no aircraft: the site this app is published in carries the first
 * two, and the shared NOTAM panel's on-demand load of them does nothing here
 * (state/notamLinkData.ts), or an obstacle NOTAM over Zurich lists FOCA rows
 * the About credits nowhere. And one thing the shared airport panel reads
 * beside them: the aerodrome-chart catalogs of five publishers already
 * credited here (fr / uk / us / de / at-adcharts), for its links to their own
 * charts. They were read and listed nowhere until a review measured it.
 *
 * TWO THINGS IT READS THAT ARE NOT IN THAT LIST, and both were uncredited
 * until they were measured: the elevation mosaic and live weather. Neither is
 * a bbox-gated area dataset, so neither belongs in NOTAM_VIEWER_DATASETS
 * (terrain.json carries no sidecar and would fail that list's own twin rule),
 * and that is exactly how they went unnoticed. VIEWER_LIVE_SOURCES below is
 * the second half of this file's job, and tests/notamViewerAbout.spec.ts
 * holds the About page to it the way notamViewerDatasets.spec.ts holds it to
 * the publishers.
 *
 * No `.next` tier named here, because the pre-release sidecars are reached
 * through optionalMetaLoader and so are not something the app REQUIRES. The
 * surrounding site does ship both slots, which is the move's one functional
 * gain: pickActiveDataset now sees the pre-release and the viewer follows the
 * AIRAC cycle instead of waiting to be republished on the date.
 *
 * 34 MB across the list, which tests/notamViewerDatasets.spec.ts pins with
 * headroom. The datasets load per area, so a session fetches a fraction.
 */

import type { Messages } from '$lib/i18n/en';

/** Everything this app fetches that is NOT one of the datasets below: a
 *  source, what reaches it, and the About section that owes it a credit.
 *
 *  The list exists because the datasets list could not carry them and their
 *  absence from it read as absence from the app. Measured on one aerodrome
 *  click: two `/wx` calls and a terrain tile, from an app whose own file
 *  header said it had neither. Each row names the About heading key, so the
 *  spec can check the page against this rather than against a hand-kept
 *  second list. */
export interface ViewerLiveSource {
	/** Short key, for the diagnostics of a spec that finds one uncredited. */
	id: string;
	/** The `t.about.*` heading key of the section that owes it a credit. */
	heading: 'weatherHeading' | 'terrainHeading';
}

export const VIEWER_LIVE_SOURCES: readonly ViewerLiveSource[] = [
	// NOAA AWC, through the proxy's /wx/metar and /wx/taf. Reached by
	// detail/WeatherSection on the airport panel, gated by
	// display.liveWeather, which SettingsPopover now carries.
	{ id: 'awc', heading: 'weatherHeading' },
	// The elevation mosaic: /data/terrain.json plus the chart worker's
	// /terrain/{z}/{x}/{y}. Reached by detail/AltitudeProfile for the ground
	// band under an airspace panel. The Copernicus tiers carry a MANDATORY
	// attribution, which the About page prints verbatim off the manifest.
	{ id: 'terrain', heading: 'terrainHeading' },
];

/** A publisher key, as the Layers tab already names them, so a credit reads in
 *  the reader's language and there is one spelling of each country. */
export type ViewerPublisher = keyof Messages['layers']['publisherNames'];

/** The dataset prefixes that name no NATIONAL aeronautical information
 *  service. Each is credited, on its own terms, BESIDE the national ones
 *  rather than among them: `airports` is OurAirports, a worldwide aerodrome
 *  baseline, and the Layers tab calls `pruatlas` "Worldwide FIRs", which is
 *  the layer it draws and not who publishes it (EUROCONTROL). A sentence
 *  listing "France, United Kingdom, ... Worldwide FIRs" would be wrong twice
 *  over. And `it` is open flightmaps, COMMUNITY data and not the Italian AIP:
 *  listed among the national services, the page said ENAV published it. */
const NON_NATIONAL: readonly string[] = ['airports', 'pruatlas', 'it'];

/** A file prefix that is not its publisher's key: the FAA files its chart
 *  catalog as us-adcharts beside its own faa-* datasets. */
const PREFIX_PUBLISHER: Readonly<Record<string, string>> = { us: 'faa' };

/** Every dataset prefix the manifest carries, as its publisher, one entry
 *  each. */
export function viewerDatasetPrefixes(): string[] {
	const seen = new Set<string>();
	for (const path of NOTAM_VIEWER_DATASETS) {
		const name = path.slice('/data/'.length);
		const dash = name.indexOf('-');
		const prefix = dash > 0 ? name.slice(0, dash) : name.slice(0, name.indexOf('.'));
		seen.add(PREFIX_PUBLISHER[prefix] ?? prefix);
	}
	return [...seen];
}

/** The national AIS publishers whose data this app reads, DERIVED from the
 *  manifest rather than written out beside it.
 *
 *  That is the whole point. The About page credits exactly these, so a dataset
 *  added to the manifest cannot ship uncredited; the obligation is the
 *  publisher's and not something anyone has to remember twice. It was already
 *  missed once: the first About shipped naming neither EUROCONTROL's pruatlas
 *  nor OurAirports, both of which this app reads.
 *
 *  tests/notamViewerDatasets.spec.ts pins that every prefix resolves to one of
 *  these or to NON_NATIONAL, so an unrecognised one fails the suite rather
 *  than disappearing from the credits. */
export function viewerNationalPublishers(): ViewerPublisher[] {
	return viewerDatasetPrefixes().filter(
		(p) => !NON_NATIONAL.includes(p),
	) as ViewerPublisher[];
}

/** A `t.about.*` key holding a plain string: a credit heading or a licence
 *  line. */
export type AboutLine = {
	[K in keyof Messages['about']]: Messages['about'][K] extends string ? K : never;
}[keyof Messages['about']];

/** How one source is credited: the page its data is read from, the heading
 *  naming its producer and its own terms, in the flight app's About's own
 *  catalog lines, so the two apps cannot credit one source two ways. The
 *  terms are what the licences ask to be passed on (the SIA and the edition
 *  date, GeoNutzV's "(modified)", CC BY 4.0, Austro Control's permission),
 *  and a page naming only the countries passed on none of them. */
export interface ViewerCredit {
	href: string;
	head: AboutLine;
	license: AboutLine;
}

/** The AIP data sets' credits, by publisher, as viewerDatasetPrefixes() names
 *  them. tests/notamViewerDatasets.spec.ts pins one for every publisher the
 *  manifest reads but OurAirports and pruatlas, which the page credits in a
 *  sentence of their own. */
export const AIP_CREDITS: Readonly<Record<string, ViewerCredit>> = {
	fr: { href: 'https://www.sia.aviation-civile.gouv.fr/', head: 'headFrance', license: 'licFrance' },
	uk: {
		href: 'https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/',
		head: 'headUk',
		license: 'licUk',
	},
	be: {
		href: 'https://ops.skeyes.be/html/belgocontrol_static/eaip/eAIP_Main/html/index-en-GB.html',
		head: 'headBelgium',
		license: 'licBelgium',
	},
	de: { href: 'https://aip.dfs.de/datasets/', head: 'headGermany', license: 'licGermany' },
	// Its licence line ends on "Report a data error at", the page linking the
	// association's site after it, as the flight app's card does.
	it: { href: 'https://openflightmaps.org/', head: 'headItaly', license: 'licItaly' },
	nl: { href: 'https://geoportaal.lvnl.nl/', head: 'headNetherlands', license: 'licNetherlands' },
	ge: { href: 'https://ais.airnav.ge/en/aip-dataset', head: 'headGeorgia', license: 'licGeorgia' },
	at: {
		href: 'https://www.austrocontrol.at/en/pilots/pre-flight_preparation/aim_products',
		head: 'headAustria',
		license: 'licAustria',
	},
	sk: { href: 'https://aim.lps.sk/', head: 'headSlovakia', license: 'licSlovakia' },
	ie: { href: 'https://www.airnav.ie/', head: 'headIreland', license: 'licIreland' },
	rs: { href: 'https://smatsa.rs/en/aip/', head: 'headSerbiaMontenegro', license: 'licSerbiaMontenegro' },
	xk: { href: 'https://kans-ks.org/eAIP/default.html', head: 'headKosovo', license: 'licKosovo' },
	es: { href: 'https://aip.enaire.es/AIP/DatosDigitales-en.html', head: 'headSpain', license: 'licSpain' },
	faa: { href: 'https://adds-faa.opendata.arcgis.com/', head: 'headFaa', license: 'licNoaa' },
};

/** The aerodrome-chart catalogs' credits, by the prefix of their file
 *  (`us-adcharts` is the FAA's). */
export const AD_CHART_CREDITS: Readonly<Record<string, ViewerCredit>> = {
	fr: { href: 'https://www.sia.aviation-civile.gouv.fr/', head: 'headAdCharts', license: 'licFrance' },
	uk: {
		href: 'https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/',
		head: 'headUkAdCharts',
		license: 'licUk',
	},
	us: {
		href: 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/',
		head: 'headUsAdCharts',
		license: 'licNoaa',
	},
	de: { href: 'https://aip.dfs.de/BasicVFR/', head: 'headDeAdCharts', license: 'licGermany' },
	at: {
		href: 'https://www.austrocontrol.at/en/pilots/pre-flight_preparation/aim_products',
		head: 'headAtAdCharts',
		license: 'licAustria',
	},
};

/** The prefixes of the aerodrome-chart catalogs the manifest reads, as their
 *  files spell them. */
export function viewerAdChartPrefixes(): string[] {
	return NOTAM_VIEWER_DATASETS.filter((p) => p.endsWith('-adcharts.json')).map((p) =>
		p.slice('/data/'.length, p.indexOf('-adcharts.json')),
	);
}

export const NOTAM_VIEWER_DATASETS: readonly string[] = [
	'/data/airports.json',
	'/data/airports.meta.json',
	'/data/at-adcharts.json',
	'/data/at-adcharts.meta.json',
	'/data/at-airports.json',
	'/data/at-airports.meta.json',
	'/data/at-airspaces.json',
	'/data/at-airspaces.meta.json',
	'/data/be-aerodrome-facilities.json',
	'/data/be-aerodrome-facilities.meta.json',
	'/data/be-airports.json',
	'/data/be-airports.meta.json',
	'/data/be-airspaces.json',
	'/data/be-airspaces.meta.json',
	'/data/be-supaip.json',
	'/data/be-supaip.meta.json',
	'/data/de-adcharts.json',
	'/data/de-adcharts.meta.json',
	'/data/de-aerodrome-facilities.json',
	'/data/de-aerodrome-facilities.meta.json',
	'/data/de-airports.json',
	'/data/de-airports.meta.json',
	'/data/de-airspaces.json',
	'/data/de-airspaces.meta.json',
	'/data/es-aerodrome-facilities.json',
	'/data/es-aerodrome-facilities.meta.json',
	'/data/es-airports.json',
	'/data/es-airports.meta.json',
	'/data/es-airspaces.json',
	'/data/es-airspaces.meta.json',
	'/data/es-supaip.json',
	'/data/es-supaip.meta.json',
	'/data/faa-airports.json',
	'/data/faa-airports.meta.json',
	'/data/faa-airspaces.json',
	'/data/faa-airspaces.meta.json',
	'/data/fr-adcharts.json',
	'/data/fr-adcharts.meta.json',
	'/data/fr-aerodrome-facilities.json',
	'/data/fr-aerodrome-facilities.meta.json',
	'/data/fr-airports.json',
	'/data/fr-airports.meta.json',
	'/data/fr-airspaces.json',
	'/data/fr-airspaces.meta.json',
	'/data/fr-fuel.json',
	'/data/fr-fuel.meta.json',
	'/data/fr-supaip.json',
	'/data/fr-supaip.meta.json',
	'/data/ge-aerodrome-facilities.json',
	'/data/ge-aerodrome-facilities.meta.json',
	'/data/ge-airports.json',
	'/data/ge-airports.meta.json',
	'/data/ge-airspaces.json',
	'/data/ge-airspaces.meta.json',
	'/data/ie-airspaces.json',
	'/data/ie-airspaces.meta.json',
	'/data/it-airports.json',
	'/data/it-airports.meta.json',
	'/data/it-airspaces.json',
	'/data/it-airspaces.meta.json',
	'/data/nl-airports.json',
	'/data/nl-airports.meta.json',
	'/data/nl-airspaces.json',
	'/data/nl-airspaces.meta.json',
	'/data/pruatlas-firs.json',
	'/data/pruatlas-firs.meta.json',
	'/data/rs-airspaces.json',
	'/data/rs-airspaces.meta.json',
	'/data/sk-airspaces.json',
	'/data/sk-airspaces.meta.json',
	'/data/uk-adcharts.json',
	'/data/uk-adcharts.meta.json',
	'/data/uk-aerodrome-facilities.json',
	'/data/uk-aerodrome-facilities.meta.json',
	'/data/uk-airports.json',
	'/data/uk-airports.meta.json',
	'/data/uk-airspaces.json',
	'/data/uk-airspaces.meta.json',
	'/data/us-adcharts.json',
	'/data/us-adcharts.meta.json',
	'/data/xk-airspaces.json',
	'/data/xk-airspaces.meta.json',
];
