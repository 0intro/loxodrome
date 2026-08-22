/* Serialise / parse the saved-routes YAML document. Pure (no Svelte, no I/O) so
 * it is unit-testable and reusable by the offline library converter.
 *
 * The file is route / leg / waypoint (FAA + GPX vocabulary). On load only the
 * essential inputs are read back: each waypoint's `ident` (anchored: airports
 * before navaids) or `lat`/`lon` (free points), its `name`/`notes`/
 * `frequencies_manual`, each leg's `altitude`/`auto`, and (only to place a
 * name-only waypoint by dead reckoning) its `course`/`distance`. Every other
 * field (`frequencies`, `airspace`, `radial`, and the rest of `leg:`) is a
 * recomputed nav-log snapshot, written for a readable document but ignored on
 * load. See parseRoutesDoc / buildRoutesDoc. */

import { isMap, parse, parseDocument, stringify } from 'yaml';
import type { WaypointKind } from '$lib/state/route.svelte';

export const ROUTES_DOC_VERSION = 1;

// i18n-ignore-start: saved-file header comment stays EN (docs/i18n.md rule 10;
// interchange file also read by the external Python tool)
const HEADER_COMMENT =
	' Saved by Loxodrome (loxodrome.fr). route / leg / waypoint.\n' +
	' On load only these are read: each waypoint\'s ident (anchored: coords + freq\n' +
	' + label resolved from current data, airports before navaids) or lat / lon\n' +
	' (free points), its name / notes / frequencies_manual (manual nav-log\n' +
	' frequencies; frequencies then repeats them as the effective text, the\n' +
	' leg.wind idiom), leg.altitude / leg.auto, and\n' +
	' leg.wind_dir / leg.wind_speed (a manual per-leg wind override, degrees true\n' +
	' / knots). Every other field (frequencies, airspace, radial, the rest of\n' +
	' each leg: incl. leg.wind, the effective wind snapshot) is a recomputed\n' +
	' nav-log snapshot, ignored on load. A route\'s role: alternate marks a\n' +
	' diversion of the preceding trip route; settings holds the route-wide\n' +
	' planning options (VFR, semicircular cruising levels, transition altitude,\n' +
	' forecast winds, temperature-corrected TAS) and flight_prep the\n' +
	' flight-preparation inputs (aircraft, fuel, mass & balance, performance),\n' +
	' both also read back on load.';
// i18n-ignore-end

/** Longest a plan name may be. It is a CAPTION, not a description: the cap is
 *  what keeps a pasted paragraph out of the catalog's table row and out of the
 *  file names the name feeds. */
const PLAN_NAME_MAX = 80;

/** The plan name as it is written AND as it is read back: trimmed, folded to
 *  one line (a caption that wrapped would break the table row and the scalar
 *  alike), capped, blank to null. Both sides on purpose: it is what makes the
 *  surgical rename below and a full rebuild agree on the bytes, so a rename
 *  followed by a Store cannot flip-flop the file. */
export function normalizePlanName(raw: string | null | undefined): string | null {
	if (typeof raw !== 'string') {
		return null;
	}
	const one = raw.replace(/\s+/g, ' ').trim().slice(0, PLAN_NAME_MAX).trim();
	return one === '' ? null : one;
}

/** Minimal waypoint shape the writer needs (a structural subset of Waypoint, so
 *  the app passes its Waypoint and the converter passes a constructed object). */
export interface SaveWaypoint {
	kind: WaypointKind;
	ident?: string | undefined;
	lat: number;
	lon: number;
	/** Custom label (free points) / airport-navaid name. */
	label?: string | undefined;
	/** Planned cruise altitude (ft) of the leg leaving this waypoint. */
	alt: number;
	/** Whether that altitude is auto-managed (the VFR Class A rule). */
	altAuto: boolean;
	/** Manual wind override of the leg leaving this waypoint (° true / kt),
	 *  written and read back only when both are set; absent = automatic
	 *  (forecast, else the global wind). */
	windDirDeg?: number | undefined;
	windSpeedKt?: number | undefined;
	notes?: string | undefined;
	/** Manual nav-log frequencies (multi-line), written and read back as
	 *  `frequencies_manual`; absent = automatic. The `frequencies` snapshot
	 *  then repeats the same effective text, saved-only (the leg.wind idiom). */
	freqsManual?: string | undefined;
}

