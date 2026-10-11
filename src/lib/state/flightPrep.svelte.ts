/* Flight-preparation inputs for the four modal pages (dossier, fuel plan,
 * mass & balance, performance), persisted to localStorage and round-tripped
 * through the route YAML's flight_prep block. Read-accessors return defaults
 * WITHOUT writing (no effect-writes-subscribe loops); rows materialize only
 * inside the mutators. Mass & balance loads are keyed by station key, the
 * label with an occurrence suffix on a label the sheet repeats (missing key =
 * the aircraft's default mass, resolved at the page); fuel
 * trips and dossier ground stops are index-aligned with the non-alternate
 * routes, while the refuel and payload choices made at each STOP are keyed by
 * the stop's aerodrome (aircraft/trips.ts tripStopKeys), so a trip inserted
 * elsewhere cannot carry a refuel to another field. The dossier's pilot block
 * is user identity, not flight state: it survives loading a file that doesn't
 * carry it. */

import { DOSSIER_CHECKS, fmtDuration, parseDuration } from '$lib/aircraft/dossier';
import type { LastRefuel, LogFlight, OnBoardInputs } from '$lib/aircraft/onBoard';
import type { FlightPrepDoc, FlightPrepOnBoard, FlightPrepPerfBlock, FlightPrepTrip } from '$lib/route/yaml';
import { sharedDeviceFlag } from '$lib/sync/keys';
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
 * procedure 10 (and 10 for the alternate's), contingency 0, margin 0, and the
 * final reserve's
 * day/night default (30/45 min, AMC1 NCO.OP.125(b)) derived from the overview
 * timeline vs the sunrise/sunset window (see shared.ts fuelComputation). Null
 * rather than a seeded copy of the constant, so the page can show the value in
 * force as a placeholder and the pilot's own minutes as a typed value. */
export interface TripFuelInputs {
	taxiMin: number | null;
	procedureMin: number | null;
	/** Performance, avoidance, weather, ATC, holding: burnt with the trip. */
	contingencyMin: number | null;
	altProcedureMin: number | null;
	marginMin: number | null;
	finalReserveMin: number | null;
}

export interface PerfBlockInputs {
	/** null = the phase's own source, the METAR or the forecast at its
	 *  instant, else the dossier's Météo QNH, else standard (pressure
	 *  altitude = elevation; flightprep/runwayPerf.ts autoQnh). Per PHASE:
	 *  a take-off and a landing at one field read their instants, hours
	 *  apart on a round trip, so typing the QNH one shows must leave the
	 *  other's alone. */
	qnhHpa: number | null;
	/** null = use ISA at the pressure altitude (or the nearest fresh METAR's
	 *  temperature when live weather provides one), to the whole degree the
	 *  field shows (flightprep/runwayPerf.ts autoTempC). */
	tempC: number | null;
	/** Wind components along the selected runway end, kt. null = unset: the
	 *  nearest fresh METAR's projection applies when available, else 0, and
	 *  0 where the OTHER component is typed non-zero (along one runway the
	 *  wind is a headwind or a tailwind, never both; flightprep/runwayPerf.ts
	 *  autoWind). A typed 0 states its own component and contradicts nothing,
	 *  so an explicit calm is a 0 in both; it persists like any other
	 *  override, distinct from unset (saved as an absent key, which follows
	 *  the METAR on reload). NB pre-METAR files wrote a padding 0 for every
	 *  block, so those load back as explicit calm now. */
	headwindKt: number | null;
	tailwindKt: number | null;
	wet: boolean;
	/** The runway end picked, by its key at the aerodrome (RunwayEnd.key: the
	 *  designator, '26', with '#2' on a designator the aerodrome repeats);
	 *  null = the automatic into-wind choice. */
	runwayEnd: string | null;
}

export interface PerfAerodromeInputs {
	takeoff: PerfBlockInputs;
	landing: PerfBlockInputs;
}

/** The fuel set at a takeoff: the departure's, or a refuelling stop's.
 *  'max' is the most fuel keeping the trips until the next refuel within the
 *  mass and CG limits. */
export type MbFuelMode = 'full' | 'minimum' | 'tabs' | 'max' | 'custom';

/** Declared before the store reads it at module init. */
const FUEL_MODES: readonly MbFuelMode[] = ['full', 'minimum', 'tabs', 'max', 'custom'];

/** What the pilot states at a stop between two trips. */
export interface StopInputs {
	/** Refuelled before the next takeoff; unticked, the fuel carries over. Kept
	 *  apart from `mode` so an untick then a retick keeps a typed figure. */
	refuel: boolean;
	/** The fuel to refuel to (a new tick starts at Full tanks). */
	mode: MbFuelMode;
	/** Only used with mode 'custom'; null = the empty box, the minimum. */
	litres: number | null;
	/** Payload changes made at the stop, station key -> mass kg; a missing
	 *  station carries the mass of the trip before. */
	loads: Record<string, number>;
}

interface FlightPrepState {
	fuel: {
		trips: TripFuelInputs[];
	};
	mb: {
		/** Station load key (massBalance.ts stationKeys: the label, '#2' on a
		 *  label the sheet repeats) -> mass kg; missing = the station's default. */
		loads: Record<string, number>;
		fuelMode: MbFuelMode;
		/** Only used with fuelMode 'custom'. */
		customLitres: number | null;
		/** The departure is refuelled to `fuelMode`; false: it takes off with
		 *  what is on board (`onBoard`). Kept apart from `fuelMode`, as a
		 *  stop's tick is, so a no refuel then a target keeps a typed figure. */
		refuel: boolean;
		/** What the departure's tanks hold before any refuel, as the pilot read
		 *  them (the journey log since the last refuel, a measured quantity;
		 *  aircraft/onBoard.ts); null = not stated. Part of the plan, dropped
		 *  when a stored plan is activated again (a new flight). */
		onBoard: OnBoardInputs | null;
		/** The stops' inputs by stop key (the aerodrome ident, '#2' on a
		 *  second visit, else the point's position). An entry whose stop left
		 *  the plan stays (not shown, not saved, back with an undo). */
		stopovers: Record<string, StopInputs>;
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
	/** Pilot identity: kept across file loads (see applyLoadedFlightPrep).
	 *  `mepValidUntil` is the MEP class rating's (FCL.740), the row a twin's
	 *  Overview shows instead of the SEP one; stored, synced and downloaded
	 *  only when set (`pilotRecord`). */
	pilot: { name: string; sepValidUntil: string | null; medicalValidUntil: string | null; mepValidUntil: string | null };
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
		contingencyMin: null,
		altProcedureMin: null,
		marginMin: null,
		finalReserveMin: null,
	};
}

export function defaultStopInputs(): StopInputs {
	return { refuel: false, mode: 'full', litres: null, loads: {} };
}

/** A stop's entry states nothing: unticked, no payload change, and nothing
 *  remembered for a retick. */
function stopStatesNothing(st: StopInputs): boolean {
	return !st.refuel && st.mode === 'full' && st.litres == null && Object.keys(st.loads).length === 0;
}

/** Station masses read back from a store or a file: finite and non-negative
 *  only. */
function validLoads(raw: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
				out[key] = v;
			}
		}
	}
	return out;
}

