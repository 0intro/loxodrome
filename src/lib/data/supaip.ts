/* Loader and types for the generated French SUP AIP dataset
 * (public/data/fr-supaip.json from cmd/supaip). One supplement per row,
 * positional layout matching outputFields in cmd/supaip/api.go. A supplement
 * carries listing metadata plus a list of named zones (CTR / TMA / ZRT ...),
 * each with its own area geometry parsed from the PDF (polygon, multipolygon,
 * or circle), bounding box, and vertical limits as airspace-style
 * [code, value, uom] triples, precomputed into datum-aware VLimits at
 * load like the airspace loader does. */

import { ceilingMaxFt, floorMinFt, fromTriple, type VerticalLimit, type VLimit } from '$lib/vertical/limits';
import { readDataJson } from '$lib/data/fetchData';
import { isPublicHoliday } from '$lib/data/frHolidays';
import type { SunLookup, SunTimes } from '$lib/notam/schedule';
import { sunLookupFor } from '$lib/route/sun';
import { resolveLangPref, type LangPref, type Locale } from '$lib/i18n/locale';

export type SupAipGeometry =
	| { type: 'polygon'; ring: [number, number][] }
	| { type: 'multipolygon'; rings: [number, number][][] }
	| { type: 'circle'; center: [number, number]; radiusM: number };

export type SupAipSource =
	| 'pdf-polygon'
	| 'pdf-circle'
	| 'pdf-mixed'
	// Belgian eSUP pages and Spanish supplement editions are HTML, not
	// PDFs (cmd/be, cmd/es).
	| 'html-polygon'
	| 'html-position'
	| 'html-circle'
	| 'html-mixed'
	| 'none';

/** One scheduled activation window for a zone, parsed from the PDF's
 * "DATES ET HEURES D'ACTIVITÉ" section. `date` is a single day (YYYY-MM-DD);
 * `dateTo` is set for a "Du ... au ..." range. `from` / `to` are "HH:MM" UTC,
 * empty for an all-day / H24 window. */
export interface SupAipActivation {
	date: string;
	dateTo?: string;
	from?: string;
	to?: string;
	/** The ISO weekdays (Monday 1) the activation holds, absent for every day
	 *  ("tous les jours sauf Samedi, Dimanche", cmd/supaip). */
	days?: number[];
	/** It skips the French public holidays (data/frHolidays.ts). */
	exceptHolidays?: boolean;
	/** It skips the day before each public holiday. */
	exceptHolidayEves?: boolean;
	/** An end the sun sets, cmd/supaip's sunCode: "SR" or "SS" and an offset
	 *  in minutes ("SS+30"). `from` or `to` beside it is absent, or a clock
	 *  bound printed too (the latest close, "MAX 1930"). */
	sunFrom?: string;
	sunTo?: string;
	/** How the zone is active over it (cmd/supaip status.go): absent when
	 *  in force throughout, "activable" when it may be activated, its real
	 *  activity known from a unit, "notam" when each activation is announced
	 *  by NOTAM. */
	mode?: 'activable' | 'notam';
	/** The shortest notice its text states for an activation, in minutes. */
	noticeMin?: number;
}

/** A rule a zone's schedule states with no dates ("ZRT activable par NOTAM
 *  avec un préavis minimum de 48 heures : 2030-0530", 191/2025), held over
 *  its supplement's validity. "unread" is a schedule printed in a form
 *  cmd/supaip leaves unread. Its clock hours are winter UTC, an hour earlier
 *  in summer where `summerEarlier`. */
export interface SupAipStanding extends Omit<SupAipActivation, 'date' | 'dateTo' | 'mode'> {
	mode?: 'activable' | 'notam' | 'unread';
	summerEarlier?: boolean;
}

/** An activation's day rule: the weekdays it holds on, and whether it skips
 *  the public holidays and their eves. */
export type SupAipDayRule = Pick<SupAipActivation, 'days' | 'exceptHolidays' | 'exceptHolidayEves'>;

/** Does the activation print a day rule (weekdays, holidays or their eves)? */
export function hasDayRule(a: SupAipDayRule): boolean {
	return (a.days?.length ?? 0) > 0 || a.exceptHolidays === true || a.exceptHolidayEves === true;
}

const DAY_MS = 86_400_000;

function isoDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** Does the activation's day rule hold the day starting at `dayMs` (UTC
 *  midnight)? An activation without a rule holds every day. */