/** Saved-only computed values for one leg (the hop leaving waypoint i). */
export interface LegNavlog {
	course?: number;
	heading?: number | undefined;
	distance?: number;
	distanceRemaining?: number;
	safetyAltitude?: number | null;
	ete?: number | undefined;
	/** Effective wind the heading / ete were computed with ("247°/18 kt"),
	 *  saved for the reader, ignored on load (leg.wind_dir / wind_speed are
	 *  the read-back override, this display string is not). */
	wind?: string | undefined;
}

/** Saved-only per-waypoint info. */
export interface WaypointInfo {
	frequencies?: string | undefined;
	airspace?: string | undefined;
	radial?: string | undefined;
}

/** Route-wide planning options that round-trip through the file's `settings:`
 *  block; the rest of routeSettings is session-only view state. */
export interface RouteSettingsDoc {
	vfr: boolean;
	/** Semicircular cruising levels enforced (SERA Appendix 3). */
	semicircular: boolean;
	/** Transition altitude (ft) manual override; null = automatic (derived
	 *  from the AIP data at display time, and NOT written to the file). */
	transitionAltitudeFt: number | null;
	/** Legs planned on the per-leg Open-Meteo forecast wind. */
	windForecast: boolean;
	/** Cruise TAS corrected for the forecast temperature per leg. */
	temperatureTas: boolean;
}

/** A route plus the nav-log the Save side computed for it (index-aligned:
 *  `legs[i]` is the hop leaving `waypoints[i]`, `info[i]` is waypoint i). */
export interface RouteForSave {
	name: string | null;
	waypoints: SaveWaypoint[];
	legs?: LegNavlog[];
	info?: WaypointInfo[];
	/** Alternate (diversion) of the preceding trip route. */
	alternate?: boolean | undefined;
}

/** The flight-preparation block saved under `flight_prep:` (inputs only;
 *  litres, distances and verdicts are recomputed on load, like the nav-log
 *  snapshot). One shape serves the writer and the tolerant loader: every
 *  field is optional and missing pieces fall back to the app defaults. */
export interface FlightPrepDoc {
	/** Selected aircraft registration; kept verbatim even when unknown. */
	aircraft?: string | undefined;
	dossier?: FlightPrepDossier | undefined;
	/** Index-aligned with the non-alternate (trip) routes, in list order. */
	fuelTrips?: FlightPrepTrip[] | undefined;
	massBalance?: FlightPrepMassBalance | undefined;
	aerodromes?: FlightPrepAerodrome[] | undefined;
}

/** The dossier (front) page's inputs. */
export interface FlightPrepDossier {
	/** Flight date 'YYYY-MM-DD' (UTC). */
	flightDate?: string | undefined;
	/** First departure 'HH:MM' UTC. */
	departureTime?: string | undefined;
	/** Ground stop after trip i, minutes (between-trip stops only); a null slot
	 *  states no stop time, which is what an untouched one means. */
	stopsMin?: (number | null)[] | undefined;
	pilotName?: string | undefined;
	sepValidUntil?: string | undefined;
	medicalValidUntil?: string | undefined;
	/** Airframe potential (remaining duration before the next engine check)
	 *  as an 'H:MM' string like '28:08', the sheet's display form; the
	 *  loader parses it back to minutes. */
	potential?: string | undefined;
	/** Default QNH (hPa), the performance page's fallback. */
	qnhHpa?: number | undefined;
	/** Ids of the CHECKED dossier checklist items (see DOSSIER_CHECKS). */
	checks?: string[] | undefined;
}

