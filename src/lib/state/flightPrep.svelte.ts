/* Flight-preparation inputs for the four modal pages (dossier, fuel plan,
 * mass & balance, performance), persisted to localStorage and round-tripped
 * through the route YAML's flight_prep block. Read-accessors return defaults
 * WITHOUT writing (no effect-writes-subscribe loops); rows materialize only
 * inside the mutators. Mass & balance loads are keyed by station label
 * (missing label = the aircraft's default mass, resolved at the page); fuel
 * trips and dossier ground stops are index-aligned with the non-alternate
 * routes. The dossier's pilot block is user identity, not flight state: it
 * survives loading a file that doesn't carry it. */

import { DOSSIER_CHECKS, fmtDuration, parseDuration } from '$lib/aircraft/dossier';
import type { FlightPrepDoc, FlightPrepPerfBlock, FlightPrepTrip } from '$lib/route/yaml';
import { aircraftState, aircraftByKey, selectAircraft } from './aircraft.svelte';
import { readJson, writeJson } from './persist';

const STORAGE_KEY = 'loxodrome:flight-prep';
/** The pilot block's own key: user identity, not flight state, so it
 *  persists apart from the per-workspace prep inputs. Its own key is what
 *  lets the reset dialog's aircraft group name it and the sync layer
 *  carry it as the `pilot` doc (docs/accounts-sync.md); the reactive
 *  location stays `flightPrep.dossier.pilot`, so no consumer moves. */
const PILOT_KEY = 'loxodrome:pilot';

/* Every field is explicit minutes, or null = automatic, in which case the
 * value in force comes from aircraft/fuel.ts, which owns the defaults and
 * applies each one when its option is absent: taxi 10 (5 per ground movement),
 * procedure 10 (and 10 for the alternate's), margin 0, and the final reserve's
 * day/night default (30/45 min, AMC1 NCO.OP.125(b)) derived from the overview
 * timeline vs the sunrise/sunset window (see shared.ts fuelComputation). Null
 * rather than a seeded copy of the constant, so the page can show the value in
 * force as a placeholder and the pilot's own minutes as a typed value. */
export interface TripFuelInputs {
	taxiMin: number | null;
	procedureMin: number | null;
	altProcedureMin: number | null;
	marginMin: number | null;
	finalReserveMin: number | null;
}

export interface PerfBlockInputs {
	/** null = use ISA at the pressure altitude (or the nearest fresh METAR's
	 *  temperature when live weather provides one). */
	tempC: number | null;
	/** Wind components along the selected runway end, kt. null = unset: the
	 *  nearest fresh METAR's projection applies when available, else 0.
	 *  Typing EITHER component makes the pair explicit (METAR wind ignored
	 *  for the phase); a typed 0 is an explicit calm that persists like any
	 *  other override, distinct from unset (saved as an absent key, which
	 *  follows the METAR on reload). NB pre-METAR files wrote a padding 0 for
	 *  every block, so those load back as explicit calm now. */
	headwindKt: number | null;
	tailwindKt: number | null;
	wet: boolean;
	/** A runway end (QFU) like '26'; null = the airport's first end. */
	runwayEnd: string | null;
}

export interface PerfAerodromeInputs {
	/** null = standard (pressure altitude = elevation). */
	qnhHpa: number | null;
	takeoff: PerfBlockInputs;
	landing: PerfBlockInputs;
}

export type MbFuelMode = 'full' | 'minimum' | 'tabs' | 'custom';

interface FlightPrepState {
	fuel: {
		trips: TripFuelInputs[];
	};
	mb: {
		/** Station label -> mass kg; missing = the aircraft's default. */
		loads: Record<string, number>;
		fuelMode: MbFuelMode;
		/** Only used with fuelMode 'custom'. */
		customLitres: number | null;
	};
	perf: {
		byIcao: Record<string, PerfAerodromeInputs>;
		/** Aerodromes added by hand, beyond the route-derived ones. */
		manualIcaos: string[];
	};
	dossier: DossierInputs;
}