function validLitres(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** The stopovers as stored, entry by entry: a malformed one is dropped, an
 *  unknown mode reads as Full tanks. */
function storedStopovers(raw: unknown): Record<string, StopInputs> {
	const out: Record<string, StopInputs> = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return out;
	}
	for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!v || typeof v !== 'object' || Array.isArray(v)) {
			continue;
		}
		const e = v as Partial<Record<keyof StopInputs, unknown>>;
		const st: StopInputs = {
			refuel: e.refuel === true,
			mode: FUEL_MODES.includes(e.mode as MbFuelMode) ? (e.mode as MbFuelMode) : 'full',
			litres: validLitres(e.litres),
			loads: validLoads(e.loads),
		};
		if (!stopStatesNothing(st)) {
			out[key] = st;
		}
	}
	return out;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function validLast(v: unknown): LastRefuel | null {
	if (!v || typeof v !== 'object' || Array.isArray(v)) {
		return null;
	}
	const e = v as { kind?: unknown; litres?: unknown };
	if (e.kind === 'full' || e.kind === 'tabs') {
		return { kind: e.kind };
	}
	return e.kind === 'litres' ? { kind: 'litres', litres: validLitres(e.litres) } : null;
}

function validMinutes(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

function validRate(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** The departure's on-board reading as stored, field by field; without its
 *  aircraft and its day it is no reading at all. */
function storedOnBoard(raw: unknown): OnBoardInputs | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}
	const o = raw as Partial<Record<keyof OnBoardInputs, unknown>>;
	if (typeof o.aircraft !== 'string' || o.aircraft === '' || typeof o.readOn !== 'string' || !ISO_DAY.test(o.readOn)) {
		return null;
	}
	const flights: LogFlight[] = Array.isArray(o.flights)
		? o.flights.flatMap((f: unknown): LogFlight[] => {
				if (!f || typeof f !== 'object') {
					return [];
				}
				const e = f as Partial<Record<keyof LogFlight, unknown>>;
				return [{ min: validMinutes(e.min), addedL: validLitres(e.addedL) }];
			})
		: [];
	return {
		aircraft: o.aircraft,
		readOn: o.readOn,
		last: validLast(o.last),
		flights,
		lph: validRate(o.lph),
		measuredL: validLitres(o.measuredL),
	};
}

/** A journey-log line stating something: a flight time or litres added. */
function lineStates(f: LogFlight): boolean {
	return (f.min ?? 0) > 0 || (f.addedL ?? 0) > 0;
}