export interface FlightPrepTrip {
	taxiMin?: number | undefined;
	procedureMin?: number | undefined;
	alternateProcedureMin?: number | undefined;
	marginMin?: number | undefined;
	finalReserveMin?: number | undefined;
}

export interface FlightPrepMassBalance {
	/** Station label -> mass kg (labels as in the aircraft data sheet). */
	loads?: Record<string, number> | undefined;
	fuelMode?: string | undefined;
	/** Only meaningful with fuelMode 'custom'. */
	fuelLitres?: number | undefined;
}

export interface FlightPrepPerfBlock {
	temperatureC?: number | undefined;
	headwindKt?: number | undefined;
	tailwindKt?: number | undefined;
	wet?: boolean | undefined;
	/** A specific runway end (QFU), e.g. '26'; always a string. */
	runwayEnd?: string | undefined;
}

export interface FlightPrepAerodrome {
	icao: string;
	qnhHpa?: number | undefined;
	takeoff?: FlightPrepPerfBlock | undefined;
	landing?: FlightPrepPerfBlock | undefined;
}

function round(n: number, dp: number): number {
	const f = 10 ** dp;
	return Math.round(n * f) / f;
}

function displayName(w: SaveWaypoint): string {
	if (w.kind !== 'free' && w.ident) {
		return w.ident;
	}
	return w.label || `${w.lat.toFixed(3)}, ${w.lon.toFixed(3)}`;
}

function buildLeg(w: SaveWaypoint, nav: LegNavlog | undefined): Record<string, unknown> {
	const leg: Record<string, unknown> = { altitude: Math.round(w.alt), auto: w.altAuto };
	// The read-back override; the effective-wind snapshot below (leg.wind) is
	// saved-only, so a forecast value never turns into an override on load.
	if (w.windDirDeg != null && w.windSpeedKt != null) {
		leg.wind_dir = Math.round(w.windDirDeg);
		leg.wind_speed = Math.round(w.windSpeedKt);
	}
	if (nav) {
		if (nav.course != null) leg.course = Math.round(nav.course);
		if (nav.heading != null) leg.heading = Math.round(nav.heading);
		if (nav.distance != null) leg.distance = round(nav.distance, 1);
		if (nav.distanceRemaining != null) leg.distance_remaining = round(nav.distanceRemaining, 1);
		if (nav.safetyAltitude != null) leg.safety_altitude = Math.round(nav.safetyAltitude);
		if (nav.ete != null) leg.ete = Math.round(nav.ete);
		if (nav.wind != null) leg.wind = nav.wind;
	}
	return leg;
}

function buildWaypoint(
	w: SaveWaypoint,
	i: number,
	n: number,
	legs: LegNavlog[] | undefined,
	info: WaypointInfo[] | undefined,
): Record<string, unknown> {
	const obj: Record<string, unknown> = { name: displayName(w) };
	if (w.kind !== 'free' && w.ident) {
		obj.ident = w.ident;
	} else {
		obj.lat = round(w.lat, 5);
		obj.lon = round(w.lon, 5);
	}
	if (w.notes) {
		obj.notes = w.notes;
	}
	// The read-back override; the effective-text snapshot below (frequencies)
	// is saved-only, so an automatic list never turns into an override on load.
	if (w.freqsManual != null) {
		obj.frequencies_manual = w.freqsManual;
	}
	const wi = info?.[i];
	if (wi?.frequencies) obj.frequencies = wi.frequencies;
	if (wi?.airspace) obj.airspace = wi.airspace;
	if (wi?.radial) obj.radial = wi.radial;
	// The leg block describes the hop leaving this fix; the last fix has none.
	if (i < n - 1) {
		obj.leg = buildLeg(w, legs?.[i]);
	}
	return obj;
}