export interface DossierInputs {
	/** Flight date 'YYYY-MM-DD'; null follows the viewing period's start / today
	 *  (see dossierFlightDate). */
	flightDate: string | null;
	/** First departure 'HH:MM' UTC; null = unset (the timeline stays blank). */
	departureTime: string | null;
	/** Ground stop after trip i, minutes; null or missing = automatic, which is
	 *  no ground time. A stated 00:00 is kept as its own value. */
	stopsMin: (number | null)[];
	/** Pilot identity: kept across file loads (see applyLoadedFlightPrep). */
	pilot: { name: string; sepValidUntil: string | null; medicalValidUntil: string | null };
	/** Airframe potential: remaining minutes before the next engine check
	 *  (entered and shown as an h:mm duration); null = unset. */
	potentialMin: number | null;
	/** Météo default QNH (hPa), the performance page's fallback; null = unset
	 *  (standard: pressure altitude = elevation). */
	qnhHpa: number | null;
	/** Checked checklist items by DOSSIER_CHECKS id; missing = unchecked. */
	checks: Record<string, boolean>;
}

/** True when a trip's minutes state nothing at all, i.e. it runs entirely on the
 *  automatic values. Takes the values rather than either shape, since the state
 *  and the saved document name the alternate's procedure differently. */
function statesNoMinute(...minutes: (number | null | undefined)[]): boolean {
	return minutes.every((m) => m == null);
}

export function defaultTripFuel(): TripFuelInputs {
	return {
		taxiMin: null,
		procedureMin: null,
		altProcedureMin: null,
		marginMin: null,
		finalReserveMin: null,
	};
}

export function defaultPerfBlock(): PerfBlockInputs {
	return { tempC: null, headwindKt: null, tailwindKt: null, wet: false, runwayEnd: null };
}

export function defaultPerfAerodrome(): PerfAerodromeInputs {
	return { qnhHpa: null, takeoff: defaultPerfBlock(), landing: defaultPerfBlock() };
}

function defaultDossier(): DossierInputs {
	return {
		flightDate: null,
		departureTime: null,
		stopsMin: [],
		pilot: { name: '', sepValidUntil: null, medicalValidUntil: null },
		potentialMin: null,
		qnhHpa: null,
		checks: {},
	};
}

function defaults(): FlightPrepState {
	return {
		fuel: { trips: [] },
		mb: { loads: {}, fuelMode: 'full', customLitres: null },
		perf: { byIcao: {}, manualIcaos: [] },
		dossier: defaultDossier(),
	};
}

/** A stored perf block re-read: a present wind value (including 0, an explicit
 *  calm) is kept; only an absent field reads back as unset. Pre-METAR stores
 *  wrote a padding 0 for every block, which now reads as explicit calm (the
 *  Reset button clears it). */
function storedBlock(b: Partial<PerfBlockInputs> | undefined): PerfBlockInputs {
	return {
		...defaultPerfBlock(),
		...b,
		// A stored 0 is an explicit calm (kept); an absent field is unset.
		headwindKt: b?.headwindKt ?? null,
		tailwindKt: b?.tailwindKt ?? null,
	};
}

function initial(): FlightPrepState {
	const state = initialBase();
	state.dossier.pilot = initialPilot(state.dossier.pilot);
	return state;
}

/** The pilot block from its own key; a device that predates the split
 *  falls back to whatever the legacy blob carried (the caller's value). */
function initialPilot(legacy: DossierInputs['pilot']): DossierInputs['pilot'] {
	const stored = readJson<Partial<DossierInputs['pilot']>>(PILOT_KEY);
	if (!stored || typeof stored !== 'object') {
		return legacy;
	}
	return {
		name: typeof stored.name === 'string' ? stored.name : '',
		sepValidUntil: typeof stored.sepValidUntil === 'string' ? stored.sepValidUntil : null,
		medicalValidUntil:
			typeof stored.medicalValidUntil === 'string' ? stored.medicalValidUntil : null,
	};
}

