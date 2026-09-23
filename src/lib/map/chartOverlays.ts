import L from 'leaflet';
import type { ChartLayerId, ChartSource } from '$lib/state/layers.svelte';
import { cachedTileLayer } from '$lib/offline/passiveTiles';
import { CHART_WORKER } from '$lib/net/endpoints';

/**
 * Aeronautical chart tile layers, one per country/scale, drawn above the base
 * map but below the reference overlays. Each is an independent Layers-tab
 * checkbox; the CHECK ORDER is the stacking order (MapView gives each stacked
 * layer its own pane, zIndex 250 + stack position), so where two layers
 * overlap (the France/Spain border, fr250 over fr500) the most recently
 * checked wins. Outside a layer's charts its tiles are transparent/204 and
 * the layers below (or the base map) show through.
 *
 * Every layer can have up to two tile SOURCES:
 *  - `public`: the Cloudflare Worker (every layer whose licence allows it) or an
 *    external public WMTS (swissIcao). A layer without a public source is
 *    not listed in production builds.
 *  - `local`: the oaci-wmts dev server (:8080), every layer.
 * The dev-only source selector (layers.chartSource) picks which template is
 * used; production builds are hardwired to 'public'.
 */
/** Section of the Layers tab a chart sits in. NOT geography: the French
 *  outre-mer charts ride inside fr500, so 'france' means "published by the
 *  SIA", not "in Europe". */
export type ChartGroup = 'france' | 'europe' | 'us';
export const CHART_GROUP_ORDER = ['france', 'europe', 'us'] as const satisfies
	readonly ChartGroup[];

export interface ChartLayerDef {
	id: ChartLayerId;
	/** Locale-invariant product name shown as the toggle label. */
	label: string;
	/** Which section of the Layers tab the toggle sits in. Typed, so a new
	 *  layer cannot be added without being placed in one. */
	group: ChartGroup;
	/** t.layers key for the muted coverage line under the toggle. */
	coverageKey:
		| 'fr500Coverage'
		| 'fr250Coverage'
		| 'fr1000Coverage'
		| 'frvv500Coverage'
		| 'frheli100Coverage'
		| 'frenr61Coverage'
		| 'frenr62Coverage'
		| 'nl500Coverage'
		| 'cz500Coverage'
		| 'dk500Coverage'
		| 'dk250Coverage'
		| 'no250Coverage'
		| 'si250Coverage'
		| 'ee500Coverage'
		| 'is500Coverage'
		| 'hu500Coverage'
		| 'ro500Coverage'
		| 'ba500Coverage'
		| 'al500Coverage'
		| 'bg500Coverage'
		| 'at500Coverage'
		| 'es500Coverage'
		| 'us1000Coverage'
		| 'us500Coverage'
		| 'us250Coverage'
		| 'us125Coverage'
		| 'swissCoverage';
	/** Publisher / product page the About charts list links to. */
	homepage: string;
	/** Plain-text licence tag beside the About charts row. */
	license: string;
	/** Tile URL template per source; a missing entry = unavailable there. */
	sources: Partial<Record<ChartSource, string>>;
	/** Whole-PMTiles-archive URL for the offline chart packs
	 *  (docs/offline-maps.md); absent = not downloadable (external WMTS,
	 *  local-only layers). */
	archive?: string;
	maxNativeZoom: number;
	bounds: L.LatLngBounds;
	attribution: string;
}

const LOCAL = 'http://localhost:8080';
const SWISS_WMTS =
	'https://wmts.geo.admin.ch/1.0.0/ch.bazl.luftfahrtkarten-icao/default/current/3857/{z}/{x}/{y}.png';

// i18n-ignore-start: chart product names and tile attributions, locale-invariant (docs/i18n.md rule 10)
const SIA_ATTR =
	'&copy; <a href="https://www.sia.aviation-civile.gouv.fr/">SIA</a>, Licence Ouverte';