function buildPerfBlock(b: FlightPrepPerfBlock): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (b.temperatureC != null) out.temperature = b.temperatureC;
	// A typed 0 is an explicit calm and persists; unset arrives here as
	// undefined (absent key), which follows the METAR on reload.
	if (b.headwindKt != null) out.headwind = b.headwindKt;
	if (b.tailwindKt != null) out.tailwind = b.tailwindKt;
	if (b.wet) out.wet = true;
	if (b.runwayEnd) out.runway = b.runwayEnd;
	return out;
}

function buildDossierBlock(d: FlightPrepDossier): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (d.flightDate) out.flight_date = d.flightDate;
	if (d.departureTime) out.departure_time = d.departureTime;
	if (d.stopsMin && d.stopsMin.some((n) => n != null)) out.stops = d.stopsMin;
	const pilot: Record<string, unknown> = {};
	if (d.pilotName) pilot.name = d.pilotName;
	if (d.sepValidUntil) pilot.sep_valid_until = d.sepValidUntil;
	if (d.medicalValidUntil) pilot.medical_valid_until = d.medicalValidUntil;
	if (Object.keys(pilot).length > 0) out.pilot = pilot;
	if (d.potential) out.potential = d.potential;
	if (d.qnhHpa != null) out.qnh = d.qnhHpa;
	if (d.checks && d.checks.length > 0) out.checks = d.checks;
	return out;
}

function buildFlightPrepBlock(fp: FlightPrepDoc): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (fp.aircraft) {
		out.aircraft = fp.aircraft;
	}
	if (fp.dossier) {
		const block = buildDossierBlock(fp.dossier);
		if (Object.keys(block).length > 0) {
			out.dossier = block;
		}
	}
	if (fp.fuelTrips && fp.fuelTrips.length > 0) {
		out.fuel = {
			trips: fp.fuelTrips.map((t) => {
				const trip: Record<string, unknown> = {};
				if (t.taxiMin != null) trip.taxi = t.taxiMin;
				if (t.procedureMin != null) trip.procedure = t.procedureMin;
				if (t.alternateProcedureMin != null) trip.alternate_procedure = t.alternateProcedureMin;
				if (t.marginMin != null) trip.margin = t.marginMin;
				// Absent = auto (the derived day/night default).
				if (t.finalReserveMin != null) trip.final_reserve = t.finalReserveMin;
				return trip;
			}),
		};
	}
	if (fp.massBalance) {
		const mb = fp.massBalance;
		const block: Record<string, unknown> = {};
		if (mb.loads && Object.keys(mb.loads).length > 0) block.loads = mb.loads;
		if (mb.fuelMode) block.fuel_mode = mb.fuelMode;
		if (mb.fuelLitres != null) block.fuel_litres = mb.fuelLitres;
		if (Object.keys(block).length > 0) out.mass_balance = block;
	}
	if (fp.aerodromes && fp.aerodromes.length > 0) {
		out.performance = {
			aerodromes: fp.aerodromes.map((a) => {
				const ad: Record<string, unknown> = { icao: a.icao };
				if (a.qnhHpa != null) ad.qnh = a.qnhHpa;
				if (a.takeoff) {
					const b = buildPerfBlock(a.takeoff);
					if (Object.keys(b).length > 0) ad.takeoff = b;
				}
				if (a.landing) {
					const b = buildPerfBlock(a.landing);
					if (Object.keys(b).length > 0) ad.landing = b;
				}
				return ad;
			}),
		};
	}
	return out;
}

/** Build the plain document object (version + optional name + routes +
 *  optional flight_prep) ready for stringifyRoutesDoc. */
