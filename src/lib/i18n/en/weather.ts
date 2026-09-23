/* Weather wording: the vocab packs the locale-free formatters take
 * ($lib/weather/metar, windBarbs, sigmet; docs/i18n.md rule 6), the
 * METAR-station hover-badge words, and the Weather tab. The SIGMET hazard
 * labels re-export the canonical table in $lib/weather/sigmet (the en/data.ts
 * pattern). Locale-invariant: model / product names (AROME, ICON, GFS, UKMO,
 * Open-Meteo, Météo-France, TEMSI, WINTEM, SOFIA), METAR / TAF / SIGMET
 * codes, flight categories (VFR / MVFR / IFR / LIFR), unit tokens and
 * fmtLevel output. */

import type { MetarWords, WeatherGroup } from '$lib/weather/metar';
import { WIND_MODELS, type WindModelId } from '$lib/weather/openMeteo';
import { HAZARD_STYLES, type SigmetHazard, type SigmetWords } from '$lib/weather/sigmet';
import type { BarbWords } from '$lib/weather/windBarbs';
import type { RadarLoopMin } from '$lib/state/radar.svelte';
import type { OperaProduct } from '$lib/weather/opera';
import type { RadarWord } from '$lib/weather/opera';
import { plural } from './plural';

/** The canonical English model label from the registry (the HAZARD_STYLES
 *  re-export pattern), so the catalog cannot drift from the model specs. */
const windModelLabel = (id: WindModelId): string =>
	WIND_MODELS.find((m) => m.id === id)?.label ?? id;