/** The reading states something worth keeping in the plan file. */
function onBoardStates(ob: OnBoardInputs | null): ob is OnBoardInputs {
	return ob != null && (ob.last != null || ob.measuredL != null || ob.lph != null || ob.flights.some(lineStates));
}

function onBoardToDoc(ob: OnBoardInputs): FlightPrepOnBoard {
	return {
		aircraft: ob.aircraft,
		readOn: ob.readOn,
		lastRefuel: ob.last == null ? undefined : ob.last.kind === 'litres' ? (ob.last.litres ?? undefined) : ob.last.kind,
		flights: ob.flights.some(lineStates)
			? ob.flights.filter(lineStates).map((f) => ({
					time: f.min != null && f.min > 0 ? fmtDuration(f.min) : undefined,
					added: f.addedL != null && f.addedL > 0 ? f.addedL : undefined,
				}))
			: undefined,
		consumptionLph: ob.lph ?? undefined,
		measuredL: ob.measuredL ?? undefined,
	};
}

/** A file's reading, kept only with its aircraft and its day. */
function onBoardFromDoc(doc: FlightPrepOnBoard | undefined): OnBoardInputs | null {
	if (!doc || !doc.aircraft || !doc.readOn || !ISO_DAY.test(doc.readOn)) {
		return null;
	}
	const last: LastRefuel | null =
		doc.lastRefuel === 'full' || doc.lastRefuel === 'tabs'
			? { kind: doc.lastRefuel }
			: typeof doc.lastRefuel === 'number'
				? validLitres(doc.lastRefuel) === null
					? null
					: { kind: 'litres', litres: doc.lastRefuel }
				: null;
	const ob: OnBoardInputs = {
		aircraft: doc.aircraft,
		readOn: doc.readOn,
		last,
		flights: (doc.flights ?? []).map((l) => ({
			min: l.time ? parseDuration(l.time) : null,
			addedL: validLitres(l.added),
		})),
		lph: validRate(doc.consumptionLph),
		measuredL: validLitres(doc.measuredL),
	};
	return onBoardStates(ob) ? ob : null;
}

export function defaultPerfBlock(): PerfBlockInputs {
	return { qnhHpa: null, tempC: null, headwindKt: null, tailwindKt: null, wet: false, runwayEnd: null };
}

export function defaultPerfAerodrome(): PerfAerodromeInputs {
	return { takeoff: defaultPerfBlock(), landing: defaultPerfBlock() };
}

function defaultDossier(): DossierInputs {
	return {
		flightDate: null,
		departureTime: null,
		stopsMin: [],
		pilot: { name: '', sepValidUntil: null, medicalValidUntil: null, mepValidUntil: null },
		potentialMin: null,
		qnhHpa: null,
		checks: {},
	};
}

function defaults(): FlightPrepState {
	return {
		fuel: { trips: [] },
		mb: { loads: {}, fuelMode: 'full', customLitres: null, refuel: true, onBoard: null, stopovers: {} },
		perf: { byIcao: {}, manualIcaos: [] },
		dossier: defaultDossier(),
	};
}

/** A stored perf block re-read: a present wind value (a typed 0 included) is
 *  kept; only an absent field reads back as unset. Pre-METAR stores
 *  wrote a padding 0 for every block, which now reads as explicit calm (the
 *  Reset button clears it). An older store's aerodrome QNH (`legacyQnh`,
 *  one for both phases) becomes each phase's own. */
