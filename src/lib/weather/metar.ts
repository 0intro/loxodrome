/* Pure helpers over the AWC decoded METAR / TAF values: QNH, nearest-station
 * selection, runway wind components, freshness gates, and the display
 * formatters. No Svelte, no fetch; pinned by tests/weather.spec.ts. */

import { equirectangularDistanceM } from '$lib/notam/geometry';
import { magneticFromTrue } from '$lib/route/magnetic';
import type { AwcMetar, WxBbox } from './awc';

/** Stations farther than this never supply flight-prep defaults (50 NM). */
export const NEAREST_MAX_M = 93_000;
/** Observations older than this never supply flight-prep defaults. */
export const METAR_MAX_AGE_MIN = 180;
/** Age beyond which the freshness tint turns amber (one missed hourly
 *  observation cycle). */
export const METAR_AMBER_AGE_MIN = 75;
/** Half-extent of the nearest-station lookup box, degrees of latitude
 *  (~95 km; the longitude side widens by 1/cos(lat), capped to keep the
 *  proxy's bbox span limit). */
const NEAREST_BOX_DEG = 0.85;

/** The area-query box for a nearest-station lookup around a position,
 *  clamped to world bounds. */
export function nearestSearchBbox(lat: number, lon: number): WxBbox {
	const dLon = Math.min(2, NEAREST_BOX_DEG / Math.max(0.3, Math.cos((lat * Math.PI) / 180)));
	return {
		minLat: Math.max(-90, lat - NEAREST_BOX_DEG),
		maxLat: Math.min(90, lat + NEAREST_BOX_DEG),
		minLon: Math.max(-180, lon - dLon),
		maxLon: Math.min(180, lon + dLon),
	};
}

/** AWC's flight category (NWS convention: VFR green, MVFR blue, IFR red,
 *  LIFR magenta). */
export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR';

/** The station's flight category, normalised: absent or unrecognised reads
 *  null (AWC withholds the field when a sensor failure leaves the ceiling
 *  unknown; never guess locally from visibility alone, a failed ceilometer
 *  is not VFR). */
export function flightCategory(metar: Pick<AwcMetar, 'fltCat'>): FlightCategory | null {
	const c = metar.fltCat;
	return c === 'VFR' || c === 'MVFR' || c === 'IFR' || c === 'LIFR' ? c : null;
}

/** The station name without AWC's ", ID, CC" suffix ("Toussus-Le-Noble,
 *  ID, FR" reads "Toussus-Le-Noble"). */
export function stationName(name: string | null | undefined): string {
	return name ? name.split(',')[0].trim() : '';
}

/** Whether an aerodrome ident could name a METAR station at all: 4
 *  characters, letter first (KJFK, LFPO, K1V4). OurAirports local codes
 *  (FR-JCA, AD-ALV, LF5722) never report; skip the probe and go straight
 *  to the nearest-station lookup. */
export function isMetarCapableIdent(ident: string): boolean {
	return /^[A-Z][A-Z0-9]{3}$/.test(ident.toUpperCase());
}

/** Observation age in whole minutes. */
export function metarAgeMin(metar: Pick<AwcMetar, 'obsTime'>, nowMs: number): number {
	return Math.max(0, Math.round((nowMs / 1000 - metar.obsTime) / 60));
}

export type MetarFreshness = 'ok' | 'aging' | 'expired';

/** ok up to one missed hourly cycle, aging up to the default-injection
 *  cutoff, expired beyond (shown, never injected). */
export function metarFreshness(ageMin: number): MetarFreshness {
	if (ageMin <= METAR_AMBER_AGE_MIN) {
		return 'ok';
	}
	return ageMin <= METAR_MAX_AGE_MIN ? 'aging' : 'expired';
}

/** The QNH a pilot would set from this observation, hPa. The decoded altim
 *  is fractional for inHg stations (A2972 -> 1006.5); floor is the safe
 *  rounding for altimetry. */
export function qnhFromMetar(metar: Pick<AwcMetar, 'altim'>): number | null {
	return metar.altim == null ? null : Math.floor(metar.altim);
}

/** One observation per station, keeping the most recent. */
export function latestByStation(metars: readonly AwcMetar[]): AwcMetar[] {
	const byId = new Map<string, AwcMetar>();
	for (const m of metars) {
		const prev = byId.get(m.icaoId);
		if (!prev || m.obsTime > prev.obsTime) {
			byId.set(m.icaoId, m);
		}
	}
	return [...byId.values()];
}

export interface NearestPick {
	metar: AwcMetar;
	distanceM: number;
}

/** The nearest station within NEAREST_MAX_M, preferring (at any distance
 *  inside the cap) stations that report an altimeter over closer ones that
 *  do not, so one pick serves QNH, temperature and wind together. */