export function buildRoutesDoc(
	routes: RouteForSave[],
	flightPrep?: FlightPrepDoc,
	settings?: RouteSettingsDoc,
	planName?: string | null,
): Record<string, unknown> {
	const doc: Record<string, unknown> = { version: ROUTES_DOC_VERSION };
	// The plan's own descriptive name, ahead of everything it captions and
	// omitted when there is none, so an unnamed plan's bytes never move.
	const name = normalizePlanName(planName);
	if (name !== null) {
		doc.name = name;
	}
	if (settings) {
		doc.settings = {
			vfr: settings.vfr,
			semi_circular: settings.semicircular,
			// Manual override only; an absent key means automatic on load.
			...(settings.transitionAltitudeFt !== null
				? { transition_altitude: Math.round(settings.transitionAltitudeFt) }
				: {}),
			wind_forecast: settings.windForecast,
			temperature_tas: settings.temperatureTas,
		};
	}
	doc.routes = routes.map((r) => {
		const route: Record<string, unknown> = {};
		// Omit name when unset: the loader derives the label from the endpoints.
		if (r.name) {
			route.name = r.name;
		}
		if (r.alternate) {
			route.role = 'alternate';
		}
		route.waypoints = r.waypoints.map((w, i) =>
			buildWaypoint(w, i, r.waypoints.length, r.legs, r.info),
		);
		return route;
	});
	if (flightPrep) {
		const block = buildFlightPrepBlock(flightPrep);
		if (Object.keys(block).length > 0) {
			doc.flight_prep = block;
		}
	}
	return doc;
}

/** Serialise a document object to YAML text with the loaded-vs-saved header. */
export function stringifyRoutesDoc(doc: Record<string, unknown>): string {
	// lineWidth 0 disables wrapping so multi-line frequencies / notes stay as
	// literal block scalars and long lines aren't folded.
	const body = stringify(doc, { lineWidth: 0 });
	const header = HEADER_COMMENT.split('\n')
		.map((l) => `#${l}`)
		.join('\n');
	return `${header}\n${body}`;
}

/** Set (or clear) the top-level plan name in an EXISTING document's text,
 *  touching nothing else. The catalog's rename writes a stored file this way
 *  rather than through parseRoutesDoc + buildRoutesDoc, which would drop every
 *  saved-only field the format declares ignored on load (the whole `leg:`
 *  nav-log snapshot) out of a file the user may have downloaded and an
 *  external tool may read.
 *
 *  The pair goes in at index 1, never 0: the `#` header block parses as the
 *  `version` pair's own leading comment, so an insert at the head would emit
 *  the name ABOVE the header. Text that does not parse, or whose root is not a
 *  mapping, comes back untouched; the Plans view does not offer to rename a row
 *  it cannot read either. */
export function withPlanName(text: string, name: string | null): string {
	const doc = parseDocument(text);
	if (doc.errors.length > 0 || !isMap(doc.contents)) {
		return text;
	}
	const value = normalizePlanName(name);
	if (value === null) {
		doc.delete('name');
	} else if (doc.has('name')) {
		doc.set('name', value);
	} else {
		doc.contents.items.splice(1, 0, doc.createPair('name', value));
	}
	// lineWidth 0 for the same reason stringifyRoutesDoc passes it: a long
	// scalar anywhere in the file must not fold on the way back out.
	return doc.toString({ lineWidth: 0 });
}

/** One waypoint's loaded (round-trip) fields, after parse. */
export interface LoadedWaypoint {
	name?: string | undefined;
	ident?: string | undefined;
	lat?: number | undefined;
	lon?: number | undefined;
	notes?: string | undefined;
	/** From frequencies_manual: the manual nav-log frequencies (multi-line);
	 *  absent = automatic (the saved-only `frequencies` snapshot is ignored). */
	freqsManual?: string | undefined;
	/** From leg.altitude (the cruise of the hop leaving this fix); undefined on the
	 *  last waypoint. */
	altitude?: number | undefined;
	/** From leg.auto. */
	auto?: boolean | undefined;
	/** From leg.course / leg.distance (the hop leaving this fix). Read only to
	 *  dead-reckon a name-only waypoint's position (see route/reconstruct). */
	course?: number | undefined;
	distance?: number | undefined;
	/** From leg.wind_dir / leg.wind_speed: the manual per-leg wind override
	 *  (present only when both parse). */
	windDirDeg?: number | undefined;
	windSpeedKt?: number | undefined;
}