export function activationHolds(a: SupAipDayRule, dayMs: number): boolean {
	if (a.days && a.days.length > 0) {
		const wd = new Date(dayMs).getUTCDay();
		if (!a.days.includes(wd === 0 ? 7 : wd)) {
			return false;
		}
	}
	if (a.exceptHolidays && isPublicHoliday(isoDay(dayMs))) {
		return false;
	}
	return !(a.exceptHolidayEves && isPublicHoliday(isoDay(dayMs + DAY_MS)));
}

/** Does the activation print an end the sun sets (`sunFrom`, `sunTo`)? */
export function hasSunEnd(a: SupAipHours): boolean {
	return !!(a.sunFrom || a.sunTo);
}

/** The sun at the centre of a box. */
export function boxSun(b: SupBbox | null): SunLookup | undefined {
	return b ? sunLookupFor((b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2) : undefined;
}

/** The sun at a zone: sunrise and sunset at the centre of its box, or of
 *  its supplement's where the zone has none. */
export function supZoneSun(s: SupAip, z: SupAipZone): SunLookup | undefined {
	return boxSun(z.bbox ?? s.bbox);
}

/** "HH:MM" as ms after midnight, "24:00" its day's end, or null. */
function clockMs(s: string | undefined): number | null {
	const m = s ? /^(\d{2}):(\d{2})$/.exec(s) : null;
	if (!m) {
		return null;
	}
	const ms = (Number(m[1]) * 60 + Number(m[2])) * 60_000;
	return ms <= DAY_MS ? ms : null;
}

const SUN_CODE_RE = /^(SR|SS)([+-]\d+)?$/;

/** A sun code ("SS+30") on a day's sunrise and sunset, in ms after its
 *  midnight, or null for no code. */
function sunMs(code: string | undefined, t: SunTimes): number | null {
	const m = code ? SUN_CODE_RE.exec(code) : null;
	if (!m) {
		return null;
	}
	return ((m[1] === 'SR' ? t.sunriseMin : t.sunsetMin) + Number(m[2] ?? 0)) * 60_000;
}

/** The window an activation the sun bounds holds on the day starting at
 *  `dayMs` (UTC midnight), as [start, end] epoch ms. An end the sun sets
 *  ("SS+30", cmd/supaip's sun code) is that day's sunrise or sunset at the
 *  zone plus its offset in minutes, the later of it and a clock opening
 *  beside it, the earlier of it and a clock close ("MAX 1930"). A close at
 *  or before the opening is the next day's ("SS+30" to "SR-30"). Where the
 *  sun is unknown (no position, a polar day or night), the window runs from
 *  the clock opening, else the day's start, to the clock close of the next
 *  day, else that day's end, the side that keeps the zone in force.
 *
 *  A stretch printed with clock ends ("Du 16 à 1800 au 17 à 0500", cmd/supaip
 *  clipActivations) cuts its end days at midnight: a night on its first day
 *  ends at 24:00, and its last day, opening at 00:00 and closing before the
 *  sun opens, holds the night before it up to that close.
 *
 *  The clock ends move `earlyMs` earlier and the sun's stay: hours printed
 *  in winter UTC are an hour earlier in summer (data/activity.ts), a 00:00
 *  opening then the day before's 23:00, so a night split at midnight holds
 *  whole. */
export function sunWindow(a: SupAipHours, dayMs: number, sun: SunLookup | undefined, earlyMs = 0): [number, number] {
	const clock = (s: string | undefined): number | null => {
		const ms = clockMs(s);
		return ms === null ? null : ms - earlyMs;
	};
	const from = clock(a.from);
	const to = clock(a.to);
	const wide: [number, number] = [dayMs + (from ?? 0), dayMs + DAY_MS + (to ?? DAY_MS)];
	const t = sun?.(dayMs);
	if (!t) {
		return wide;
	}
	const sunOpen = sunMs(a.sunFrom, t);
	const open = sunOpen === null ? (from ?? 0) : Math.max(sunOpen, from ?? -Infinity);
	const closeOn = (day: SunTimes): number => {
		const c = sunMs(a.sunTo, day);
		return c === null ? (to ?? DAY_MS) : Math.min(c, to ?? Infinity);
	};
	let close = closeOn(t);
	if (a.from === '00:00' && sunOpen !== null && close <= sunOpen) {
		return [dayMs - earlyMs, dayMs + close];
	}
	if (close <= open && open < DAY_MS && a.to === '24:00') {
		return [dayMs + open, dayMs + DAY_MS - earlyMs];
	}
	if (close <= open) {
		const next = a.sunTo ? sun?.(dayMs + DAY_MS) : t;
		if (!next) {
			return [dayMs + open, wide[1]];
		}
		close = closeOn(next) + DAY_MS;
	}
	return [dayMs + open, dayMs + close];
}

/** Does an activation with a day rule reach into [from, to] (epoch ms UTC)
 *  on the display filter's reading? Each run of the days it holds is one
 *  block, from its first day's opening to its last day's close, a slot that
 *  ends before it opens rolling past midnight, so a zone hides only on the
 *  days its rule takes off (supaip.svelte.ts activationOverlaps, which reads
 *  a schedule without a rule as one block). An end the sun sets is the
 *  sun's at the zone (`sun`, sunWindow). */
export function activationRunsOverlap(
	a: SupAipActivation,
	from: number,
	to: number,
	sun?: SunLookup,
): boolean {
	const first = Date.parse(`${a.date}T00:00:00Z`);
	const last = Date.parse(`${a.dateTo || a.date}T00:00:00Z`);
	if (!Number.isFinite(first) || !Number.isFinite(last)) {
		return true;
	}
	const open = a.from ? Date.parse(`1970-01-01T${a.from}:00Z`) : 0;
	let close = Date.parse(`1970-01-01T${!a.to || a.to === '24:00' ? '23:59' : a.to}:59Z`);
	if (a.from && a.to && a.to <= a.from) {
		close += DAY_MS;
	}
	const window = (d: number): [number, number] =>
		hasSunEnd(a) ? sunWindow(a, d, sun) : [d + open, d + close];
	const lo = Math.max(first, Math.floor(from / DAY_MS) * DAY_MS - DAY_MS);
	const hi = Math.min(last, Math.floor(to / DAY_MS) * DAY_MS + DAY_MS);
	for (let d = lo; d <= hi; d += DAY_MS) {
		if (!activationHolds(a, d)) {
			continue;
		}
		const next = d + DAY_MS <= last && activationHolds(a, d + DAY_MS);
		const [start, end] = window(d);
		const until = next ? Math.max(end, window(d + DAY_MS)[0]) : end;
		if (start <= to && until >= from) {
			return true;
		}
	}
	return false;
}

/** Words the panel sets beside a sun code: a clock bound printed with it. */
export interface SunBoundWords {
	earliest(time: string): string;
	latest(time: string): string;
}

/** An activation's hours as the panel prints them: "12:00 - 18:00", a sun
 *  code for an end the sun sets ("SS+30 - SR-30", "12:00 - SS"), and the
 *  clock bound beside it ("08:00 - SS+30, 19:30 at the latest"). A night a
 *  stretch cuts at midnight prints the cut (sunWindow): "SS - 24:00" on its
 *  first day, "00:00 - SR" on its last. Empty for a whole day. */
export function activationTimes(a: SupAipActivation, w: SunBoundWords): string {
	if (!hasSunEnd(a)) {
		return a.from && a.to ? `${a.from} - ${a.to}` : '';
	}
	const night = !!a.sunFrom?.startsWith('SS') && !!a.sunTo?.startsWith('SR');
	const open = night && a.from === '00:00' ? '00:00' : (a.sunFrom ?? a.from ?? '00:00');
	const close = night && a.to === '24:00' ? '24:00' : (a.sunTo ?? a.to ?? '24:00');
	const parts = [`${open} - ${close}`];
	if (a.sunFrom && a.from && a.from !== '00:00') {
		parts.push(w.earliest(a.from));
	}
	if (a.sunTo && a.to && a.to !== '24:00') {
		parts.push(w.latest(a.to));
	}
	return parts.join(', ');
}

export interface SupBbox {
	minLat: number;
	minLon: number;
	maxLat: number;
	maxLon: number;
}

/** One named sub-area of a supplement (e.g. "CTR LE MANS Temporaire"). */
export interface SupAipZone {
	name: string;
	geometry: SupAipGeometry | null;
	bbox: SupBbox | null;
	lower: VerticalLimit | null;
	upper: VerticalLimit | null;
	/** Canonical datum-aware limits, precomputed at load. No legacy-FL999
	 *  normalization here: cmd/supaip's historic UNL encoding (FL660) is
	 *  indistinguishable from a genuinely printed FL660 and is fixed at
	 *  the source; regenerated data carries the explicit UNL triple. */
	vLower: VLimit | null;
	vUpper: VLimit | null;
	geometrySource: SupAipSource;
	/** Scheduled activation windows; empty when the PDF stated none. */
	activations: SupAipActivation[];
	/** The rules its schedule states with no dates, empty when it states
	 *  none. */
	standing: SupAipStanding[];
	/** The designators whose published lateral limits the zone adopts, for a
	 *  zone the supplement states "Identiques à celles de la zone LF-D5"
	 *  with no coordinates of its own; empty otherwise. Such a zone has no
	 *  geometry: the referenced airspace is already on the map, so the panel
	 *  states the reference rather than the map drawing a duplicate ring. */
	sameAs: string;
	/** The sectors the zone takes out of its volume, each between its own
	 *  limits and during its hours ("à l'exclusion du secteur d'aérodrome
	 *  de Condom", cmd/supaip exclusions.go); empty for a whole zone. */
	exclusions: SupAipExclusion[];
	/** The airspaces its lateral limits take out of it, which the panel
	 *  names, empty when it cites none. */
	excluded: SupAipExcluded[];
}

/** An airspace a zone's lateral limits take out of it ("à l'exclusion de la
 *  LF-D595 lorsqu'elle est active", cmd/supaip exclusions.go): a P, R or D
 *  zone by its airspace id, or a zone of the same supplement by its name,
 *  and whether only while that airspace is active. The map and the alerts
 *  keep the zone whole over it, the side that alerts. */
export interface SupAipExcluded {
	id?: string | undefined;
	zone?: string | undefined;
	whenActive: boolean;
}

/** The designator an excluded P, R or D zone is cited by ("LF-R 13 A1"):
 *  its airspace row's type and name, else its id with the type set apart
 *  ("LF-R13A1") while the airspaces load. */
export function excludedDesignator(id: string, row: { type: string; name: string } | null): string {
	return row ? `LF-${row.type} ${row.name}` : id.replace(/^LF([PRD])/, 'LF-$1');
}

/** A sector a zone takes out of its volume: its outline, its own vertical
 *  limits, and the daily windows it holds in, an empty list for all day. */
export interface SupAipExclusion {
	name: string;
	geometry: SupAipGeometry;
	bbox: SupBbox | null;
	lower: VerticalLimit | null;
	upper: VerticalLimit | null;
	vLower: VLimit | null;
	vUpper: VLimit | null;
	hours: SupAipHours[];
}

/** How a sector sits in its zone's band, read whatever the ground under it:
 *  'beside' when it certainly misses the band (077/2026's CORSEN C2 opens at
 *  2500 ft over a sector topping out there), 'through' when it certainly
 *  spans the whole of it (CORSEN C1, from the surface to 2500 ft like its
 *  sector), and 'within' otherwise. The map dashes a sector within the band
 *  and cuts a hole where one goes through. */
export function exclusionSpan(z: SupAipZone, e: SupAipExclusion): 'beside' | 'within' | 'through' {
	// The lowest and highest a floor or a ceiling can lie, the surface and an
	// open side unbounded.
	const floorLo = (l: VLimit | null) => (!l || l.sfc ? -Infinity : floorMinFt(l));
	const floorHi = (l: VLimit | null) => (!l || l.sfc ? -Infinity : ceilingMaxFt(l));
	const topLo = (l: VLimit | null) => (l ? floorMinFt(l) : Infinity);
	const topHi = (l: VLimit | null) => (l ? ceilingMaxFt(l) : Infinity);
	if (topHi(e.vUpper) <= floorLo(z.vLower) || floorLo(e.vLower) >= topHi(z.vUpper)) {
		return 'beside';
	}
	if (floorHi(e.vLower) <= floorLo(z.vLower) && topLo(e.vUpper) >= topHi(z.vUpper)) {
		return 'through';
	}
	return 'within';
}

/** One daily window of a sector, its ends as an activation's (clock times,
 *  or sun codes with a clock bound beside them). */
export interface SupAipHours {
	from?: string;
	to?: string;
	sunFrom?: string;
	sunTo?: string;
}

/** One "Activité réelle connue de" entry: the unit holding a zone's real-time
 * status and the frequencies to reach it on. `note` carries a non-numeric value
 * ("fréquences de contrôle") when the SUP gives one instead of figures. */
export interface SupAipContact {
	unit: string;
	freqs: string[];
	note?: string;
	/** The INFORMATION DES USAGERS section lists the unit bare, with no
	 *  "Activité réelle connue de" over it: a unit named for users'
	 *  information. Absent when false. */
	users?: boolean | undefined;
}

/** The CONDITIONS DE PÉNÉTRATION rule: a classified `kind` plus the verbatim
 * (French) rule text. */
export interface SupAipPenetration {
	kind: 'circumvent' | 'forbidden' | 'conditional' | 'other';
	/** The rule as printed, one statement per line, a blank line between the
	 *  sections of a supplement that prints one per zone. "" when refused. */
	text: string;
	/** The supplement prints a rule cmd/supaip would not publish (set in
	 *  columns, over several zones it cannot attribute, cut open): `text` is
	 *  "" and the panel says so, since the tag alone reads as the whole rule.
	 *  Absent when false. */
	refused?: boolean | undefined;
}

export interface SupAip {
	/** Stable unique id: "<region>-<year>-<NNN>". */
	id: string;
	/** "012/2026". */
	title: string;
	/** Parsed from title; drives the cross-link to NOTAM "AIP SUP NNN/YY". */
	number: number;
	year: number;
	/** Region key: metropole, car-sam-nam, pac-n, pac-p, run. */
	region: string;
	descriptionFr: string;
	descriptionEn: string;
	lieu: string;
	/** Absolute SIA PDF URL (French). */
	urlPdf: string;
	/** Absolute SIA PDF URL (English), '' when no _en.pdf exists. */
	urlPdfEn: string;
	/** Validity window, YYYY-MM-DD, or null when the listing omitted it. */
	validFrom: string | null;
	validTo: string | null;
	ifr: boolean;
	vfr: boolean;
	/** AIRAC supplement (lf_sup_a_*). */
	airac: boolean;
	/** Affected FIR / aerodrome ICAO idents, parsed from the PDF. */
	fir: string[];
	adhp: string[];
	/** Named sub-zones, each an independently-drawable area. */
	zones: SupAipZone[];
	/** Union bounding box over all zones, or null. */
	bbox: SupBbox | null;
	geometrySource: SupAipSource;
	parseConfidence: string;
	/** Machine-readable parse-quality codes (sorted, possibly empty). */
	warnings: string[];
	/** SUP-level coordination block parsed from the PDF (cmd/supaip contacts.go):
	 * the real-activity radio contacts, the penetration rule, and the managing
	 * unit. Empty / null when the supplement carries none. */
	contacts: SupAipContact[];
	penetration: SupAipPenetration | null;
	manager: string;
	/** Every telephone number it prints, while it is in force (cmd/supaip
	 *  phones.go): the build empties the list once its validity ends. */
	phones: SupAipPhone[];
}

/** Whom a supplement's number reaches: the unit that knows the real
 *  activity, the one to call before the activity or during it, the
 *  manager, a contact. */
export type SupAipPhoneRole = 'known' | 'before' | 'during' | 'manager' | 'contact';

export interface SupAipPhone {
	role: SupAipPhoneRole;
	/** Whom it reaches as the supplement prints it, '' where it prints none. */
	label: string;
	numbers: string[];
}

const PHONE_ROLES: readonly string[] = ['known', 'before', 'during', 'manager', 'contact'];

/** The phones column read: a retained row written before it reads null. */
function readPhones(raw: unknown): SupAipPhone[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.flatMap((p: { role?: unknown; label?: unknown; numbers?: unknown }) =>
		p && typeof p.role === 'string' && PHONE_ROLES.includes(p.role) && Array.isArray(p.numbers)
			? [
					{
						role: p.role as SupAipPhoneRole,
						label: typeof p.label === 'string' ? p.label : '',
						numbers: p.numbers.filter((n): n is string => typeof n === 'string'),
					},
				]
			: [],
	);
}

/** Does the validity end before it begins? The SIA's listing dates a
 *  supplement cancelled before it came into force that way, its end being
 *  the day it was cancelled, and cmd/supaip ends one a successor replaced
 *  before it began the same way, so such a validity holds no day at all. */
export function validityEmpty(s: SupAip): boolean {
	return s.validFrom !== null && s.validTo !== null && s.validTo < s.validFrom;
}

/** A zone's own schedule inside its supplement's validity: each activation's
 *  days cut to [validFrom, validTo], an activation left with no day dropped.
 *  Null when the zone carries no schedule, for the caller to fall back to the
 *  validity itself.
 *
 *  The validity bounds the schedule because the SIA ends a supplement early
 *  by moving its validity, never by reprinting its schedule: 133/2026 was
 *  listed to 14 August once 173/2026 replaced it, while its PDF still printed
 *  its ZRT's windows to 31 December. A day is kept whole, so the night that
 *  opens on the validity's last day runs on to its morning. */
export function zoneSchedule(s: SupAip, z: SupAipZone): SupAipActivation[] | null {
	if (z.activations.length === 0) {
		return null;
	}
	const out: SupAipActivation[] = [];
	for (const a of z.activations) {
		const last = a.dateTo ?? a.date;
		const from = s.validFrom !== null && s.validFrom > a.date ? s.validFrom : a.date;
		const to = s.validTo !== null && s.validTo < last ? s.validTo : last;
		if (to < from) {
			continue;
		}
		if (from === a.date && to === last) {
			out.push(a);
			continue;
		}
		const cut: SupAipActivation = { ...a, date: from };
		if (to !== from) {
			cut.dateTo = to;
		} else {
			delete cut.dateTo;
		}
		out.push(cut);
	}
	return out;
}

type RawBbox = [number, number, number, number] | null;

interface RawZone {
	name: string;
	geometry: SupAipGeometry | null;
	bbox: RawBbox;
	lower: VerticalLimit | null;
	upper: VerticalLimit | null;
	geometrySource: string;
	activations?: SupAipActivation[];
	standing?: SupAipStanding[];
	sameAs?: string;
	exclusions?: RawExclusion[];
	excluded?: { id?: string; zone?: string; whenActive?: boolean }[];
}

interface RawExclusion {
	name: string;
	geometry: SupAipGeometry | null;
	bbox: RawBbox;
	lower: VerticalLimit | null;
	upper: VerticalLimit | null;
	hours?: SupAipHours[];
}

// Positional row layout, matching outputFields in cmd/supaip/api.go.
type SupAipRow = readonly [
	id: string,
	title: string,
	region: string,
	descriptionFr: string,
	descriptionEn: string,
	lieu: string,
	urlPdf: string,
	validFrom: string,
	validTo: string,
	ifr: boolean,
	vfr: boolean,
	airac: boolean,
	fir: string[],
	adhp: string[],
	zones: RawZone[],
	bbox: RawBbox,
	geometrySource: string,
	parseConfidence: string,
	warnings: string[],
	urlPdfEn: string,
	contacts: SupAipContact[],
	penetration: SupAipPenetration | null,
	manager: string,
	phones: unknown,
];

interface RawSupAip {
	fields: string[];
	rows: readonly SupAipRow[];
}

function toBbox(b: RawBbox): SupBbox | null {
	return b ? { minLat: b[0], minLon: b[1], maxLat: b[2], maxLon: b[3] } : null;
}

function rowToSupAip(r: SupAipRow): SupAip {
	const title = r[1];
	const slash = title.indexOf('/');
	const number = slash > 0 ? parseInt(title.slice(0, slash), 10) : NaN;
	const year = slash > 0 ? parseInt(title.slice(slash + 1), 10) : NaN;
	const zones: SupAipZone[] = (r[14] ?? []).map((z) => ({
		name: z.name ?? '',
		geometry: z.geometry ?? null,
		bbox: toBbox(z.bbox),
		lower: z.lower ?? null,
		upper: z.upper ?? null,
		vLower: fromTriple(z.lower ?? null),
		vUpper: fromTriple(z.upper ?? null),
		geometrySource: (z.geometrySource as SupAipSource) ?? 'none',
		activations: z.activations ?? [],
		standing: z.standing ?? [],
		sameAs: z.sameAs ?? '',
		exclusions: (z.exclusions ?? []).flatMap((e) =>
			e.geometry
				? [
						{
							name: e.name ?? '',
							geometry: e.geometry,
							bbox: toBbox(e.bbox),
							lower: e.lower ?? null,
							upper: e.upper ?? null,
							vLower: fromTriple(e.lower ?? null),
							vUpper: fromTriple(e.upper ?? null),
							hours: e.hours ?? [],
						},
					]
				: [],
		),
		excluded: (z.excluded ?? []).flatMap((e) =>
			e.id || e.zone ? [{ id: e.id, zone: e.zone, whenActive: e.whenActive === true }] : [],
		),
	}));
	return {
		id: r[0],
		title,
		number,
		year,
		region: r[2],
		descriptionFr: r[3] ?? '',
		descriptionEn: r[4] ?? '',
		lieu: r[5] ?? '',
		urlPdf: r[6] ?? '',
		urlPdfEn: r[19] ?? '',
		validFrom: r[7] || null,
		validTo: r[8] || null,
		ifr: !!r[9],
		vfr: !!r[10],
		airac: !!r[11],
		fir: r[12] ?? [],
		adhp: r[13] ?? [],
		zones,
		bbox: toBbox(r[15]),
		geometrySource: (r[16] as SupAipSource) ?? 'none',
		parseConfidence: r[17] ?? 'none',
		warnings: r[18] ?? [],
		contacts: r[20] ?? [],
		penetration: r[21] ?? null,
		manager: r[22] ?? '',
		phones: readPhones(r[23]),
	};
}

export const SUPAIP_URL = '/data/fr-supaip.json';

/** The language a supplement's subject reads in: the SUP AIP language
 *  preference resolved against the interface's, where the supplement
 *  publishes an English subject, else 'fr', the pole that names the
 *  supplement's own language (Spanish for a Spanish one). */
export function supaipSubjectLang(s: SupAip, pref: LangPref, locale: Locale): Locale {
	return s.descriptionEn ? resolveLangPref(pref, locale) : 'fr';
}

/** A supplement's subject in that language, the other slot standing in for
 *  an empty one (a Belgian supplement publishes English alone). */
export function supaipSubject(s: SupAip, pref: LangPref, locale: Locale): string {
	return supaipSubjectLang(s, pref, locale) === 'en'
		? s.descriptionEn
		: s.descriptionFr || s.descriptionEn;
}

/** Belgian AIP Supplements (cmd/be, the skeyes eSUP section). Same row
 *  schema; region 'be', English-only subjects, urlPdfEn carrying the
 *  supplement's HTML page (no PDF twins exist). */
export const BE_SUPAIP_URL = '/data/be-supaip.json';

/** Spanish AIP Supplements (cmd/es, the ENAIRE public listing). Same row
 *  schema; region 'es', the Spanish subject in descriptionFr (the
 *  local-language slot) and the English one beside it, both PDF editions
 *  linked. */
export const ES_SUPAIP_URL = '/data/es-supaip.json';

/** The publishers whose supplements a NOTAM can cite by number.
 *
 *  The citation namespaces COLLIDE: every publisher numbers its
 *  supplements NNN/YYYY from one each year, and so does each of France's
 *  overseas regions, so "SUP 149/26" means a different document
 *  depending on who wrote the NOTAM. Lookups are therefore keyed by
 *  publisher, resolved from the citing NOTAM's own FIR. */
export type SupAipPublisher = 'fr' | 'es';

/** The publisher whose citation namespace a supplement belongs to, or
 *  null when it is in none: France's overseas regions number
 *  independently of the metropole, and Belgium's eSUP series is never
 *  cited this way. */
export function supaipPublisherOf(s: SupAip): SupAipPublisher | null {
	if (s.region === 'metropole') {
		return 'fr';
	}
	if (s.region === 'es') {
		return 'es';
	}
	return null;
}

/** Load one publisher's SUP AIP artefact. Rejects on any failure, a
 *  transient one saying so (src/lib/data/fetchData.ts), so ensureSupaip
 *  can publish the publishers that loaded and read the others again. */
export async function loadSupAip(url: string = SUPAIP_URL): Promise<SupAip[]> {
	// THROW, never return an empty list. An empty list is a STATEMENT here,
	// and a briefing surface prints it as one: "No supplement in force in the
	// period." Swallowing a 503, an offline fetch or an HTML error page into
	// that statement told a pilot a live ZRT did not exist. It also emptied
	// the map layer and the SUP AIP half of the airspace alerts under the
	// same silence. The caller already treats a rejection properly: each
	// publisher's set is settled alone, one source failing leaves the others
	// standing, and only every source failing is the dataset failing
	// (ensureSupaip), which is machinery a fail-soft return had made dead.
	// The pilot reads the catalog's own failure line, never the message.
	const data = await readDataJson<RawSupAip>(url);
	return data.rows.map(rowToSupAip);
}