export function nearestMetar(
	metars: readonly AwcMetar[],
	lat: number,
	lon: number,
): NearestPick | null {
	let best: NearestPick | null = null;
	let bestAny: NearestPick | null = null;
	for (const m of latestByStation(metars)) {
		const d = equirectangularDistanceM(lat, lon, m.lat, m.lon);
		if (d > NEAREST_MAX_M) {
			continue;
		}
		if (!bestAny || d < bestAny.distanceM) {
			bestAny = { metar: m, distanceM: d };
		}
		if (m.altim != null && (!best || d < best.distanceM)) {
			best = { metar: m, distanceM: d };
		}
	}
	return best ?? bestAny;
}

/** Whether a nearest pick may inject flight-prep defaults: close enough and
 *  fresh enough; beyond either gate it is display-only. */
export function usableForDefaults(pick: NearestPick, nowMs: number): boolean {
	return (
		pick.distanceM <= NEAREST_MAX_M &&
		metarAgeMin(pick.metar, nowMs) <= METAR_MAX_AGE_MIN
	);
}

/** The magnetic heading (degrees) of a runway-end designator: leading
 *  digits x10 ('08L' -> 80, '26' -> 260); null when unparseable. */
export function qfuDeg(endId: string): number | null {
	const m = /^(\d{2})/.exec(endId.trim());
	if (!m) {
		return null;
	}
	const deg = Number(m[1]) * 10;
	return deg >= 10 && deg <= 360 ? deg : null;
}

export interface WindComponents {
	headwindKt: number;
	tailwindKt: number;
	crosswindKt: number;
}

/** METAR wind projected onto a runway end. The reported direction is
 *  degrees TRUE; the QFU is magnetic, so the wind is converted with the
 *  WMM declination at the aerodrome before projecting. Sustained speed
 *  only (gusts are shown, never injected). Null for variable / missing
 *  wind; calm gives zero components. */
export function windComponents(
	metar: Pick<AwcMetar, 'wdir' | 'wspd'>,
	endId: string,
	lat: number,
	lon: number,
	timeYears: number,
): WindComponents | null {
	const qfu = qfuDeg(endId);
	if (qfu == null || metar.wspd == null) {
		return null;
	}
	if (metar.wspd === 0) {
		return { headwindKt: 0, tailwindKt: 0, crosswindKt: 0 };
	}
	if (typeof metar.wdir !== 'number') {
		return null;
	}
	const windMag = magneticFromTrue(metar.wdir, lat, lon, timeYears);
	const delta = ((windMag - qfu) * Math.PI) / 180;
	const head = Math.round(metar.wspd * Math.cos(delta));
	const cross = Math.round(Math.abs(metar.wspd * Math.sin(delta)));
	return {
		headwindKt: Math.max(0, head),
		tailwindKt: Math.max(0, -head),
		crosswindKt: cross,
	};
}

/** Precipitation in the present-weather string (rain, drizzle, snow, hail,
 *  unknown precipitation), as a hint that the runway may be wet. Never
 *  drives the wet flag by itself. */
export function precipSuggestsWet(wxString: string | null | undefined): boolean {
	if (!wxString) {
		return false;
	}
	return /(RA|DZ|SN|SG|PL|GR|GS|UP)/.test(wxString);
}

/** The words these formatters weave between the values; the catalogs carry
 *  the two languages (t.weather.metar) and the formatters stay locale-free
 *  (docs/i18n.md rule 6). Functions, not bare words, so French can reorder
 *  ("25 min ago" vs "il y a 25 min"). */
export interface MetarWords {
	agoHM: (h: number, mm: string) => string;
	agoMin: (min: number) => string;
	calm: string;
	gustingKt: (kt: number) => string;
	orMore: (text: string) => string;
}

/** '240° 8 kt', gusts appended, 'VRB 3 kt', 'calm'. */
export function formatWind(
	metar: Pick<AwcMetar, 'wdir' | 'wspd' | 'wgst'>,
	words: MetarWords,
): string | null {
	if (metar.wspd == null) {
		return null;
	}
	if (metar.wspd === 0 && !metar.wgst) {
		return words.calm;
	}
	const dir =
		typeof metar.wdir === 'number' ? `${String(metar.wdir).padStart(3, '0')}°` : 'VRB';
	const gust = metar.wgst ? ` ${words.gustingKt(metar.wgst)}` : '';
	return `${dir} ${metar.wspd} kt${gust}`;
}

/** Visibility in metric terms from the API's statute miles ('6+' is the
 *  9999 / CAVOK bucket). */
export function formatVisib(
	visib: number | string | null | undefined,
	words: MetarWords,
): string | null {
	if (visib == null) {
		return null;
	}
	let sm: number;
	let orMore = false;
	if (typeof visib === 'string') {
		orMore = visib.endsWith('+');
		sm = Number.parseFloat(visib);
		if (!Number.isFinite(sm)) {
			return null;
		}
	} else {
		sm = visib;
	}
	const meters = sm * 1609.344;
	const text = meters < 5000 ? `${Math.round(meters / 100) * 100} m` : `${Math.round(meters / 1000)} km`;
	return orMore ? words.orMore(text) : text;
}