export interface LoadedRoute {
	name: string | null;
	waypoints: LoadedWaypoint[];
	/** From `role: alternate`; absent = a trip. */
	alternate?: boolean | undefined;
}

/** The settings block's loaded fields; each undefined when absent or
 *  malformed, so the loader applies only the keys the file states. */
export interface LoadedSettings {
	vfr?: boolean | undefined;
	semicircular?: boolean | undefined;
	transitionAltitudeFt?: number | undefined;
	windForecast?: boolean | undefined;
	temperatureTas?: boolean | undefined;
}

export interface ParsedRoutesDoc {
	routes: LoadedRoute[];
	/** The plan's own descriptive name, when the file carries one. `planName`
	 *  and not `name` on purpose: `LoadedRoute.name` is the ROUTE label one
	 *  field away and the matcher's `CandidatePlan.name` is the file label, so
	 *  "nothing in the matching path reads the plan name" stays a grep. */
	planName?: string | undefined;
	/** The route-wide planning options, when the file carries them. Tolerant
	 *  like flight_prep: malformed values degrade to undefined. */
	settings?: LoadedSettings | undefined;
	/** The flight-preparation inputs, when the file carries them. A malformed
	 *  block degrades to undefined / skipped entries, never an error. */
	flightPrep?: FlightPrepDoc | undefined;
}

function fail(msg: string): never {
	// i18n-ignore: route-file parse diagnostic, stays EN (file-format errors, docs/i18n.md rule 7; the aircraft-schema deferral)
	throw new Error(`Invalid route file: ${msg}`);
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) {
		// i18n-ignore: route-file parse diagnostic, stays EN (file-format errors, docs/i18n.md rule 7; the aircraft-schema deferral)
		fail(`${what} must be a mapping`);
	}
	return v as Record<string, unknown>;
}

function optNumber(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function optString(v: unknown): string | undefined {
	return typeof v === 'string' && v !== '' ? v : undefined;
}

function asRecordOrNull(v: unknown): Record<string, unknown> | null {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;
}

function optBoolean(v: unknown): boolean | undefined {
	return typeof v === 'boolean' ? v : undefined;
}

/** A runway end like '26' or '08'. The writer emits strings, but YAML reads a
 *  bare 08-style scalar as a number, so coerce + zero-pad. */
function optRunwayEnd(v: unknown): string | undefined {
	if (typeof v === 'string' && v !== '') {
		return v;
	}
	if (typeof v === 'number' && Number.isFinite(v)) {
		return String(v).padStart(2, '0');
	}
	return undefined;
}

/** An ISO calendar date 'YYYY-MM-DD'. The writer emits strings (the yaml
 *  package's 1.2 core schema has no timestamp type), but defensively format
 *  a Date back should another emitter have tagged one. */
function optIsoDate(v: unknown): string | undefined {
	if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
		return v;
	}
	if (v instanceof Date && !Number.isNaN(v.getTime())) {
		const p = (n: number) => String(n).padStart(2, '0');
		return `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())}`;
	}
	return undefined;
}

/** A wall-clock 'HH:MM', re-padded from a lax H:MM. (YAML 1.2 core reads
 *  07:30 as a plain string, no sexagesimals; the regex is the guarantee.) */
function optClock(v: unknown): string | undefined {
	if (typeof v !== 'string') {
		return undefined;
	}
	const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v);
	return m ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined;
}