function initialBase(): FlightPrepState {
	const stored = readJson<{ v?: number } & Partial<FlightPrepState>>(STORAGE_KEY);
	if (!stored || stored.v !== 1) {
		return defaults();
	}
	// The merge stays fortressed on its own: a hand-corrupted store (wrong
	// nested types) falls back to defaults instead of crashing module init.
	try {
		const base = defaults();
		if (stored.fuel && typeof stored.fuel === 'object') {
			if (Array.isArray(stored.fuel.trips)) {
				base.fuel.trips = stored.fuel.trips.map((t) => ({
					...defaultTripFuel(),
					...t,
				}));
			}
		}
		if (stored.mb && typeof stored.mb === 'object') {
			// Explicit picks: older stores may carry retired keys (burnMode).
			base.mb = {
				loads: stored.mb.loads ?? {},
				fuelMode: stored.mb.fuelMode ?? 'full',
				customLitres: stored.mb.customLitres ?? null,
			};
		}
		if (stored.perf && typeof stored.perf === 'object') {
			const byIcao: Record<string, PerfAerodromeInputs> = {};
			for (const [icao, a] of Object.entries(stored.perf.byIcao ?? {})) {
				byIcao[icao] = {
					qnhHpa: a.qnhHpa ?? null,
					takeoff: storedBlock(a.takeoff),
					landing: storedBlock(a.landing),
				};
			}
			base.perf = { byIcao, manualIcaos: stored.perf.manualIcaos ?? [] };
		}
		if (stored.dossier && typeof stored.dossier === 'object') {
			const d = stored.dossier;
			base.dossier = {
				flightDate: d.flightDate ?? null,
				departureTime: d.departureTime ?? null,
				stopsMin: Array.isArray(d.stopsMin)
					? d.stopsMin.map((n) =>
							typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null,
						)
					: [],
				pilot: { ...defaultDossier().pilot, ...d.pilot },
				potentialMin: d.potentialMin ?? null,
				qnhHpa: d.qnhHpa ?? null,
				checks: d.checks ?? {},
			};
		}
		return base;
	} catch {
		return defaults();
	}
}

export const flightPrep = $state<FlightPrepState>(initial());

/* One-shot migration (the display.svelte idiom): the pilot block used to
 * live inside the flight-prep blob; lift a legacy copy into its own key
 * once, so a device that never edits the pilot again still carries it
 * under PILOT_KEY. The old blob sheds the block at its next persist(). */
{
	const p = flightPrep.dossier.pilot;
	if (
		readJson(PILOT_KEY) === null &&
		(p.name !== '' || p.sepValidUntil !== null || p.medicalValidUntil !== null)
	) {
		writeJson(PILOT_KEY, $state.snapshot(p));
	}
}

function persist(): void {
	// The pilot block persists under its own key; the blob written here
	// sheds it so the two stores can never disagree.
	const snap = $state.snapshot(flightPrep);
	writeJson(STORAGE_KEY, { v: 1, ...snap, dossier: { ...snap.dossier, pilot: undefined } });
}

function persistPilot(): void {
	writeJson(PILOT_KEY, $state.snapshot(flightPrep.dossier.pilot));
}

/** The pilot block snapshot (the sync payload's source). */
export function pilotSnapshot(): DossierInputs['pilot'] {
	return $state.snapshot(flightPrep.dossier.pilot);
}

/** Apply the remote pilot doc (lww whole; docs/accounts-sync.md). */
export function applyRemotePilot(p: DossierInputs['pilot']): void {
	flightPrep.dossier.pilot = { ...p };
	persistPilot();
}

/** Trip i's fuel inputs: the stored row or the defaults (no write on read). */
export function tripFuel(i: number): TripFuelInputs {
	return flightPrep.fuel.trips[i] ?? defaultTripFuel();
}