export const CHART_LAYERS: ChartLayerDef[] = [
	// ---- France (SIA) ----
	{
		id: 'fr1000',
		group: 'france',
		label: 'SIA OACI 1/1 000 000',
		coverageKey: 'fr1000Coverage',
		homepage: 'https://www.sia.aviation-civile.gouv.fr/',
		license: 'Licence Ouverte',
		sources: {
			// Published 2026-09-18 on the user's call, the licence question having
			// been settled: Licence Ouverte, the "Reproduction interdite" on the
			// Nord verso being the paper product's notice.
			public: `${CHART_WORKER}/fr1000/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/fr1000/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/fr1000/archive`,
		maxNativeZoom: 11,
		// Two sheets (Nord + Sud) plus the Corse inset placed where Corsica is;
		// the sheets reach well into the neighbours, hence the wide box.
		bounds: L.latLngBounds([41.2, -5.7], [51.4, 10.6]),
		attribution: SIA_ATTR,
	},
	{
		id: 'fr500',
		group: 'france',
		label: 'SIA OACI 1/500 000',
		coverageKey: 'fr500Coverage',
		homepage: 'https://www.sia.aviation-civile.gouv.fr/',
		license: 'Licence Ouverte',
		sources: {
			public:
				(import.meta.env.VITE_OACI_TILES_URL as string | undefined) ??
				`${CHART_WORKER}/fr500/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/fr500/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/fr500/archive`,
		maxNativeZoom: 12,
		// France + Corse + the four overseas charts: one rect spanning all of
		// them is nearly worldwide, which disables nothing; kept for parity.
		bounds: L.latLngBounds([-28.5, -157], [52, 169]),
		attribution: SIA_ATTR,
	},
	{
		id: 'fr250',
		group: 'france',
		label: 'SIA 1/250 000',
		coverageKey: 'fr250Coverage',
		homepage: 'https://www.sia.aviation-civile.gouv.fr/',
		license: 'Licence Ouverte',
		sources: {
			public:
				(import.meta.env.VITE_OACI_250K_TILES_URL as string | undefined) ??
				`${CHART_WORKER}/fr250/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/fr250/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/fr250/archive`,
		maxNativeZoom: 13,
		bounds: L.latLngBounds([42.9, -0.2], [49.8, 8.4]),
		attribution: SIA_ATTR,
	},
	{
		id: 'frvv500',
		label: 'SIA Alpes vol à voile 1/500 000',
		group: 'france',
		coverageKey: 'frvv500Coverage',
		homepage: 'https://www.sia.aviation-civile.gouv.fr/',
		license: 'Licence Ouverte',
		sources: {
			// Published 2026-09-20. The reported northward offset turned out to
			// be the chart's own: its aerodrome symbols are drawn 4.6 km across
			// and sit a median 836 m north of the ARP, while its terrain base
			// matches fr500 within 1-2 px. Nothing to correct here.
			public: `${CHART_WORKER}/frvv500/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/frvv500/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/frvv500/archive`,
		maxNativeZoom: 12,
		bounds: L.latLngBounds([42.8, 4.4], [46.9, 7.3]),
		attribution: SIA_ATTR,
	},
	{
		id: 'frheli100',
		label: 'SIA Itinéraires hélicoptères 1/100 000',
		group: 'france',
		coverageKey: 'frheli100Coverage',
		homepage: 'https://www.sia.aviation-civile.gouv.fr/',
		license: 'Licence Ouverte',
		sources: {
			// Published 2026-09-18. Licence Ouverte; the sheet's "Reproduction
			// interdite" is the paper notice, as on fr1000.
			public: `${CHART_WORKER}/frheli100/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/frheli100/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/frheli100/archive`,
		maxNativeZoom: 15,
		bounds: L.latLngBounds([48.4, 1.9], [49.3, 2.8]),
		attribution: SIA_ATTR,
	},
	{
		id: 'frenr61',
		label: 'SIA Croisière espace inférieur 1/2 000 000',
		group: 'france',
		coverageKey: 'frenr61Coverage',
		homepage: 'https://www.sia.aviation-civile.gouv.fr/',
		license: 'Licence Ouverte',
		sources: {
			// Published 2026-09-18. Licence Ouverte, and this sheet prints no
			// copyright or reproduction notice at all.
			public: `${CHART_WORKER}/frenr61/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/frenr61/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/frenr61/archive`,
		maxNativeZoom: 10,
		bounds: L.latLngBounds([40.4, -10.5], [51.2, 12.3]),
		attribution: SIA_ATTR,
	},
	{
		id: 'frenr62',
		label: 'SIA Croisière espace supérieur 1/2 000 000',
		group: 'france',
		coverageKey: 'frenr62Coverage',
		homepage: 'https://www.sia.aviation-civile.gouv.fr/',
		license: 'Licence Ouverte',
		sources: {
			// Published 2026-09-18. Licence Ouverte, no notice printed. Carries the
			// displaced SOUTH-EAST CELL inset warped to its true position.
			public: `${CHART_WORKER}/frenr62/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/frenr62/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/frenr62/archive`,
		maxNativeZoom: 10,
		bounds: L.latLngBounds([40.4, -10.5], [51.2, 12.3]),
		attribution: SIA_ATTR,
	},
	// ---- Rest of Europe ----
	{
		id: 'nl500',
		group: 'europe',
		label: 'LVNL ICAO 1/500 000',
		coverageKey: 'nl500Coverage',
		homepage: 'https://eaip.lvnl.nl/',
		license: '© LVNL / Kadaster',
		sources: {
			// Local-only until the LVNL / Kadaster reuse terms are reviewed:
			// the chart PDF is free but marked "Copyright ... reserved".
			local: `${LOCAL}/nl500/tiles/{z}/{x}/{y}.png`,
		},
		maxNativeZoom: 12,
		bounds: L.latLngBounds([50.3, 2.0], [55.2, 8.1]),
		attribution: '&copy; <a href="https://www.lvnl.nl/">LVNL</a> / Kadaster',
	},
	{
		id: 'cz500',
		group: 'europe',
		label: 'ANS CR ICAO 1/500 000',
		coverageKey: 'cz500Coverage',
		homepage: 'https://aim.rlp.cz/',
		license: '© ŘLP ČR / Ministerstvo obrany',
		sources: {
			// Local-only: the chart itself prints "reproduction ... only after
			// prior permission of ANS of the C.R.".
			local: `${LOCAL}/cz500/tiles/{z}/{x}/{y}.png`,
		},
		maxNativeZoom: 12,
		bounds: L.latLngBounds([48.0, 11.4], [51.3, 19.1]),
		attribution: '&copy; <a href="https://aim.rlp.cz/">ŘLP ČR</a>',
	},
	{
		id: 'dk500',
		group: 'europe',
		label: 'Naviair ANC 1/500 000',
		coverageKey: 'dk500Coverage',
		homepage: 'https://aim.naviair.dk/',
		license: '© Naviair / SDFI / Lantmäteriet',
		sources: {
			public: `${CHART_WORKER}/dk500/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/dk500/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/dk500/archive`,
		maxNativeZoom: 12,
		bounds: L.latLngBounds([54.0, 7.2], [58.2, 16.1]),
		attribution: '&copy; <a href="https://aim.naviair.dk/">Naviair</a>',
	},
	{
		id: 'dk250',
		group: 'europe',
		label: 'Naviair ANC 1/250 000',
		coverageKey: 'dk250Coverage',
		homepage: 'https://aim.naviair.dk/charts/',
		license: '© Naviair / Agency for Climate Data / Umhvørvisstovan',
		sources: {
			// Two sheets, ~2000 km apart: Copenhagen Area and the Faroe
			// Islands (the bounds box spans the gap; there are no tiles in
			// between). Published on the same footing as dk500.
			public: `${CHART_WORKER}/dk250/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/dk250/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/dk250/archive`,
		maxNativeZoom: 13,
		bounds: L.latLngBounds([55.0, -8.9], [62.6, 13.3]),
		attribution: '&copy; <a href="https://aim.naviair.dk/">Naviair</a>',
	},
	{
		id: 'no250',
		group: 'europe',
		label: 'M517-AIR 1/250 000',
		coverageKey: 'no250Coverage',
		homepage: 'https://partner.avinor.no/en/ais/m517/',
		license: '© Royal Norwegian Air Force / Avinor',
		sources: {
			// Local-only: the M517 terms forbid copying/distribution — the
			// official ICAO 500k is contract-gated entirely.
			local: `${LOCAL}/no250/tiles/{z}/{x}/{y}.webp`,
		},
		maxNativeZoom: 12,
		bounds: L.latLngBounds([55.8, -13.8], [81.4, 38.2]),
		attribution: '&copy; <a href="https://partner.avinor.no/en/ais/m517/">RNoAF / Avinor</a>',
	},
	{
		id: 'si250',
		group: 'europe',
		label: 'Slovenia Control VFR 1/250 000',
		coverageKey: 'si250Coverage',
		homepage: 'https://aim.sloveniacontrol.si/aim/products/vfr-charts/',
		license: '© Slovenia Control / GI',
		sources: {
			// Local-only, hard: the chart's colophon prohibits copies and
			// reproductions of all kinds, including single copies.
			local: `${LOCAL}/si250/tiles/{z}/{x}/{y}.png`,
		},
		maxNativeZoom: 13,
		bounds: L.latLngBounds([45.5, 13.5], [46.75, 16.5]),
		attribution: '&copy; <a href="https://www.sloveniacontrol.si/">Slovenia Control</a> / GI',
	},
	{
		id: 'ee500',
		group: 'europe',
		label: 'EANS ICAO 1/500 000',
		coverageKey: 'ee500Coverage',
		homepage: 'https://aim.eans.ee/en/vfr-chart',
		license: '© EANS',
		sources: {
			public: `${CHART_WORKER}/ee500/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/ee500/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/ee500/archive`,
		maxNativeZoom: 12,
		bounds: L.latLngBounds([57.2, 19.7], [60.4, 28.7]),
		attribution: '&copy; <a href="https://aim.eans.ee/">EANS</a>',
	},
	{
		id: 'is500',
		group: 'europe',
		label: 'Isavia ICAO 1/500 000',
		coverageKey: 'is500Coverage',
		homepage: 'https://ans.isavia.is/en/c-preflight-information/kort',
		license: '© Isavia ANS',
		sources: {
			public: `${CHART_WORKER}/is500/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/is500/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/is500/archive`,
		maxNativeZoom: 12,
		bounds: L.latLngBounds([62.8, -27.2], [66.6, -10.6]),
		attribution: '&copy; <a href="https://ans.isavia.is/">Isavia ANS</a>',
	},
	{
		id: 'hu500',
		group: 'europe',
		label: 'HungaroControl ICAO 1/500 000',
		coverageKey: 'hu500Coverage',
		homepage: 'https://ais.hungarocontrol.hu/',
		license: '© HungaroControl',
		sources: {
			// Local-only. The sheet itself prints only "KERESKEDELMI
			// FORGALOMBA NEM HOZHATÓ!" (not to be placed in commercial
			// circulation), a distribution restriction rather than a
			// reproduction ban, and that is what this layer was first read
			// against. The AIP's own GEN 0.1 is wider and governs the chart
			// too: "Any - in full or in part - usage of this document in any
			// form or by any means is subject to HungaroControl's prior
			// written consent." That clause is why the Hungarian airspace
			// data is built and held (docs/eaip-states.md), so the chart is
			// held the same way, as Czechia's and Slovenia's already are.
			local: `${LOCAL}/hu500/tiles/{z}/{x}/{y}.png`,
		},
		maxNativeZoom: 12,
		bounds: L.latLngBounds([45.4, 15.7], [48.8, 23.2]),
		attribution: '&copy; <a href="https://ais.hungarocontrol.hu/">HungaroControl</a>',
	},
	{
		id: 'ro500',
		group: 'europe',
		label: 'ROMATSA ICAO 1/500 000',
		coverageKey: 'ro500Coverage',
		homepage: 'https://www.aisro.ro/publications/hartivfrv02.php',
		license: '© ROMATSA',
		sources: {
			// Local-only. Every sheet prints "© Copyright Romanian Air Traffic
			// Services Administration ... whose permission must be obtained
			// before this chart is reproduced", and nothing grants reuse of
			// the free PDF: AISRO's disclaimer only limits liability and AIP
			// Romania GEN 3.2 sells the sheets.
			local: `${LOCAL}/ro500/tiles/{z}/{x}/{y}.png`,
		},
		maxNativeZoom: 12,
		// Four overlapping sheets reaching into Hungary, Serbia, Bulgaria,
		// Ukraine and Moldova.
		bounds: L.latLngBounds([43.4, 19.1], [48.3, 30.8]),
		attribution: '&copy; <a href="https://www.aisro.ro/">ROMATSA</a>',
	},
	{
		id: 'ba500',
		group: 'europe',
		label: 'BHANSA VFR 1/500 000',
		coverageKey: 'ba500Coverage',
		homepage: 'https://www.bhansa.gov.ba/en',
		license: '© BHANSA',
		sources: {
			// Local-only. The sheet prints no notice of its own, but AIP BiH
			// GEN 0.1 reserves all rights "without the prior written
			// permission of the publisher" and BHANSA grants no licence for
			// the free PDF.
			local: `${LOCAL}/ba500/tiles/{z}/{x}/{y}.png`,
		},
		maxNativeZoom: 12,
		bounds: L.latLngBounds([42.3, 15.0], [45.7, 20.1]),
		attribution: '&copy; <a href="https://www.bhansa.gov.ba/">BHANSA</a>',
	},
	{
		id: 'al500',
		group: 'europe',
		label: 'Albcontrol ICAO 1/500 000',
		coverageKey: 'al500Coverage',
		homepage: 'https://www.albcontrol.al/aip/',
		license: '© Albcontrol',
		sources: {
			// Local-only. Albcontrol's copyright page allows the publications
			// only to be "displayed and viewed on screen in an unaltered form
			// ... for personal, non-commercial purposes", and AIP Albania
			// GEN 0.1 reserves all rights without prior written permission.
			local: `${LOCAL}/al500/tiles/{z}/{x}/{y}.png`,
		},
		maxNativeZoom: 12,
		bounds: L.latLngBounds([39.1, 18.2], [42.9, 21.8]),
		attribution: '&copy; <a href="https://www.albcontrol.al/">Albcontrol</a>',
	},
	{
		id: 'bg500',
		group: 'europe',
		label: 'BULATSA ICAO 1/500 000',
		coverageKey: 'bg500Coverage',
		homepage: 'https://b-flip.bulatsa.com/publications/aeronautical-chart',
		license: '© BULATSA',
		sources: {
			// Local-only. BULATSA serves the chart only inside B-FLIP, behind a
			// login, and nothing grants reuse: the sheet prints no rights notice,
			// BULATSA's site has no terms page, and B-FLIP's terms sit behind the
			// same login.
			local: `${LOCAL}/bg500/tiles/{z}/{x}/{y}.png`,
		},
		maxNativeZoom: 12,
		bounds: L.latLngBounds([40.6, 21.6], [44.7, 29.2]),
		attribution: '&copy; <a href="https://www.bulatsa.com/">BULATSA</a>',
	},
	{
		id: 'at500',
		group: 'europe',
		label: 'Austro Control ICAO 1/500 000',
		coverageKey: 'at500Coverage',
		homepage:
			'https://www.austrocontrol.at/piloten/vor_dem_flug/aim_produkte/luftfahrtkarte_-_icao_1500_000',
		license: '© Austro Control',
		sources: {
			// Published on the user's decision (2026-09-24). Austro Control offers
			// the PDF for non-commercial purposes, which this free app is; the
			// sheet itself also prints "Reproduction and transformation of this
			// chart … in analogous or digital form are subject to a prior written
			// consent by Austro Control GmbH", kept on record here as it is in
			// the oaci repo.
			public: `${CHART_WORKER}/at500/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/at500/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/at500/archive`,
		maxNativeZoom: 12,
		bounds: L.latLngBounds([45.6, 8.9], [49.6, 17.5]),
		attribution: '&copy; Austro Control, topographic base &copy; BEV',
	},
	{
		id: 'es500',
		group: 'europe',
		label: 'ENAIRE VFR 1/500 000',
		coverageKey: 'es500Coverage',
		homepage: 'https://aip.enaire.es/',
		license: '© ENAIRE',
		sources: {
			public: `${CHART_WORKER}/es500/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/es500/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/es500/archive`,
		maxNativeZoom: 12,
		bounds: L.latLngBounds([27.2, -18.5], [44, 4.7]),
		attribution: '&copy; <a href="https://aip.enaire.es/">ENAIRE</a>',
	},
	{
		id: 'swissIcao',
		group: 'europe',
		label: 'swisstopo OACI 1/500 000',
		coverageKey: 'swissCoverage',
		homepage: 'https://www.swisstopo.admin.ch/',
		license: '© swisstopo, BAZL',
		sources: {
			// Official swisstopo / BAZL ICAO 1:500 000, public geo.admin.ch WMTS
			// (Time dimension `current` tracks the annual edition). Sends
			// `access-control-allow-origin: *`, so no crossOrigin needed.
			// swisstopo hosts this itself, independent of our Worker/local
			// split; the SAME URL under both sources keeps the checkbox
			// available whichever way the dev source selector points.
			public: SWISS_WMTS,
			local: SWISS_WMTS,
		},
		maxNativeZoom: 12,
		bounds: L.latLngBounds([45.398181, 5.140242], [48.230651, 11.47757]),
		attribution: '&copy; <a href="https://www.swisstopo.admin.ch/">swisstopo</a>, BAZL',
	},
	// ---- United States (FAA) ----
	{
		id: 'us1000',
		group: 'us',
		label: 'FAA Caribbean + Gulf Coast 1/1 000 000',
		coverageKey: 'us1000Coverage',
		homepage: 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/vfr/',
		license: 'Public domain',
		sources: {
			public: `${CHART_WORKER}/us1000/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/us1000/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/us1000/archive`,
		maxNativeZoom: 11,
		bounds: L.latLngBounds([12.7, -99.4], [30.9, -60.2]),
		attribution: 'FAA, public domain',
	},
	{
		id: 'us500',
		group: 'us',
		label: 'FAA sectional 1/500 000',
		coverageKey: 'us500Coverage',
		homepage: 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/vfr/',
		license: 'Public domain',
		sources: {
			public: `${CHART_WORKER}/us500/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/us500/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/us500/archive`,
		maxNativeZoom: 12,
		// South to American Samoa: besides the sectionals this layer carries the
		// Pacific insets of the Hawaiian sheet (Guam and the CNMI at 1:750k,
		// American Samoa at 1:500k), which the public archive has served since
		// the 2026-08-09 re-publish.
		bounds: L.latLngBounds([-14.8, -180], [72.4, 180]),
		attribution: 'FAA, public domain',
	},
	{
		id: 'us250',
		group: 'us',
		label: 'FAA TAC 1/250 000 + Grand Canyon',
		// (Puerto Rico / US Virgin Islands ride here too: the FAA publishes no
		// sectional for the territory, so its TAC is its whole VFR coverage.)
		coverageKey: 'us250Coverage',
		homepage: 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/vfr/',
		license: 'Public domain',
		sources: {
			public: `${CHART_WORKER}/us250/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/us250/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/us250/archive`,
		maxNativeZoom: 13,
		bounds: L.latLngBounds([17.6, -158.5], [65.3, -64.2]),
		attribution: 'FAA, public domain',
	},
	{
		id: 'us125',
		group: 'us',
		label: 'FAA helicopter route charts 1/125 000',
		coverageKey: 'us125Coverage',
		homepage: 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/vfr/',
		license: 'Public domain',
		sources: {
			public: `${CHART_WORKER}/us125/tiles/{z}/{x}/{y}.webp`,
			local: `${LOCAL}/us125/tiles/{z}/{x}/{y}.png`,
		},
		archive: `${CHART_WORKER}/us125/archive`,
		maxNativeZoom: 14,
		bounds: L.latLngBounds([29.1, -119.5], [42.8, -70.3]),
		attribution: 'FAA, public domain',
	},
];
// i18n-ignore-end

/** The layers with a public tile source: what production offers and what
 *  the About charts list credits (a layer credits itself the moment it
 *  publishes). */
export function publishedChartLayers(): ChartLayerDef[] {
	return CHART_LAYERS.filter((d) => d.sources.public !== undefined);
}

/** The layers offered in this build/mode: production lists only layers with
 *  a public source; dev lists everything (the selector may still grey some
 *  out when their source lacks them). */
export function availableChartLayers(): ChartLayerDef[] {
	if (import.meta.env.DEV) {
		return CHART_LAYERS;
	}
	return publishedChartLayers();
}

/** Build the Leaflet tile layer for a def under the given source; null when
 *  the def has no template for that source. */
export function createChartLayer(
	def: ChartLayerDef,
	source: ChartSource,
	pane: string,
): L.TileLayer | null {
	const url = def.sources[source];
	if (!url) {
		return null;
	}
	// cachedTileLayer = the Android shell's passive offline cache, a plain
	// L.tileLayer on the web; both chart tile hosts send CORS headers.
	return cachedTileLayer(url, {
		pane,
		// crossOrigin makes the browser send an Origin header so the public
		// Worker's allow-list can gate the tiles (harmless on localhost;
		// geo.admin.ch sends ACAO:* anyway). maxNativeZoom caps the native
		// pyramid; Leaflet overzooms up to maxZoom past it.
		crossOrigin: 'anonymous',
		maxNativeZoom: def.maxNativeZoom,
		maxZoom: 19,
		bounds: def.bounds,
		attribution: def.attribution,
	});
}