function parseDossier(raw: unknown): FlightPrepDossier | undefined {
	const d = asRecordOrNull(raw);
	if (!d) {
		return undefined;
	}
	const pilot = asRecordOrNull(d.pilot);
	let stopsMin: (number | null)[] | undefined;
	if (Array.isArray(d.stops)) {
		// Anything that is not a stated duration (null, junk, negative) is a
		// slot the file does not set.
		stopsMin = d.stops.map((s) => {
			const n = optNumber(s);
			return n != null && n >= 0 ? n : null;
		});
	}
	let checks: string[] | undefined;
	if (Array.isArray(d.checks)) {
		checks = d.checks.filter((c): c is string => typeof c === 'string' && c !== '');
	}
	return {
		flightDate: optIsoDate(d.flight_date),
		departureTime: optClock(d.departure_time),
		stopsMin,
		pilotName: pilot ? optString(pilot.name) : undefined,
		sepValidUntil: pilot ? optIsoDate(pilot.sep_valid_until) : undefined,
		medicalValidUntil: pilot ? optIsoDate(pilot.medical_valid_until) : undefined,
		potential: optString(d.potential),
		qnhHpa: optNumber(d.qnh),
		checks,
	};
}

function parsePerfBlock(raw: unknown): FlightPrepPerfBlock | undefined {
	const b = asRecordOrNull(raw);
	if (!b) {
		return undefined;
	}
	return {
		temperatureC: optNumber(b.temperature),
		headwindKt: optNumber(b.headwind),
		tailwindKt: optNumber(b.tailwind),
		wet: optBoolean(b.wet),
		runwayEnd: optRunwayEnd(b.runway),
	};
}

/** Tolerant `flight_prep:` parse: any malformed piece is skipped (defaults
 *  apply on load); only well-formed entries survive. Never throws. */
function parseFlightPrep(raw: unknown): FlightPrepDoc | undefined {
	const root = asRecordOrNull(raw);
	if (!root) {
		return undefined;
	}
	const fp: FlightPrepDoc = { aircraft: optString(root.aircraft) };
	fp.dossier = parseDossier(root.dossier);
	const fuel = asRecordOrNull(root.fuel);
	if (fuel && Array.isArray(fuel.trips)) {
		fp.fuelTrips = fuel.trips.map((rawT): FlightPrepTrip => {
			const t = asRecordOrNull(rawT);
			return t
				? {
						taxiMin: optNumber(t.taxi),
						procedureMin: optNumber(t.procedure),
						alternateProcedureMin: optNumber(t.alternate_procedure),
						marginMin: optNumber(t.margin),
						finalReserveMin: optNumber(t.final_reserve),
					}
				: {};
		});
	}
	const mb = asRecordOrNull(root.mass_balance);
	if (mb) {
		let loads: Record<string, number> | undefined;
		const rawLoads = asRecordOrNull(mb.loads);
		if (rawLoads) {
			loads = {};
			for (const [label, v] of Object.entries(rawLoads)) {
				const n = optNumber(v);
				if (n != null && n >= 0) {
					loads[label] = n;
				}
			}
		}
		fp.massBalance = {
			loads,
			fuelMode: optString(mb.fuel_mode),
			fuelLitres: optNumber(mb.fuel_litres),
		};
	}
	const perf = asRecordOrNull(root.performance);
	if (perf && Array.isArray(perf.aerodromes)) {
		const aerodromes: FlightPrepAerodrome[] = [];
		for (const rawA of perf.aerodromes) {
			const a = asRecordOrNull(rawA);
			const icao = a ? optString(a.icao) : undefined;
			if (!a || !icao) {
				continue; // an aerodrome row without an ICAO is meaningless
			}
			aerodromes.push({
				icao,
				qnhHpa: optNumber(a.qnh),
				takeoff: parsePerfBlock(a.takeoff),
				landing: parsePerfBlock(a.landing),
			});
		}
		fp.aerodromes = aerodromes;
	}
	return fp;
}