export function setTripFuel(i: number, patch: Partial<TripFuelInputs>): void {
	while (flightPrep.fuel.trips.length <= i) {
		flightPrep.fuel.trips.push(defaultTripFuel());
	}
	Object.assign(flightPrep.fuel.trips[i], patch);
	persist();
}

export function setMbLoad(label: string, massKg: number | null): void {
	if (massKg == null) {
		delete flightPrep.mb.loads[label];
	} else {
		flightPrep.mb.loads[label] = massKg;
	}
	persist();
}

export function setMb(patch: Partial<Pick<FlightPrepState['mb'], 'fuelMode' | 'customLitres'>>): void {
	Object.assign(flightPrep.mb, patch);
	persist();
}

/** The aerodrome's inputs: stored or defaults (no write on read). */
export function perfFor(icao: string): PerfAerodromeInputs {
	return flightPrep.perf.byIcao[icao] ?? defaultPerfAerodrome();
}

/** The aerodrome's stored inputs, created on first edit. Reads the record BACK
 *  out of state rather than returning the local: the store keeps a $state proxy
 *  of what was assigned, so mutations through the local would go to a detached
 *  object (same reason setTripFuel patches flightPrep.fuel.trips[i]). */
function materializePerf(icao: string): PerfAerodromeInputs {
	flightPrep.perf.byIcao[icao] ??= defaultPerfAerodrome();
	return flightPrep.perf.byIcao[icao];
}

export function setPerfQnh(icao: string, qnhHpa: number | null): void {
	materializePerf(icao).qnhHpa = qnhHpa;
	persist();
}

export function setPerfBlock(
	icao: string,
	phase: 'takeoff' | 'landing',
	patch: Partial<PerfBlockInputs>,
): void {
	Object.assign(materializePerf(icao)[phase], patch);
	persist();
}

/** Clear every typed QNH / temperature / wind override across all aerodromes
 *  (the performance page's "Reset to live weather" button), so each field
 *  follows its automatic METAR default again. The runway choice and the wet
 *  flag are not weather-derived, so they are left untouched. */
export function resetPerfWeather(): void {
	for (const a of Object.values(flightPrep.perf.byIcao)) {
		a.qnhHpa = null;
		for (const phase of ['takeoff', 'landing'] as const) {
			a[phase].tempC = null;
			a[phase].headwindKt = null;
			a[phase].tailwindKt = null;
		}
	}
	persist();
}

export function addManualAerodrome(icao: string): void {
	const up = icao.toUpperCase();
	if (!flightPrep.perf.manualIcaos.includes(up)) {
		flightPrep.perf.manualIcaos.push(up);
		persist();
	}
}

export function removeManualAerodrome(icao: string): void {
	const i = flightPrep.perf.manualIcaos.indexOf(icao);
	if (i >= 0) {
		flightPrep.perf.manualIcaos.splice(i, 1);
		persist();
	}
}