/** 'OVC 4000 ft, FEW 5000 ft'; bare covers (NSC...) keep just the code. */
export function formatClouds(
	clouds: readonly { cover: string; base: number | null }[] | undefined,
): string | null {
	if (!clouds || clouds.length === 0) {
		return null;
	}
	return clouds
		.map((c) => (c.base == null ? c.cover : `${c.cover} ${c.base} ft`))
		.join(', ');
}

/** A parsed METAR present-weather group: an optional intensity / proximity
 *  ('-' light, '+' heavy, 'VC' in the vicinity), an optional 2-letter
 *  descriptor (TS / SH / FZ / MI / PR / BC / DR / BL) and zero or more
 *  2-letter phenomena. `raw` is the original token, the render fallback for
 *  anything unrecognised. */
export interface WeatherGroup {
	intensity: '' | '-' | '+' | 'VC';
	descriptor: string;
	phenomena: string[];
	raw: string;
}

/** Renders one parsed group to text in a given locale; the vocab pack
 *  formatWeather takes (t.weather.wx). The assembly is locale-specific (EN
 *  prepends "freezing rain", FR postposes "pluie se congelant" and forms
 *  "chasse-neige"), so it lives in the catalogs, not here. */
export type WeatherVocab = (group: WeatherGroup) => string;

const WX_DESCRIPTORS = new Set(['MI', 'PR', 'BC', 'DR', 'BL', 'SH', 'TS', 'FZ']);
const WX_PHENOMENA = new Set([
	'DZ', 'RA', 'SN', 'SG', 'IC', 'PL', 'GR', 'GS', 'UP',
	'BR', 'FG', 'FU', 'VA', 'DU', 'SA', 'HZ', 'PY',
	'PO', 'SQ', 'FC', 'SS', 'DS',
]);

/** Parse a METAR present-weather string ('-RA BR', '+TSRA', 'VCSH', 'FZFG')
 *  into its space-separated groups. Pure; an unrecognised token keeps its
 *  `raw` with empty descriptor / phenomena so the renderer surfaces it
 *  verbatim rather than dropping it. */
export function parseWeather(wxString: string): WeatherGroup[] {
	const groups: WeatherGroup[] = [];
	for (const tok of wxString.trim().split(/\s+/)) {
		if (!tok) {
			continue;
		}
		let s = tok.toUpperCase();
		let intensity: WeatherGroup['intensity'] = '';
		const m = /^(VC|\+|-)/.exec(s);
		if (m) {
			intensity = m[1] as WeatherGroup['intensity'];
			s = s.slice(m[1].length);
		}
		let descriptor = '';
		if (WX_DESCRIPTORS.has(s.slice(0, 2))) {
			descriptor = s.slice(0, 2);
			s = s.slice(2);
		}
		const phenomena: string[] = [];
		while (s.length >= 2 && WX_PHENOMENA.has(s.slice(0, 2))) {
			phenomena.push(s.slice(0, 2));
			s = s.slice(2);
		}
		groups.push({ intensity, descriptor, phenomena, raw: tok });
	}
	return groups;
}

/** Decode a METAR present-weather string to human text via the locale vocab
 *  (t.weather.wx), groups comma-joined: '-RA BR' -> 'light rain, mist'. Null
 *  for an empty / absent string. */
export function formatWeather(
	wxString: string | null | undefined,
	render: WeatherVocab,
): string | null {
	if (!wxString || !wxString.trim()) {
		return null;
	}
	const parts = parseWeather(wxString).map(render).filter(Boolean);
	return parts.length > 0 ? parts.join(', ') : null;
}

/** '25 min ago', '2 h 05 ago'. */
export function formatAge(ageMin: number, words: MetarWords): string {
	if (ageMin < 120) {
		return words.agoMin(ageMin);
	}
	const h = Math.floor(ageMin / 60);
	const min = ageMin % 60;
	return words.agoHM(h, String(min).padStart(2, '0'));
}

/** Distance in whole NM for provenance lines. */
export function formatDistanceNM(distanceM: number): string {
	return `${Math.round(distanceM / 1852)} NM`;
}

/** Raw TAF split into lines at the change groups, for readable display.
 *  'PROBxx TEMPO' stays one group (the probability qualifies the TEMPO). */
export function splitRawTaf(rawTaf: string): string[] {
	const parts = rawTaf
		.trim()
		.split(/\s+(?=(?:FM\d{6}|BECMG|TEMPO|PROB\d{2}|RMK)\b)/)
		.map((s) => s.trim())
		.filter(Boolean);
	const lines: string[] = [];
	for (const part of parts) {
		const prev = lines[lines.length - 1];
		if (prev && /^PROB\d{2}$/.test(prev)) {
			lines[lines.length - 1] = `${prev} ${part}`;
		} else {
			lines.push(part);
		}
	}
	return lines;
}

/** The raw TAF as a display block: change groups on their own lines,
 *  continuation lines indented two spaces. */
export function tafBlockText(rawTaf: string): string {
	return splitRawTaf(rawTaf)
		.map((line, i) => (i === 0 ? line : `  ${line}`))
		.join('\n');
}