function parseWaypoint(raw: unknown): LoadedWaypoint {
	const w = asRecord(raw, 'a waypoint');
	const wp: LoadedWaypoint = {
		name: optString(w.name),
		ident: optString(w.ident),
		lat: optNumber(w.lat),
		lon: optNumber(w.lon),
		notes: optString(w.notes),
		freqsManual: optString(w.frequencies_manual),
	};
	if (w.leg !== undefined) {
		const leg = asRecord(w.leg, 'a leg');
		wp.altitude = optNumber(leg.altitude);
		wp.auto = typeof leg.auto === 'boolean' ? leg.auto : undefined;
		wp.course = optNumber(leg.course);
		wp.distance = optNumber(leg.distance);
		// A wind override needs both halves; a lone value is ignored.
		const wd = optNumber(leg.wind_dir);
		const ws = optNumber(leg.wind_speed);
		if (wd !== undefined && ws !== undefined && ws >= 0) {
			wp.windDirDeg = ((Math.round(wd) % 360) + 360) % 360;
			wp.windSpeedKt = Math.round(ws);
		}
	}
	// A waypoint must be identifiable: an ident, explicit coords, or at least a
	// name (a name-only point is positioned later by dead reckoning).
	if (!wp.ident && (wp.lat === undefined || wp.lon === undefined) && !wp.name) {
		// i18n-ignore: route-file parse diagnostic, stays EN (file-format errors, docs/i18n.md rule 7; the aircraft-schema deferral)
		fail('a waypoint needs an ident, lat/lon, or a name');
	}
	return wp;
}

/** Parse + validate the YAML text into the loaded-only view. Throws a readable
 *  Error on a malformed document or an unknown version. Ignores the saved-only
 *  fields (frequencies, airspace, heading/distance_remaining/safety_altitude/ete);
 *  frequencies_manual is the read-back frequency override; leg.course/leg.distance
 *  are read only to dead-reckon name-only waypoints. */
export function parseRoutesDoc(text: string): ParsedRoutesDoc {
	let doc: unknown;
	try {
		doc = parse(text);
	} catch (e) {
		fail(e instanceof Error ? e.message : String(e));
	}
	// i18n-ignore: route-file parse diagnostic, stays EN (file-format errors, docs/i18n.md rule 7; the aircraft-schema deferral)
	const root = asRecord(doc, 'the document');
	if (root.version !== ROUTES_DOC_VERSION) {
		// i18n-ignore: route-file parse diagnostic, stays EN (file-format errors, docs/i18n.md rule 7; the aircraft-schema deferral)
		fail(`unsupported version ${JSON.stringify(root.version)} (expected ${ROUTES_DOC_VERSION})`);
	}
	if (!Array.isArray(root.routes)) {
		// i18n-ignore: route-file parse diagnostic, stays EN (file-format errors, docs/i18n.md rule 7; the aircraft-schema deferral)
		fail('"routes" must be a list');
	}
	const routes: LoadedRoute[] = root.routes.map((rawRoute) => {
		const r = asRecord(rawRoute, 'a route');
		if (!Array.isArray(r.waypoints)) {
			// i18n-ignore: route-file parse diagnostic, stays EN (file-format errors, docs/i18n.md rule 7; the aircraft-schema deferral)
			fail('a route\'s "waypoints" must be a list');
		}
		return {
			name: optString(r.name) ?? null,
			waypoints: r.waypoints.map(parseWaypoint),
			alternate: r.role === 'alternate' ? true : undefined,
		};
	});
	return {
		routes,
		planName: normalizePlanName(optString(root.name)) ?? undefined,
		settings: parseSettings(root.settings),
		flightPrep: parseFlightPrep(root.flight_prep),
	};
}

/** Tolerant settings-block parse: absent / non-mapping -> undefined; each
 *  malformed value -> undefined (only stated keys are applied on load). */
function parseSettings(raw: unknown): LoadedSettings | undefined {
	const s = asRecordOrNull(raw);
	if (!s) {
		return undefined;
	}
	const ta = optNumber(s.transition_altitude);
	return {
		vfr: optBoolean(s.vfr),
		semicircular: optBoolean(s.semi_circular),
		transitionAltitudeFt: ta !== undefined && ta >= 0 ? ta : undefined,
		windForecast: optBoolean(s.wind_forecast),
		temperatureTas: optBoolean(s.temperature_tas),
	};
}