function todayUtcIso(): string {
	// One-shot timestamp formatted to a calendar date; not reactive.
	const now = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}`;
}

/** The dossier's flight date 'YYYY-MM-DD': the stored value, else today
 *  (UTC). No write on read; "today" is read at access time (not
 *  midnight-reactive). The dossier is the authority on when the flight is:
 *  the evaluation window's 'flight' mode derives itself from this date
 *  through firstDepartureMs, so nothing upstream of it may read the window
 *  back. */
export function dossierFlightDate(): string {
	return flightPrep.dossier.flightDate || todayUtcIso();
}

/** Ground stop after trip i: stated minutes, or null = automatic (no ground
 *  time). No write on read; every consumer of the DURATION reads it through
 *  dossierStopEffectiveMin. */
export function dossierStopMin(i: number): number | null {
	return flightPrep.dossier.stopsMin[i] ?? null;
}

/** The ground time in force after trip i: an automatic stop is no stop. */
export function dossierStopEffectiveMin(i: number): number {
	return dossierStopMin(i) ?? 0;
}

/** A dossier checklist item's state (no write on read). */
export function dossierCheck(id: string): boolean {
	return flightPrep.dossier.checks[id] === true;
}

export function setDossier(
	patch: Partial<Pick<DossierInputs, 'flightDate' | 'departureTime' | 'potentialMin' | 'qnhHpa'>>,
): void {
	Object.assign(flightPrep.dossier, patch);
	persist();
}

export function setDossierPilot(patch: Partial<DossierInputs['pilot']>): void {
	Object.assign(flightPrep.dossier.pilot, patch);
	persistPilot();
}

/** null hands the stop back to automatic. */
export function setDossierStop(i: number, min: number | null): void {
	while (flightPrep.dossier.stopsMin.length <= i) {
		flightPrep.dossier.stopsMin.push(null);
	}
	flightPrep.dossier.stopsMin[i] = min;
	persist();
}

export function setDossierCheck(id: string, on: boolean): void {
	if (on) {
		flightPrep.dossier.checks[id] = true;
	} else {
		// Unchecking deletes the key, so a fully unticked dossier reads as
		// untouched again (byte-identical saves).
		delete flightPrep.dossier.checks[id];
	}
	persist();
}

function isDefaultBlock(b: PerfBlockInputs): boolean {
	// Only an unset (null) field is default; a typed 0 (explicit calm) makes
	// the block non-default so it persists like any other override.
	return (
		b.tempC == null &&
		b.headwindKt == null &&
		b.tailwindKt == null &&
		!b.wet &&
		b.runwayEnd == null
	);
}

function toDocBlock(b: PerfBlockInputs): FlightPrepPerfBlock {
	return {
		temperatureC: b.tempC ?? undefined,
		// Keep an explicit 0 (calm); only unset (null) drops to an absent key.
		headwindKt: b.headwindKt ?? undefined,
		tailwindKt: b.tailwindKt ?? undefined,
		wet: b.wet,
		runwayEnd: b.runwayEnd ?? undefined,
	};
}

/** The flight_prep block for the route YAML, or undefined when the feature
 *  is untouched (no aircraft, no stored inputs) so old-style files stay
 *  byte-identical. `tripCount` = the non-alternate route count; `perfIcaos`
 *  = the performance page's aerodrome list (derived + manual). Only
 *  aerodromes with non-default inputs or manually added ones are written
 *  (the derived list reproduces from the routes on load). */
export function buildFlightPrepForSave(
	tripCount: number,
	perfIcaos: readonly string[],
): FlightPrepDoc | undefined {
	const aircraft = aircraftState.selectedKey;
	const d = flightPrep.dossier;
	const dossierTouched =
		d.flightDate != null ||
		d.departureTime != null ||
		d.stopsMin.some((n) => n != null) ||
		d.pilot.name !== '' ||
		d.pilot.sepValidUntil != null ||
		d.pilot.medicalValidUntil != null ||
		d.potentialMin != null ||
		d.qnhHpa != null ||
		Object.values(d.checks).some(Boolean);
	const touched =
		aircraft != null ||
		dossierTouched ||
		flightPrep.fuel.trips.some(
			(t) =>
				!statesNoMinute(t.taxiMin, t.procedureMin, t.altProcedureMin, t.marginMin, t.finalReserveMin),
		) ||
		Object.keys(flightPrep.mb.loads).length > 0 ||
		flightPrep.mb.fuelMode !== 'full' ||
		Object.keys(flightPrep.perf.byIcao).length > 0 ||
		flightPrep.perf.manualIcaos.length > 0;
	if (!touched) {
		return undefined;
	}
	const doc: FlightPrepDoc = { aircraft: aircraft ?? undefined };
	if (dossierTouched) {
		// Stops are saved for the between-trip slots only; checks in registry
		// order (unknown stored ids, e.g. from a newer file, append sorted).
		const stops = Array.from({ length: Math.max(0, tripCount - 1) }, (_, i) =>
			dossierStopMin(i),
		);
		// A stop nobody set is written as null, not as a stated 00:00, and a
		// tail of them is not written at all.
		while (stops.length > 0 && stops[stops.length - 1] == null) {
			stops.pop();
		}
		const known = DOSSIER_CHECKS.filter((c) => d.checks[c.id] === true).map((c) => c.id);
		const unknown = Object.keys(d.checks)
			.filter((id) => d.checks[id] === true && !DOSSIER_CHECKS.some((c) => c.id === id))
			.sort();
		const checks = [...known, ...unknown];
		doc.dossier = {
			flightDate: d.flightDate ?? undefined,
			departureTime: d.departureTime ?? undefined,
			stopsMin: stops.some((n) => n != null) ? stops : undefined,
			pilotName: d.pilot.name || undefined,
			sepValidUntil: d.pilot.sepValidUntil ?? undefined,
			medicalValidUntil: d.pilot.medicalValidUntil ?? undefined,
			// The YAML keeps the sheet's display form (an 'H:MM' string).
			potential: d.potentialMin != null ? fmtDuration(d.potentialMin) : undefined,
			qnhHpa: d.qnhHpa ?? undefined,
			checks: checks.length > 0 ? checks : undefined,
		};
	}
	if (tripCount > 0 && flightPrep.fuel.trips.length > 0) {
		const trips: FlightPrepTrip[] = [];
		for (let i = 0; i < tripCount; i++) {
			const t = tripFuel(i);
			// Auto (null) saves as an absent key; explicit minutes only.
			trips.push({
				taxiMin: t.taxiMin ?? undefined,
				procedureMin: t.procedureMin ?? undefined,
				alternateProcedureMin: t.altProcedureMin ?? undefined,
				marginMin: t.marginMin ?? undefined,
				finalReserveMin: t.finalReserveMin ?? undefined,
			});
		}
		// An all-automatic trip is an empty entry: the trailing ones go, and a
		// row of them writes no block at all. The rest stay in place, the array
		// being index-aligned with the trip routes.
		while (
			trips.length > 0 &&
			statesNoMinute(
				trips[trips.length - 1].taxiMin,
				trips[trips.length - 1].procedureMin,
				trips[trips.length - 1].alternateProcedureMin,
				trips[trips.length - 1].marginMin,
				trips[trips.length - 1].finalReserveMin,
			)
		) {
			trips.pop();
		}
		if (trips.length > 0) {
			doc.fuelTrips = trips;
		}
	}
	const mb = flightPrep.mb;
	if (Object.keys(mb.loads).length > 0 || mb.fuelMode !== 'full' || mb.customLitres != null) {
		doc.massBalance = {
			loads: Object.keys(mb.loads).length > 0 ? { ...mb.loads } : undefined,
			fuelMode: mb.fuelMode,
			fuelLitres: mb.customLitres ?? undefined,
		};
	}
	const aerodromes = perfIcaos
		.filter(
			(icao) =>
				flightPrep.perf.manualIcaos.includes(icao) ||
				(flightPrep.perf.byIcao[icao] &&
					(flightPrep.perf.byIcao[icao].qnhHpa != null ||
						!isDefaultBlock(flightPrep.perf.byIcao[icao].takeoff) ||
						!isDefaultBlock(flightPrep.perf.byIcao[icao].landing))),
		)
		.map((icao) => {
			const a = perfFor(icao);
			return {
				icao,
				qnhHpa: a.qnhHpa ?? undefined,
				takeoff: toDocBlock(a.takeoff),
				landing: toDocBlock(a.landing),
			};
		});
	if (aerodromes.length > 0) {
		doc.aerodromes = aerodromes;
	}
	return doc;
}

const FUEL_MODES: readonly MbFuelMode[] = ['full', 'minimum', 'tabs', 'custom'];

function loadedBlock(b: FlightPrepPerfBlock | undefined): PerfBlockInputs {
	return {
		tempC: b?.temperatureC ?? null,
		// Absent key = unset (follows the METAR); a present 0 is an explicit
		// calm that overrides it.
		headwindKt: b?.headwindKt ?? null,
		tailwindKt: b?.tailwindKt ?? null,
		wet: b?.wet ?? false,
		runwayEnd: b?.runwayEnd ?? null,
	};
}

/** Open-file semantics: replace the flight prep with the loaded block
 *  (missing pieces reset to defaults). EXCEPTION: the dossier's pilot block
 *  is user identity, so the current values carry over and a loaded file only
 *  overrides the pilot fields it explicitly carries. The aircraft key, when
 *  present, selects even an unknown plane (returned so the caller can
 *  surface it); when absent the current selection is kept. `derivedIcaos` =
 *  the aerodromes the loaded routes imply; loaded rows beyond them become
 *  manual adds. */
export function applyLoadedFlightPrep(
	fp: FlightPrepDoc | undefined,
	derivedIcaos: readonly string[],
): { unknownAircraft: string | null } {
	const pilot = $state.snapshot(flightPrep.dossier.pilot);
	const next = defaults();
	next.dossier.pilot = pilot;
	let unknownAircraft: string | null = null;
	if (fp) {
		if (fp.aircraft) {
			selectAircraft(fp.aircraft);
			if (!aircraftByKey(fp.aircraft)) {
				unknownAircraft = fp.aircraft;
			}
		}
		for (const t of fp.fuelTrips ?? []) {
			// Absent in the file = automatic, the value aircraft/fuel.ts applies;
			// a stated minute is the pilot's own, whatever it equals.
			next.fuel.trips.push({
				taxiMin: t.taxiMin ?? null,
				procedureMin: t.procedureMin ?? null,
				altProcedureMin: t.alternateProcedureMin ?? null,
				marginMin: t.marginMin ?? null,
				finalReserveMin: t.finalReserveMin ?? null,
			});
		}
		if (fp.massBalance) {
			next.mb.loads = { ...(fp.massBalance.loads ?? {}) };
			const mode = fp.massBalance.fuelMode as MbFuelMode | undefined;
			next.mb.fuelMode = mode && FUEL_MODES.includes(mode) ? mode : 'full';
			next.mb.customLitres = fp.massBalance.fuelLitres ?? null;
		}
		for (const a of fp.aerodromes ?? []) {
			next.perf.byIcao[a.icao] = {
				qnhHpa: a.qnhHpa ?? null,
				takeoff: loadedBlock(a.takeoff),
				landing: loadedBlock(a.landing),
			};
			if (!derivedIcaos.includes(a.icao) && !next.perf.manualIcaos.includes(a.icao)) {
				next.perf.manualIcaos.push(a.icao);
			}
		}
		const d = fp.dossier;
		if (d) {
			if (d.flightDate) {
				next.dossier.flightDate = d.flightDate;
			}
			if (d.departureTime) {
				next.dossier.departureTime = d.departureTime;
			}
			if (d.stopsMin) {
				next.dossier.stopsMin = d.stopsMin.map((n) =>
					typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null,
				);
			}
			if (d.pilotName != null) {
				next.dossier.pilot.name = d.pilotName;
			}
			if (d.sepValidUntil != null) {
				next.dossier.pilot.sepValidUntil = d.sepValidUntil;
			}
			if (d.medicalValidUntil != null) {
				next.dossier.pilot.medicalValidUntil = d.medicalValidUntil;
			}
			if (d.potential) {
				next.dossier.potentialMin = parseDuration(d.potential);
			}
			if (d.qnhHpa != null) {
				next.dossier.qnhHpa = d.qnhHpa;
			}
			for (const id of d.checks ?? []) {
				next.dossier.checks[id] = true;
			}
		}
	}
	flightPrep.fuel = next.fuel;
	flightPrep.mb = next.mb;
	flightPrep.perf = next.perf;
	flightPrep.dossier = next.dossier;
	persist();
	// A loaded file's explicit pilot fields land in the pilot store too:
	// what is local is what syncs (docs/accounts-sync.md, the accepted
	// pilot-staleness residual).
	persistPilot();
	return { unknownAircraft };
}