function storedBlock(b: Partial<PerfBlockInputs> | undefined, legacyQnh: number | null = null): PerfBlockInputs {
	return {
		...defaultPerfBlock(),
		...b,
		qnhHpa: b?.qnhHpa ?? legacyQnh,
		// A stored 0 is typed (kept); an absent field is unset.
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
	return storedPilot() ?? legacy;
}

/** The pilot block as STORED, or null when its key holds none. */
function storedPilot(): DossierInputs['pilot'] | null {
	const stored = readJson<Partial<DossierInputs['pilot']>>(PILOT_KEY);
	if (!stored || typeof stored !== 'object') {
		return null;
	}
	return {
		name: typeof stored.name === 'string' ? stored.name : '',
		sepValidUntil: typeof stored.sepValidUntil === 'string' ? stored.sepValidUntil : null,
		medicalValidUntil:
			typeof stored.medicalValidUntil === 'string' ? stored.medicalValidUntil : null,
		mepValidUntil: typeof stored.mepValidUntil === 'string' ? stored.mepValidUntil : null,
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
				refuel: stored.mb.refuel !== false,
				onBoard: storedOnBoard(stored.mb.onBoard),
				stopovers: storedStopovers(stored.mb.stopovers),
			};
		}
		if (stored.perf && typeof stored.perf === 'object') {
			const byIcao: Record<string, PerfAerodromeInputs> = {};
			for (const [icao, a] of Object.entries(stored.perf.byIcao ?? {})) {
				// A store from before the QNH went per phase holds one for both.
				const legacy = (a as { qnhHpa?: number | null }).qnhHpa ?? null;
				byIcao[icao] = {
					takeoff: storedBlock(a.takeoff, legacy),
					landing: storedBlock(a.landing, legacy),
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
	if (readJson(PILOT_KEY) === null && !isEmptyPilot(p)) {
		writeJson(PILOT_KEY, pilotRecord($state.snapshot(p)));
	}
}

function persist(): void {
	// The pilot block persists under its own key; the blob written here
	// sheds it so the two stores can never disagree.
	const snap = $state.snapshot(flightPrep);
	writeJson(STORAGE_KEY, { v: 1, ...snap, dossier: { ...snap.dossier, pilot: undefined } });
}

/** The pilot block as stored: the MEP date only when set, so a pilot
 *  without one keeps the stored text an app from before it wrote, which the
 *  shared session's found copy compares raw (sync/found.ts). */
function pilotRecord(p: DossierInputs['pilot']): Partial<DossierInputs['pilot']> {
	const { mepValidUntil, ...rest } = p;
	return mepValidUntil != null ? { ...rest, mepValidUntil } : rest;
}

function persistPilot(): void {
	writeJson(PILOT_KEY, pilotRecord($state.snapshot(flightPrep.dossier.pilot)));
}

/** The pilot block snapshot (the sync payload's source). */
export function pilotSnapshot(): DossierInputs['pilot'] {
	return $state.snapshot(flightPrep.dossier.pilot);
}

/** The pilot block back to blank, in memory and stored: a shared sign-in
 *  sets the one it found aside for the session, whose pilot block is its
 *  own pilot's, and the session's end puts it back (state/sync.svelte.ts,
 *  sync/found.ts). */
export function clearPilot(): void {
	flightPrep.dossier.pilot = { name: '', sepValidUntil: null, medicalValidUntil: null, mepValidUntil: null };
	persistPilot();
}

/** Apply the remote pilot doc (lww whole; docs/accounts-sync.md). */
export function applyRemotePilot(p: DossierInputs['pilot']): void {
	flightPrep.dossier.pilot = { ...p };
	persistPilot();
}

function isEmptyPilot(p: DossierInputs['pilot']): boolean {
	return p.name === '' && p.sepValidUntil === null && p.medicalValidUntil === null && p.mepValidUntil === null;
}

/** Restore the pilot details an account data download carries, never over
 *  details this device already holds (the importer's rule for aircraft
 *  sheets): an empty block takes the file's whole, a block holding anything
 *  stays as it is. 'same' when there is nothing to do, an empty file
 *  included. */
export function restorePilot(p: DossierInputs['pilot']): 'restored' | 'kept' | 'same' {
	const mine = flightPrep.dossier.pilot;
	if (
		isEmptyPilot(p) ||
		(mine.name === p.name &&
			mine.sepValidUntil === p.sepValidUntil &&
			mine.medicalValidUntil === p.medicalValidUntil &&
			mine.mepValidUntil === p.mepValidUntil)
	) {
		return 'same';
	}
	if (!isEmptyPilot(mine)) {
		return 'kept';
	}
	flightPrep.dossier.pilot = { ...p };
	persistPilot();
	return 'restored';
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

export function setMbLoad(key: string, massKg: number | null): void {
	if (massKg == null) {
		delete flightPrep.mb.loads[key];
	} else {
		flightPrep.mb.loads[key] = massKg;
	}
	persist();
}

/** The selected plane's stations were renamed or one was taken out in the
 *  aircraft editor (massBalance.ts stationKeyRemap): every load typed for
 *  them, at the departure and at each stop, follows its station to its new
 *  key, and a station taken out takes its load with it. A load stored under
 *  no station of the sheet as it was (left by an older edit) stays put. */
export function remapStationLoads(remap: ReadonlyMap<string, string | null>): void {
	const move = (loads: Record<string, number>): Record<string, number> => {
		const out: Record<string, number> = {};
		for (const [key, massKg] of Object.entries(loads)) {
			if (!remap.has(key)) {
				out[key] = massKg;
			}
		}
		for (const [from, to] of remap) {
			if (to === null) {
				continue;
			}
			// A station that had no load keeps none, whatever a leftover held
			// under its new label.
			if (from in loads) {
				out[to] = loads[from];
			} else {
				delete out[to];
			}
		}
		return out;
	};
	flightPrep.mb.loads = move(flightPrep.mb.loads);
	for (const [key, st] of Object.entries(flightPrep.mb.stopovers)) {
		st.loads = move(st.loads);
		pruneStop(key);
	}
	persist();
}

export function setMb(patch: Partial<Pick<FlightPrepState['mb'], 'fuelMode' | 'customLitres' | 'refuel'>>): void {
	Object.assign(flightPrep.mb, patch);
	persist();
}

/** The departure's reading, made when the pilot first states something:
 *  stamped with the selected aircraft and today (UTC). */
function onBoardFor(stamp: boolean): OnBoardInputs {
	const cur = flightPrep.mb.onBoard;
	if (cur == null) {
		flightPrep.mb.onBoard = {
			aircraft: aircraftState.selectedKey ?? '',
			readOn: todayUtcIso(),
			last: null,
			flights: [],
			lph: null,
			measuredL: null,
		};
	} else if (stamp) {
		// A new reading of the log or of the tanks is taken now, for this
		// aircraft; a consumption typed today is not one (an override must not
		// make yesterday's reading look fresh).
		cur.aircraft = aircraftState.selectedKey ?? '';
		cur.readOn = todayUtcIso();
	}
	return flightPrep.mb.onBoard!;
}

/** The departure's last refuel, consumption or measured quantity. */
export function setOnBoard(patch: Partial<Pick<OnBoardInputs, 'last' | 'lph' | 'measuredL'>>): void {
	const ob = onBoardFor('last' in patch || 'measuredL' in patch);
	Object.assign(ob, patch);
	persist();
}

/** Journey-log line `i` (its flight time in minutes, the litres added
 *  before it); a line past the end is added. */
export function setOnBoardFlight(i: number, patch: Partial<LogFlight>): void {
	const ob = onBoardFor(true);
	while (ob.flights.length <= i) {
		ob.flights.push({ min: null, addedL: null });
	}
	Object.assign(ob.flights[i], patch);
	persist();
}

export function addOnBoardFlight(): void {
	onBoardFor(false).flights.push({ min: null, addedL: null });
	persist();
}

export function removeOnBoardFlight(i: number): void {
	const ob = flightPrep.mb.onBoard;
	if (ob && i >= 0 && i < ob.flights.length) {
		onBoardFor(true);
		ob.flights.splice(i, 1);
		persist();
	}
}

/** Forget what the departure's tanks hold, and its no refuel with it: the
 *  departure is refuelled to its target again, as when nothing was read. */
export function clearOnBoard(): void {
	if (flightPrep.mb.onBoard != null || !flightPrep.mb.refuel) {
		flightPrep.mb.onBoard = null;
		flightPrep.mb.refuel = true;
		persist();
	}
}

/** A stop's inputs: the stored entry or the defaults (no write on read). */
export function stopInputs(key: string): StopInputs {
	return flightPrep.mb.stopovers[key] ?? defaultStopInputs();
}

/** The stop's stored entry, created on first edit and read back out of
 *  state (materializePerf's reason). */
function materializeStop(key: string): StopInputs {
	flightPrep.mb.stopovers[key] ??= defaultStopInputs();
	return flightPrep.mb.stopovers[key];
}

/** Drop an entry back to nothing once it states nothing. */
function pruneStop(key: string): void {
	const st = flightPrep.mb.stopovers[key];
	if (st && stopStatesNothing(st)) {
		delete flightPrep.mb.stopovers[key];
	}
}

/** Tick or untick the refuel at a stop; the target it had is kept. */
export function setStopRefuel(key: string, refuel: boolean): void {
	materializeStop(key).refuel = refuel;
	pruneStop(key);
	persist();
}

/** The fuel a ticked stop refuels to. */
export function setStopFuel(key: string, patch: Partial<Pick<StopInputs, 'mode' | 'litres'>>): void {
	Object.assign(materializeStop(key), patch);
	pruneStop(key);
	persist();
}

/** The fuel at a stop, the one control both pages show (the Fuel plan page's
 *  table and the trip's sheet on the M&B page): a target sets the
 *  fuel there, null carries over what arrives, the target it had kept for a
 *  later pick. One write. */
export function setStopTarget(key: string, mode: MbFuelMode | null): void {
	const st = materializeStop(key);
	if (mode === null) {
		st.refuel = false;
	} else {
		st.refuel = true;
		st.mode = mode;
	}
	pruneStop(key);
	persist();
}

/** A stop's target, null where the fuel carries over. */
export function stopTarget(key: string): MbFuelMode | null {
	const st = stopInputs(key);
	return st.refuel ? st.mode : null;
}

/** A payload change at a stop; null carries the trip before's mass again. */
export function setStopLoad(key: string, station: string, massKg: number | null): void {
	const st = materializeStop(key);
	if (massKg == null) {
		delete st.loads[station];
	} else {
		st.loads[station] = massKg;
	}
	pruneStop(key);
	persist();
}

/** A refuelling strategy taken as the plan (the fuel page's "Use this plan"):
 *  its stops ticked, the other stops of `all` unticked. A stop ticked here
 *  for the first time refuels to the Minimum, so the loads reproduce the
 *  strategy's figures; one already ticked keeps its target. The departure is
 *  the pilot's own and is not touched. */
export function applyRefuelStops(ticked: readonly string[], all: readonly string[]): void {
	for (const key of all) {
		const on = ticked.includes(key);
		const st = flightPrep.mb.stopovers[key];
		if (on && !st?.refuel) {
			const m = materializeStop(key);
			m.refuel = true;
			m.mode = 'minimum';
		} else if (!on && st?.refuel) {
			st.refuel = false;
			pruneStop(key);
		}
	}
	persist();
}

/** Forget every stop's inputs (a cleared workspace starts a new plan, which
 *  must not find a refuel ticked at a field it happens to share). */
export function clearStopovers(): void {
	if (Object.keys(flightPrep.mb.stopovers).length > 0) {
		flightPrep.mb.stopovers = {};
		persist();
	}
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
		for (const phase of ['takeoff', 'landing'] as const) {
			a[phase].qnhHpa = null;
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

function todayUtcIso(nowMs: number = Date.now()): string {
	// One-shot timestamp formatted to a calendar date; not reactive.
	const now = new Date(nowMs);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}`;
}

/** Is a dossier flight date ('YYYY-MM-DD') before `nowMs`'s day, on the
 *  dossier's own UTC calendar? A date already behind us puts every timed
 *  read (the forecast winds, the sun, the TEMSI / WINTEM window) on a flight
 *  that has flown, which a stored plan activated again or a dossier left
 *  from last week would otherwise do in silence. */
export function isPastFlightDate(date: string | null, nowMs: number = Date.now()): boolean {
	return date != null && date !== '' && date < todayUtcIso(nowMs);
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

/** Has the pilot STATED a departure time?
 *
 *  The ONE test, because the answer gates every surface that must not show a
 *  clock reading nobody gave: navLive's ETO column, the dossier timeline, and
 *  the Flight evaluation window, which takes the flight's whole DAY instead.
 *  `firstDepartureMs` reads the same truthiness before falling back to its own
 *  anchor. It was spelled four ways before this (truthy, `!= null`, `== null`,
 *  `!!`), which agree only while the field is null-or-clock and would diverge
 *  the day an empty string reached it, silently and in one place only. */
export function hasStatedEtd(): boolean {
	return !!flightPrep.dossier.departureTime;
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

/** Edit the pilot block, from the block as STORED: another tab may have
 *  written it since this one read it (a shared sign-in sets a found block
 *  aside), and this tab's older copy written back whole would bring back
 *  details its pilot never typed here, to sync as theirs. */
export function setDossierPilot(patch: Partial<DossierInputs['pilot']>): void {
	flightPrep.dossier.pilot = {
		...(storedPilot() ?? $state.snapshot(flightPrep.dossier.pilot)),
		...patch,
	};
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
	// Only an unset (null) field is default; a typed 0 makes the block
	// non-default so it persists like any other override.
	return (
		b.qnhHpa == null &&
		b.tempC == null &&
		b.headwindKt == null &&
		b.tailwindKt == null &&
		!b.wet &&
		b.runwayEnd == null
	);
}

/** One phase block for the file; its QNH only where the aerodrome's own
 *  (`shared`, both phases agreeing) does not already state it. */
function toDocBlock(b: PerfBlockInputs, shared: number | null): FlightPrepPerfBlock {
	return {
		qnhHpa: shared == null ? (b.qnhHpa ?? undefined) : undefined,
		temperatureC: b.tempC ?? undefined,
		// Keep a typed 0; only unset (null) drops to an absent key.
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
 *  (the derived list reproduces from the routes on load). `stopKeys` = the
 *  plan's CURRENT stops (tripStopKeys), in order: only those stopovers are
 *  written, and only when they state something (a tick or a payload change).
 *  Required, never defaulted: a caller that forgot it would compile and
 *  silently drop every refuel from the file and from the plan signature. */
export function buildFlightPrepForSave(
	tripCount: number,
	perfIcaos: readonly string[],
	stopKeys: readonly string[],
): FlightPrepDoc | undefined {
	const aircraft = aircraftState.selectedKey;
	const statedStopovers = stopKeys.filter((key) => {
		const st = flightPrep.mb.stopovers[key];
		return st != null && (st.refuel || Object.keys(st.loads).length > 0);
	});
	const d = flightPrep.dossier;
	const dossierTouched =
		d.flightDate != null ||
		d.departureTime != null ||
		d.stopsMin.some((n) => n != null) ||
		d.pilot.name !== '' ||
		d.pilot.sepValidUntil != null ||
		d.pilot.medicalValidUntil != null ||
		d.pilot.mepValidUntil != null ||
		d.potentialMin != null ||
		d.qnhHpa != null ||
		Object.values(d.checks).some(Boolean);
	const touched =
		aircraft != null ||
		dossierTouched ||
		flightPrep.fuel.trips.some(
			(t) =>
				!statesNoMinute(
					t.taxiMin,
					t.procedureMin,
					t.contingencyMin,
					t.altProcedureMin,
					t.marginMin,
					t.finalReserveMin,
				),
		) ||
		Object.keys(flightPrep.mb.loads).length > 0 ||
		flightPrep.mb.fuelMode !== 'full' ||
		!flightPrep.mb.refuel ||
		onBoardStates(flightPrep.mb.onBoard) ||
		statedStopovers.length > 0 ||
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
			mepValidUntil: d.pilot.mepValidUntil ?? undefined,
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
				contingencyMin: t.contingencyMin ?? undefined,
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
				trips[trips.length - 1].contingencyMin,
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
	const onBoard = onBoardStates(mb.onBoard) ? mb.onBoard : null;
	if (
		Object.keys(mb.loads).length > 0 ||
		mb.fuelMode !== 'full' ||
		mb.customLitres != null ||
		!mb.refuel ||
		onBoard != null ||
		statedStopovers.length > 0
	) {
		doc.massBalance = {
			loads: Object.keys(mb.loads).length > 0 ? { ...mb.loads } : undefined,
			fuelMode: mb.fuelMode,
			fuelLitres: mb.customLitres ?? undefined,
			refuel: mb.refuel ? undefined : false,
			onBoard: onBoard ? onBoardToDoc(onBoard) : undefined,
		};
		if (statedStopovers.length > 0) {
			// The departure's own vocabulary; a mode present means ticked.
			doc.massBalance.stopovers = Object.fromEntries(
				statedStopovers.map((key) => {
					const st = mb.stopovers[key];
					return [
						key,
						{
							fuelMode: st.refuel ? st.mode : undefined,
							fuelLitres: st.refuel ? (st.litres ?? undefined) : undefined,
							loads: Object.keys(st.loads).length > 0 ? { ...st.loads } : undefined,
						},
					];
				}),
			);
		}
	}
	const aerodromes = perfIcaos
		.filter(
			(icao) =>
				flightPrep.perf.manualIcaos.includes(icao) ||
				(flightPrep.perf.byIcao[icao] &&
					(!isDefaultBlock(flightPrep.perf.byIcao[icao].takeoff) ||
						!isDefaultBlock(flightPrep.perf.byIcao[icao].landing))),
		)
		.map((icao) => {
			const a = perfFor(icao);
			// One QNH typed for both phases stays the aerodrome's own key, as
			// every file wrote it before the QNH went per phase; two
			// different ones go under their phases.
			const shared = a.takeoff.qnhHpa != null && a.takeoff.qnhHpa === a.landing.qnhHpa ? a.takeoff.qnhHpa : null;
			return {
				icao,
				qnhHpa: shared ?? undefined,
				takeoff: toDocBlock(a.takeoff, shared),
				landing: toDocBlock(a.landing, shared),
			};
		});
	if (aerodromes.length > 0) {
		doc.aerodromes = aerodromes;
	}
	return doc;
}

/** A file's phase block; the aerodrome's QNH (`aerodromeQnh`, both
 *  phases') where the block states none. `weather: false` keeps only the
 *  runway picked: the QNH, temperature, wind and wet runway typed for the
 *  flight the plan was stored for (the catalog's Activate). */
function loadedBlock(
	b: FlightPrepPerfBlock | undefined,
	aerodromeQnh: number | null,
	weather = true,
): PerfBlockInputs {
	if (!weather) {
		return { ...defaultPerfBlock(), runwayEnd: b?.runwayEnd ?? null };
	}
	return {
		qnhHpa: b?.qnhHpa ?? aerodromeQnh,
		tempC: b?.temperatureC ?? null,
		// Absent key = unset (follows the METAR); a present 0 is an explicit
		// calm that overrides it.
		headwindKt: b?.headwindKt ?? null,
		tailwindKt: b?.tailwindKt ?? null,
		wet: b?.wet ?? false,
		runwayEnd: b?.runwayEnd ?? null,
	};
}

/** Does a stored phase block hold weather the pilot typed? */
function statesWeather(b: FlightPrepPerfBlock | undefined, aerodromeQnh: number | null): boolean {
	return (
		b?.qnhHpa != null ||
		aerodromeQnh != null ||
		b?.temperatureC != null ||
		b?.headwindKt != null ||
		b?.tailwindKt != null ||
		b?.wet === true
	);
}

/** Open-file semantics: replace the flight prep with the loaded block
 *  (missing pieces reset to defaults). EXCEPTION: the dossier's pilot block
 *  is user identity, so the current values carry over and a loaded file only
 *  overrides the pilot fields it explicitly carries; on a SHARED computer not
 *  even those: the pilot block there is the signed-in pilot's
 *  (docs/accounts-sync.md), and a plan in its catalog or a file in its
 *  downloads may be another pilot's, whose name and dates would otherwise
 *  sync into this one's account. The aircraft key, when
 *  present, selects even an unknown plane (returned so the caller can
 *  surface it); when absent the current selection is kept. `derivedIcaos` =
 *  the aerodromes the loaded routes imply; loaded rows beyond them become
 *  manual adds. `dropPastFlightDate` is the catalog's Activate: a stored
 *  plan flown again is a new flight, so a flight date already behind us is
 *  left out (the dossier falls back to today) and returned for the notice,
 *  while the ETD clock stays; a date ahead is kept. `dropOnBoard` is the
 *  Activate's too: what the tanks held when the plan was stored is not what
 *  they hold now, so the reading goes (the day it was read returned for the
 *  notice) and the departure is refuelled to its target again.
 *  `dropTypedWeather` is the Activate's too: the weather typed for the
 *  flight the plan was stored for (the performance page's QNH, temperature,
 *  wind and wet runway, its QNH where nothing is observed) is that day's,
 *  not today's; the runway picked stays. `weatherDropped` says whether any
 *  went. */
export function applyLoadedFlightPrep(
	fp: FlightPrepDoc | undefined,
	derivedIcaos: readonly string[],
	opts: { dropPastFlightDate?: boolean; dropOnBoard?: boolean; dropTypedWeather?: boolean } = {},
): {
	unknownAircraft: string | null;
	droppedFlightDate: string | null;
	droppedOnBoard: string | null;
	weatherDropped: boolean;
} {
	const shared = sharedDeviceFlag();
	const pilot = (shared ? storedPilot() : null) ?? $state.snapshot(flightPrep.dossier.pilot);
	const next = defaults();
	next.dossier.pilot = pilot;
	let unknownAircraft: string | null = null;
	let droppedFlightDate: string | null = null;
	let droppedOnBoard: string | null = null;
	let weatherDropped = false;
	const keepWeather = opts.dropTypedWeather !== true;
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
				contingencyMin: t.contingencyMin ?? null,
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
			const reading = onBoardFromDoc(fp.massBalance.onBoard);
			if (opts.dropOnBoard) {
				droppedOnBoard = reading?.readOn ?? null;
			} else {
				next.mb.onBoard = reading;
				next.mb.refuel = fp.massBalance.refuel !== false;
			}
			for (const [key, so] of Object.entries(fp.massBalance.stopovers ?? {})) {
				// A mode this app does not know reads as no refuel: the plan
				// then turns red rather than green on a guess.
				const stopMode = so.fuelMode as MbFuelMode | undefined;
				const known = stopMode != null && FUEL_MODES.includes(stopMode);
				const st: StopInputs = {
					refuel: known,
					mode: known ? stopMode : 'full',
					litres: validLitres(so.fuelLitres),
					loads: validLoads(so.loads),
				};
				if (!stopStatesNothing(st)) {
					next.mb.stopovers[key] = st;
				}
			}
		}
		for (const a of fp.aerodromes ?? []) {
			if (!keepWeather && (statesWeather(a.takeoff, a.qnhHpa ?? null) || statesWeather(a.landing, null))) {
				weatherDropped = true;
			}
			next.perf.byIcao[a.icao] = {
				takeoff: loadedBlock(a.takeoff, a.qnhHpa ?? null, keepWeather),
				landing: loadedBlock(a.landing, a.qnhHpa ?? null, keepWeather),
			};
			if (!derivedIcaos.includes(a.icao) && !next.perf.manualIcaos.includes(a.icao)) {
				next.perf.manualIcaos.push(a.icao);
			}
		}
		const d = fp.dossier;
		if (d) {
			if (d.flightDate) {
				if (opts.dropPastFlightDate && isPastFlightDate(d.flightDate)) {
					droppedFlightDate = d.flightDate;
				} else {
					next.dossier.flightDate = d.flightDate;
				}
			}
			if (d.departureTime) {
				next.dossier.departureTime = d.departureTime;
			}
			if (d.stopsMin) {
				next.dossier.stopsMin = d.stopsMin.map((n) =>
					typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null,
				);
			}
			if (!shared && d.pilotName != null) {
				next.dossier.pilot.name = d.pilotName;
			}
			if (!shared && d.sepValidUntil != null) {
				next.dossier.pilot.sepValidUntil = d.sepValidUntil;
			}
			if (!shared && d.mepValidUntil != null) {
				next.dossier.pilot.mepValidUntil = d.mepValidUntil;
			}
			if (!shared && d.medicalValidUntil != null) {
				next.dossier.pilot.medicalValidUntil = d.medicalValidUntil;
			}
			if (d.potential) {
				next.dossier.potentialMin = parseDuration(d.potential);
			}
			if (d.qnhHpa != null) {
				if (keepWeather) {
					next.dossier.qnhHpa = d.qnhHpa;
				} else {
					weatherDropped = true;
				}
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
	// pilot-staleness residual). Not on a shared computer, where no file
	// states them.
	if (!shared) {
		persistPilot();
	}
	return { unknownAircraft, droppedFlightDate, droppedOnBoard, weatherDropped };
}