export const weather = {
	advisoriesBy:
		'Advisories by the NOAA Aviation Weather Center, worldwide. Clicking a row opens its detail panel and frames the area on the map.',
	advisoriesWorldwide: (n: number) => `${n} ${plural(n, 'advisory', 'advisories')} worldwide`,
	altitudesNote:
		'Altitudes are AMSL, interpolated between pressure levels. Barbs fade where the level lies below the terrain (the 10 m wind shows instead) or above the forecast ladder (the topmost-level wind shows).',
	anchorAria: 'Hour the map follows',
	animateAria: 'Animate the forecast hour',
	autoByRegion: 'Auto by region',
	barb: {
		calm: 'Calm',
		degTrue: (ddd: string) => `${ddd}° true`,
		fadedNote: '10 m wind (level below terrain)',
		aboveTopNote: 'above the forecast ladder, topmost-level wind shown',
	} satisfies BarbWords,
	barbLegendAria: 'Wind barb legend',
	catalogFetched: (age: string) => `Catalog fetched ${age}, links expire with it.`,
	chartLabel: (p: { chart: string; deadline: string }) => `${p.chart}, valid ${p.deadline}`,
	chartZoneAria: 'Chart zone',
	custom: 'Custom',
	dateTimeLegend: 'Date & time (UTC)',
	departure: 'Departure',
	downloadPdfTip: 'Download the PDF from aviation.meteo.fr',
	feet: 'Feet',
	fetchFailed: 'Fetch failed:',
	hazards: {
		ICE: HAZARD_STYLES.ICE.label,
		MTW: HAZARD_STYLES.MTW.label,
		OTHER: HAZARD_STYLES.OTHER.label,
		TC: HAZARD_STYLES.TC.label,
		TS: HAZARD_STYLES.TS.label,
		TURB: HAZARD_STYLES.TURB.label,
		VA: HAZARD_STYLES.VA.label,
	} satisfies Record<SigmetHazard, string>,
	isobars: 'MSLP isobars (4 hPa)',
	isobarsTip:
		'Mean-sea-level-pressure contours every 4 hPa, drawn under the barbs. Turning it on adds the pressure field to the fetch.',
	isothermAtLevel: 'Isotherm at the chosen level',
	isothermTempAria: 'Isotherm temperature (degrees Celsius)',
	level: 'Level',
	liveWeatherDisabled:
		'Live weather is disabled in the Settings tab, so no wind data is fetched.',
	liveWeatherOff: 'Live weather is off.',
	loadingAdvisories: 'Loading advisories.',
	loadingCatalog: 'Loading the chart catalog.',
	loadingStations: 'Loading stations.',
	loadingWx: 'Loading weather.',
	metar: {
		agoHM: (h: number, mm: string) => `${h} h ${mm} ago`,
		agoMin: (min: number) => `${min} min ago`,
		calm: 'calm',
		gustingKt: (kt: number) => `gusting ${kt} kt`,
		orMore: (text: string) => `${text} or more`,
	} satisfies MetarWords,
	metarStationsLegend: 'METAR stations',
	model: 'Model',
	modelLine: (p: { model: string; days: number }) =>
		`${p.model}, forecasts to ${p.days} ${plural(p.days, 'day', 'days')}`,
	modelRun: (run: string) => `run ${run}`,
	nearestMetar: (p: { id: string; dist: string }) => `Nearest METAR, ${p.id}, ${p.dist} away`,
	nearestUnavailable: 'Nearest-station lookup unavailable.',
	noAdvisories: 'No advisory active in the filter window.',
	noCharts: 'No charts published for this zone.',
	noStation50: 'No METAR station within 50 NM.',
	noStationAt: (id: string) => `No METAR station at ${id}.`,
	now: 'Now',
	openMeteoCredit: 'Weather data by Open-Meteo.com',
	pauseAnimation: 'Pause the animation',
	playAnimation: 'Play the animation',
	printBrief: 'Print weather briefing',
	printBriefEmpty: 'Nothing to print for the planned flight.',
	printBriefTip:
		'Print the flight dossier weather part: METAR / TAF, then the TEMSI and WINTEM charts relevant to the planned flight (needs live weather and a route)',
	radar: {
		caution:
			'Radar frames are never current: the newest is already minutes old when shown, and the loop reaches further back still. They show where precipitation was, not where it is. Use them to avoid an area, never to pick a path through it, and never in place of the briefing.',
		caveat: {
			DBZH: 'Observed reflectivity from the EUMETNET OPERA composite of more than 160 European ground radars, refreshed every 5 min and typically 5 to 10 min old when shown, the scans inside it older still. For pre-flight and long-range planning only: never use it to negotiate a path through or near precipitation, and never in place of the regulated briefing. The alerts never read it.',
			RATE: 'Instantaneous rain rate from the EUMETNET OPERA composite, converted from reflectivity with the Marshall-Palmer relation (an uncertainty of a factor of two), refreshed every 15 min and typically 10 to 25 min old when shown, on a 2 km grid. For pre-flight and long-range planning only: never use it to negotiate a path through or near precipitation, and never in place of the regulated briefing. The alerts never read it.',
		} satisfies Record<OperaProduct, string>,
		coverageLimits: 'Show coverage limits',
		credit: {
			DBZH: 'Radar composite by EUMETNET OPERA (CC BY 4.0), produced by Météo-France.',
			RATE: 'Radar composite by EUMETNET OPERA (CC BY 4.0), produced by GeoSphere Austria.',
		} satisfies Record<OperaProduct, string>,
		expired: (p: { time: string; min: number }) =>
			`Radar expired: newest frame ${p.time}, older than ${p.min} min, echoes withdrawn.`,
		frameAge: (p: { time: string; age: string }) => `${p.time}, ${p.age}`,
		framesHeld: (p: { loaded: number; wanted: number }) => `${p.loaded} of ${p.wanted} frames loaded`,
		hidden: 'The radar layer is hidden.',
		legend: 'Precipitation radar',
		loading: 'Loading radar frames.',
		/** The shown frame drawn short of its tiles (the strip's readout). */
		frameLoading: 'loading',
		/** The tier of the SHOWN frame's own age, named beside its ink (the
		 *  feed's state is the expiry notice's business: a scrubbed older
		 *  frame of a live loop is aging or stale by its own age alone). */
		tierTitle: {
			fresh: 'Recent frame',
			aging: 'Aging frame',
			stale: 'Stale frame',
			expired: 'Frame past the expiry',
		},
		loopAria: 'Radar loop length',
		loopCapped: (n: number) => `Loop capped at ${n} frames at this zoom.`,
		loopLabel: 'Loop',
		loopLabels: { 30: '30 min', 60: '1 h', 120: '2 h' } satisfies Record<RadarLoopMin, string>,
		newestFrame: (p: { time: string; published: string; age: string }) =>
			`Newest frame ${p.time}, published ${p.published}, ${p.age}`,
		newestFrameNoPub: (p: { time: string; age: string }) => `Newest frame ${p.time}, ${p.age}`,
		noCoverage: 'No radar coverage',
		noFrames: 'No radar frame listed for the last hours.',
		now: 'now',
		opacity: 'Opacity',
		outside: 'The map is outside the European composite.',
		productAria: 'Radar product',
		productLabel: 'Product',
		productLabels: { DBZH: 'dBZ', RATE: 'mm/h' } satisfies Record<OperaProduct, string>,
		publishedAt: (time: string) => `published ${time}`,
		radar: 'Radar',
		relAge: (min: number) => `-${min} min`,
		scaleUnits: {
			DBZH: 'Reflectivity in dBZ, with the Marshall-Palmer rain rate in mm/h.',
			RATE: 'Rain rate in mm/h, with the Marshall-Palmer reflectivity in dBZ.',
		} satisfies Record<OperaProduct, string>,
		scrubAria: 'Radar frame',
		showRadar: 'Show the precipitation radar on the map',
		stepBack: 'Previous frame',
		stepForward: 'Next frame',
		words: { light: 'light', moderate: 'moderate', heavy: 'heavy', extreme: 'extreme' } satisfies Record<RadarWord, string>,
	},
	rangeStart: 'Start',
	refresh: 'Refresh',
	refreshWxTip: 'Refresh the METAR and TAF now',
	refreshedAgo: (age: string) => `refreshed ${age}`,
	searchingNearest: 'Looking for the nearest station.',
	showSigmets: 'Show SIGMET areas on the map',
	showStations: 'Show METAR stations on the map',
	showWindBarbs: 'Show wind barbs on the map',
	showing: (time: string) => `Showing ${time}.`,
	sigmet: {
		above: (level: string) => `above ${level}`,
		below: (level: string) => `below ${level}`,
	} satisfies SigmetWords,
	sigmetUntil: (hhmm: string) => `until ${hhmm} UTC`,
	sofiaCreditAnd: 'and',
	sofiaCreditPre: 'Charts by Météo-France via',
	station: {
		noCategory: 'No category',
		visibility: (v: string) => `Visibility ${v}`,
		wind: (v: string) => `Wind ${v}`,
	},
	stationCount: (n: number) => `${n} ${plural(n, 'station', 'stations')}`,
	stationsHidden: 'Stations are hidden.',
	stationsNote:
		'Station dots carry the OBSERVED wind as the smaller barbs, under the larger forecast barbs. Clicking a station opens its dedicated panel with the decoded METAR and TAF.',
	surface10m: 'Surface (10 m)',
	tafValid: (span: string) => `TAF, valid ${span}`,
	title: 'Weather',
	updating: 'Updating.',
	valid: 'Valid',
	validBeyondReach: (reach: string) => `Forecast reaches ${reach}, nothing is drawn past it.`,
	validClamped: (briefed: string) =>
		`The forecast does not reach ${briefed}, so its last hour shows.`,
	validDateAria: 'Valid date (UTC)',
	validFromCustom: 'Following your period, its start.',
	validFromFlight: "Following your period, your flight's departure.",
	validFromFlightDay: "Following your period, your flight's day.",
	validFromNow: 'Following your period, the current hour.',
	validPinned: 'Hour set by hand, it no longer follows your period.',
	validTimeAria: 'Valid time (UTC)',
	windModels: {
		arome_france: windModelLabel('arome_france'),
		arpege_europe: windModelLabel('arpege_europe'),
		best_match: windModelLabel('best_match'),
		ecmwf_ifs025: windModelLabel('ecmwf_ifs025'),
		gfs_seamless: windModelLabel('gfs_seamless'),
		icon_seamless: windModelLabel('icon_seamless'),
		meteofrance_seamless: windModelLabel('meteofrance_seamless'),
		ukmo_seamless: windModelLabel('ukmo_seamless'),
	} satisfies Record<WindModelId, string>,
	windsAloftLegend: 'Winds aloft',
	wx: (g: WeatherGroup): string => {
		if (!g.descriptor && g.phenomena.length === 0) {
			return g.raw;
		}
		if (g.intensity === '+' && !g.descriptor && g.phenomena.length === 1 && g.phenomena[0] === 'FC') {
			return 'tornado or waterspout';
		}
		const PH: Record<string, string> = {
			DZ: 'drizzle', RA: 'rain', SN: 'snow', SG: 'snow grains', IC: 'ice crystals',
			PL: 'ice pellets', GR: 'hail', GS: 'small hail', UP: 'unknown precipitation',
			BR: 'mist', FG: 'fog', FU: 'smoke', VA: 'volcanic ash', DU: 'widespread dust',
			SA: 'sand', HZ: 'haze', PY: 'spray', PO: 'dust whirls', SQ: 'squalls',
			FC: 'funnel cloud', SS: 'sandstorm', DS: 'duststorm',
		};
		const phenom = g.phenomena.map((p) => PH[p] ?? p).join(' and ');
		const withInt = (s: string): string =>
			g.intensity === '-' ? `light ${s}` : g.intensity === '+' ? `heavy ${s}` : s;
		let phrase: string;
		switch (g.descriptor) {
			case 'TS':
				phrase = phenom ? `thunderstorm with ${withInt(phenom)}` : withInt('thunderstorm');
				break;
			case 'SH':
				phrase = phenom ? `${withInt(phenom)} showers` : withInt('showers');
				break;
			case 'FZ':
				phrase = withInt(`freezing ${phenom}`);
				break;
			case 'MI':
				phrase = withInt(`shallow ${phenom}`);
				break;
			case 'PR':
				phrase = withInt(`partial ${phenom}`);
				break;
			case 'BC':
				phrase = withInt(`patches of ${phenom}`);
				break;
			case 'DR':
				phrase = withInt(`low drifting ${phenom}`);
				break;
			case 'BL':
				phrase = withInt(`blowing ${phenom}`);
				break;
			default:
				phrase = withInt(phenom);
		}
		return g.intensity === 'VC' ? `${phrase} in the vicinity` : phrase;
	},
	wxUnavailable: 'Weather unavailable (see the Refresh button).',
	zone: 'Zone',
	zoomInStations: 'Zoom in to load stations (the view spans too many fetch tiles).',
};
