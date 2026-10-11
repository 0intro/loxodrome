/* Pins the rule the flight-preparation bridge decides in both directions: an
 * input the pilot never typed is AUTOMATIC, and automatic states nothing. The
 * fuel plan's five per-trip minutes and the overview's ground stops all hold
 * null for it, so the page can show the value in force as a placeholder and the
 * pilot's own minutes as a typed value; the file and localStorage then carry
 * the same distinction, since a stored 10 would come back as a decision nobody
 * made. The defaults themselves live in aircraft/fuel.ts, which is where they
 * are applied. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	addOnBoardFlight,
	applyLoadedFlightPrep,
	applyRefuelStops,
	buildFlightPrepForSave,
	clearOnBoard,
	clearStopovers,
	defaultTripFuel,
	dossierStopEffectiveMin,
	dossierStopMin,
	flightPrep,
	setDossierStop,
	removeOnBoardFlight,
	setMb,
	setOnBoard,
	setOnBoardFlight,
	setPerfBlock,
	perfFor,
	setStopFuel,
	setStopLoad,
	setStopRefuel,
	setStopTarget,
	setTripFuel,
	stopInputs,
	stopTarget,
	tripFuel,
} from '../src/lib/state/flightPrep.svelte';
import { selectAircraft } from '../src/lib/state/aircraft.svelte';

describe('the automatic / stated distinction', () => {
	beforeEach(() => {
		// A fresh plan: two trips, nothing typed.
		applyLoadedFlightPrep(undefined, []);
	});

	it('starts every fuel minute and every stop automatic', () => {
		expect(defaultTripFuel()).toEqual({
			taxiMin: null,
			procedureMin: null,
			contingencyMin: null,
			altProcedureMin: null,
			marginMin: null,
			finalReserveMin: null,
		});
		expect(tripFuel(0).taxiMin).toBe(null);
		expect(dossierStopMin(0)).toBe(null);
		// Automatic is no ground time, which is what the timeline chains on.
		expect(dossierStopEffectiveMin(0)).toBe(0);
	});

	it('writes nothing for a plan nobody touched', () => {
		expect(buildFlightPrepForSave(2, [], [])).toBeUndefined();
	});

	it('writes only what the pilot stated', () => {
		setTripFuel(1, { taxiMin: 5 });
		const doc = buildFlightPrepForSave(2, [], []);
		// Trip 1 is untouched but the array is index-aligned with the trips, so
		// it stays as an entry that states nothing.
		expect(doc!.fuelTrips).toEqual([
			{
				taxiMin: undefined,
				procedureMin: undefined,
				alternateProcedureMin: undefined,
				marginMin: undefined,
				finalReserveMin: undefined,
			},
			{
				taxiMin: 5,
				procedureMin: undefined,
				alternateProcedureMin: undefined,
				marginMin: undefined,
				finalReserveMin: undefined,
			},
		]);
	});

	it('writes no contingency key it was not given, so stored plan signatures stay put', () => {
		// The plan signature hashes this document (activePlan planSig): an
		// unstated contingency must vanish from it, not read as null.
		setTripFuel(0, { taxiMin: 5 });
		expect(JSON.stringify(buildFlightPrepForSave(2, [], []))).not.toMatch(/contingency/);
	});

	it('drops a trailing automatic trip rather than stating it', () => {
		setTripFuel(0, { procedureMin: 15 });
		expect(buildFlightPrepForSave(3, [], [])!.fuelTrips).toHaveLength(1);
	});

	it('keeps a trip that states only a contingency, and brings it back', () => {
		// The club form's "Perfo, évitements, MTO, ATC, attente": a trip whose
		// only typed minute is its contingency is a stated trip, in the file
		// and out of the trailing trim.
		setTripFuel(1, { contingencyMin: 10 });
		const doc = buildFlightPrepForSave(2, [], []);
		expect(doc!.fuelTrips).toHaveLength(2);
		expect(doc!.fuelTrips![1].contingencyMin).toBe(10);
		expect(doc!.fuelTrips![0].contingencyMin).toBeUndefined();
		applyLoadedFlightPrep(doc, []);
		expect(tripFuel(1).contingencyMin).toBe(10);
		expect(tripFuel(0).contingencyMin).toBe(null);
	});

	it('brings a stated minute back as stated and an absent one as automatic', () => {
		applyLoadedFlightPrep({ fuelTrips: [{ taxiMin: 5, finalReserveMin: 45 }] }, []);
		expect(tripFuel(0)).toEqual({
			taxiMin: 5,
			procedureMin: null,
			contingencyMin: null,
			altProcedureMin: null,
			marginMin: null,
			finalReserveMin: 45,
		});
	});

	it('keeps a stated zero, which an automatic field cannot express', () => {
		// 0 minutes of taxi is a decision (a run-up bay at the threshold); the
		// automatic 10 is not, and a round trip must not turn one into the other.
		setTripFuel(0, { taxiMin: 0, marginMin: 0 });
		setDossierStop(0, 0);
		const doc = buildFlightPrepForSave(2, [], []);
		expect(doc!.fuelTrips![0].taxiMin).toBe(0);
		expect(doc!.fuelTrips![0].marginMin).toBe(0);
		expect(doc!.dossier!.stopsMin).toEqual([0]);
		applyLoadedFlightPrep(doc, []);
		expect(tripFuel(0).taxiMin).toBe(0);
		expect(dossierStopMin(0)).toBe(0);
	});

	it('hands a field back to automatic when it is cleared', () => {
		setTripFuel(0, { taxiMin: 5 });
		setDossierStop(0, 15);
		setTripFuel(0, { taxiMin: null });
		setDossierStop(0, null);
		expect(tripFuel(0).taxiMin).toBe(null);
		expect(dossierStopMin(0)).toBe(null);
		expect(buildFlightPrepForSave(2, [], [])).toBeUndefined();
	});
});

/* The stops between trips: a refuel tick and its target, and the payload
 * changes made there, keyed by the stop's aerodrome. The default state, and a
 * stop no longer in the plan, write nothing, so the plan signature of every
 * stored plan stays what it was. */
describe('the stopovers', () => {
	beforeEach(() => {
		applyLoadedFlightPrep(undefined, []);
	});

	it('a stop starts unticked at Full tanks, and nothing is written', () => {
		expect(stopInputs('LFQH')).toEqual({ refuel: false, mode: 'full', litres: null, loads: {} });
		expect(buildFlightPrepForSave(3, [], ['LFQH', 'LFGP'])).toBeUndefined();
	});

	it('writes a ticked stop in the departure\'s vocabulary, current stops only', () => {
		setStopRefuel('LFQH', true);
		setStopLoad('LFGP', 'Rear seats', 0);
		// A stop that left the plan: kept in store, never written.
		setStopRefuel('LFXX', true);
		const doc = buildFlightPrepForSave(3, [], ['LFQH', 'LFGP']);
		expect(doc!.massBalance).toEqual({
			loads: undefined,
			fuelMode: 'full',
			fuelLitres: undefined,
			stopovers: {
				LFQH: { fuelMode: 'full', fuelLitres: undefined, loads: undefined },
				LFGP: { fuelMode: undefined, fuelLitres: undefined, loads: { 'Rear seats': 0 } },
			},
		});
		expect(Object.keys(doc!.massBalance!.stopovers!)).toEqual(['LFQH', 'LFGP']);
		// Only a stale entry: the block is not written at all.
		expect(buildFlightPrepForSave(3, [], ['LFPK'])).toBeUndefined();
		expect(stopInputs('LFXX').refuel).toBe(true);
	});

	it('an untick keeps the target for a retick, and writes nothing', () => {
		setStopRefuel('LFQH', true);
		setStopFuel('LFQH', { mode: 'custom', litres: 60 });
		setStopRefuel('LFQH', false);
		expect(stopInputs('LFQH')).toEqual({ refuel: false, mode: 'custom', litres: 60, loads: {} });
		expect(buildFlightPrepForSave(3, [], ['LFQH'])).toBeUndefined();
		setStopRefuel('LFQH', true);
		expect(stopInputs('LFQH')).toMatchObject({ refuel: true, mode: 'custom', litres: 60 });
	});

	it('an entry back at its defaults is dropped', () => {
		setStopLoad('LFGP', 'Baggage', 20);
		setStopLoad('LFGP', 'Baggage', null);
		expect(flightPrep.mb.stopovers).toEqual({});
	});

	it('round-trips through the file shape', () => {
		setMb({ fuelMode: 'max' });
		setStopRefuel('LFQH', true);
		setStopFuel('LFQH', { mode: 'custom', litres: 80 });
		setStopRefuel('LFQH#2', true);
		setStopLoad('48.5000,3.8123', 'Front seats', 75);
		const keys = ['LFQH', '48.5000,3.8123', 'LFQH#2'];
		const doc = buildFlightPrepForSave(4, [], keys);
		applyLoadedFlightPrep(undefined, []);
		expect(flightPrep.mb.stopovers).toEqual({});
		applyLoadedFlightPrep(doc, []);
		expect(flightPrep.mb.fuelMode).toBe('max');
		expect(stopInputs('LFQH')).toEqual({ refuel: true, mode: 'custom', litres: 80, loads: {} });
		expect(stopInputs('LFQH#2')).toEqual({ refuel: true, mode: 'full', litres: null, loads: {} });
		expect(stopInputs('48.5000,3.8123')).toEqual({
			refuel: false,
			mode: 'full',
			litres: null,
			loads: { 'Front seats': 75 },
		});
		expect(buildFlightPrepForSave(4, [], keys)).toEqual(doc);
	});

	it('a mode this app does not know reads as no refuel (red, never a guessed green)', () => {
		applyLoadedFlightPrep(
			{ massBalance: { stopovers: { LFQH: { fuelMode: 'brim', fuelLitres: 50 }, LFGP: { fuelLitres: -3 } } } },
			[],
		);
		expect(stopInputs('LFQH')).toEqual({ refuel: false, mode: 'full', litres: 50, loads: {} });
		expect(flightPrep.mb.stopovers.LFGP).toBeUndefined();
	});

	it('Use this plan: its stops ticked at Minimum, the others unticked, targets kept', () => {
		setStopRefuel('LFGP', true);
		setStopFuel('LFGP', { mode: 'custom', litres: 70 });
		setStopRefuel('LFQH', true); // Full tanks
		setMb({ fuelMode: 'custom', customLitres: 63 });
		applyRefuelStops(['LFGP', 'LFPK'], ['LFQH', 'LFGP', 'LFPK']);
		expect(stopInputs('LFQH').refuel).toBe(false);
		expect(stopInputs('LFGP')).toMatchObject({ refuel: true, mode: 'custom', litres: 70 });
		expect(stopInputs('LFPK')).toMatchObject({ refuel: true, mode: 'minimum' });
		// The departure is the pilot's own.
		expect(flightPrep.mb.fuelMode).toBe('custom');
		expect(flightPrep.mb.customLitres).toBe(63);
		// A stop outside `all` is not touched.
		setStopRefuel('LFXX', true);
		applyRefuelStops([], ['LFQH', 'LFGP', 'LFPK']);
		expect(stopInputs('LFXX').refuel).toBe(true);
		expect(stopInputs('LFGP')).toMatchObject({ refuel: false, mode: 'custom', litres: 70 });
	});

	it('the shared control: a target refuels there in one write, none carries over keeping it', () => {
		const writes: string[] = [];
		vi.stubGlobal('localStorage', {
			getItem: () => null,
			setItem: (key: string) => writes.push(key),
			removeItem: () => {},
		});
		try {
			setStopTarget('LFQH', 'max');
			expect(writes).toEqual(['loxodrome:flight-prep']);
		} finally {
			vi.unstubAllGlobals();
		}
		expect(stopInputs('LFQH')).toEqual({ refuel: true, mode: 'max', litres: null, loads: {} });
		expect(stopTarget('LFQH')).toBe('max');
		expect(buildFlightPrepForSave(3, [], ['LFQH'])!.massBalance!.stopovers).toEqual({
			LFQH: { fuelMode: 'max', fuelLitres: undefined, loads: undefined },
		});
		// No refuel keeps the target for a later pick, and states nothing.
		setStopTarget('LFGP', 'custom');
		setStopFuel('LFGP', { litres: 60 });
		setStopTarget('LFGP', null);
		expect(stopInputs('LFGP')).toEqual({ refuel: false, mode: 'custom', litres: 60, loads: {} });
		expect(stopTarget('LFGP')).toBeNull();
		setStopTarget('LFGP', 'custom');
		expect(stopInputs('LFGP')).toMatchObject({ refuel: true, mode: 'custom', litres: 60 });
		// Full tanks back to none: the entry states nothing and goes.
		setStopTarget('LFPK', 'full');
		setStopTarget('LFPK', null);
		expect(flightPrep.mb.stopovers.LFPK).toBeUndefined();
	});

	it('the shared control saves what the tick and the target saved', () => {
		setStopRefuel('LFQH', true);
		setStopFuel('LFQH', { mode: 'minimum' });
		const before = buildFlightPrepForSave(3, [], ['LFQH']);
		applyLoadedFlightPrep(undefined, []);
		setStopTarget('LFQH', 'minimum');
		expect(buildFlightPrepForSave(3, [], ['LFQH'])).toEqual(before);
	});

	it('a cleared workspace forgets them', () => {
		setStopRefuel('LFQH', true);
		clearStopovers();
		expect(flightPrep.mb.stopovers).toEqual({});
	});
});

/* What the departure's tanks hold before its refuel (aircraft/onBoard.ts):
 * the journey log or a measured quantity, stamped with the aircraft and the
 * day it was READ, which only a reading restamps (a consumption typed today
 * must not make yesterday's reading look fresh); written to the plan file
 * only when it states something, and left out when a stored plan is
 * activated again. */
describe('the fuel on board at the departure', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-06T08:00:00Z'));
		selectAircraft('F-GORQ');
		applyLoadedFlightPrep(undefined, []);
	});

	afterEach(() => {
		vi.useRealTimers();
		selectAircraft(null);
	});

	it('starts refuelled with nothing read, and writes nothing of it', () => {
		expect(flightPrep.mb.refuel).toBe(true);
		expect(flightPrep.mb.onBoard).toBeNull();
		expect(buildFlightPrepForSave(2, [], [])!.massBalance).toBeUndefined();
	});

	it('a reading is stamped with the aircraft and the day it was read', () => {
		setOnBoard({ last: { kind: 'full' } });
		setOnBoardFlight(0, { min: 45 });
		setOnBoardFlight(1, { min: 40 });
		expect(flightPrep.mb.onBoard).toEqual({
			aircraft: 'F-GORQ',
			readOn: '2026-10-06',
			last: { kind: 'full' },
			flights: [
				{ min: 45, addedL: null },
				{ min: 40, addedL: null },
			],
			lph: null,
			measuredL: null,
		});
	});

	it('only a reading restamps it: never a consumption, never a blank line', () => {
		setOnBoard({ last: { kind: 'full' } });
		vi.setSystemTime(new Date('2026-10-07T07:00:00Z'));
		selectAircraft('F-GKQC');
		setOnBoard({ lph: 27 });
		addOnBoardFlight();
		expect(flightPrep.mb.onBoard).toMatchObject({ aircraft: 'F-GORQ', readOn: '2026-10-06', lph: 27 });
		setOnBoardFlight(1, { min: 30 });
		expect(flightPrep.mb.onBoard).toMatchObject({ aircraft: 'F-GKQC', readOn: '2026-10-07' });
		vi.setSystemTime(new Date('2026-10-08T07:00:00Z'));
		removeOnBoardFlight(0);
		expect(flightPrep.mb.onBoard!.readOn).toBe('2026-10-08');
		expect(flightPrep.mb.onBoard!.flights).toEqual([{ min: 30, addedL: null }]);
		vi.setSystemTime(new Date('2026-10-09T07:00:00Z'));
		setOnBoard({ measuredL: 52 });
		expect(flightPrep.mb.onBoard!.readOn).toBe('2026-10-09');
	});

	it('round-trips through the file shape, the times as the log writes them', () => {
		setOnBoard({ last: { kind: 'litres', litres: 70 } });
		setOnBoardFlight(0, { min: 45 });
		setOnBoardFlight(1, { min: 100, addedL: 15 });
		setOnBoard({ lph: 27, measuredL: 52 });
		setMb({ refuel: false });
		const doc = buildFlightPrepForSave(2, [], []);
		expect(doc!.massBalance!.refuel).toBe(false);
		expect(doc!.massBalance!.onBoard).toEqual({
			aircraft: 'F-GORQ',
			readOn: '2026-10-06',
			lastRefuel: 70,
			flights: [{ time: '00:45' }, { time: '01:40', added: 15 }],
			consumptionLph: 27,
			measuredL: 52,
		});
		const stated = departureFuel();
		applyLoadedFlightPrep(undefined, []);
		expect(flightPrep.mb.onBoard).toBeNull();
		expect(flightPrep.mb.refuel).toBe(true);
		expect(applyLoadedFlightPrep(doc, []).droppedOnBoard).toBeNull();
		expect(departureFuel()).toEqual(stated);
		expect(buildFlightPrepForSave(2, [], [])).toEqual(doc);
		for (const kind of ['full', 'tabs'] as const) {
			setOnBoard({ last: { kind } });
			const back = buildFlightPrepForSave(2, [], []);
			expect(back!.massBalance!.onBoard!.lastRefuel).toBe(kind);
			applyLoadedFlightPrep(back, []);
			expect(flightPrep.mb.onBoard!.last).toEqual({ kind });
		}
	});

	it('writes no blank line, and no reading stating nothing', () => {
		addOnBoardFlight();
		expect(flightPrep.mb.onBoard).not.toBeNull();
		expect(buildFlightPrepForSave(2, [], [])!.massBalance).toBeUndefined();
		setOnBoardFlight(1, { min: 30 });
		expect(buildFlightPrepForSave(2, [], [])!.massBalance!.onBoard!.flights).toEqual([{ time: '00:30' }]);
	});

	it('a no refuel is written alone, and keeps the target for its return', () => {
		setMb({ fuelMode: 'custom', customLitres: 60 });
		setMb({ refuel: false });
		const doc = buildFlightPrepForSave(2, [], []);
		expect(doc!.massBalance).toMatchObject({ fuelMode: 'custom', fuelLitres: 60, refuel: false });
		expect(doc!.massBalance!.onBoard).toBeUndefined();
		applyLoadedFlightPrep(doc, []);
		expect(flightPrep.mb).toMatchObject({ refuel: false, fuelMode: 'custom', customLitres: 60 });
	});

	it('the Activate leaves it out, and the departure is refuelled again', () => {
		setOnBoard({ measuredL: 52 });
		setMb({ refuel: false, fuelMode: 'minimum' });
		const doc = buildFlightPrepForSave(2, [], []);
		const r = applyLoadedFlightPrep(doc, [], { dropOnBoard: true });
		expect(r.droppedOnBoard).toBe('2026-10-06');
		expect(flightPrep.mb.onBoard).toBeNull();
		expect(flightPrep.mb.refuel).toBe(true);
		expect(flightPrep.mb.fuelMode).toBe('minimum');
		// A no refuel with nothing read goes the same way, and is not a reading.
		setMb({ refuel: false });
		const bare = buildFlightPrepForSave(2, [], []);
		expect(applyLoadedFlightPrep(bare, [], { dropOnBoard: true }).droppedOnBoard).toBeNull();
		expect(flightPrep.mb.refuel).toBe(true);
	});

	it('a file reading without its aircraft or its day is no reading', () => {
		applyLoadedFlightPrep({ massBalance: { onBoard: { lastRefuel: 'full', readOn: '2026-10-06' } } }, []);
		expect(flightPrep.mb.onBoard).toBeNull();
		applyLoadedFlightPrep({ massBalance: { onBoard: { aircraft: 'F-GORQ', lastRefuel: 'full' } } }, []);
		expect(flightPrep.mb.onBoard).toBeNull();
		applyLoadedFlightPrep(
			{
				massBalance: {
					onBoard: {
						aircraft: 'F-GORQ',
						readOn: '2026-10-06',
						lastRefuel: -5,
						flights: [{ time: '1:25' }, { time: 'abc', added: -4 }, { time: '45', added: 10 }],
						consumptionLph: 0,
						measuredL: -1,
					},
				},
			},
			[],
		);
		expect(flightPrep.mb.onBoard).toEqual({
			aircraft: 'F-GORQ',
			readOn: '2026-10-06',
			last: null,
			flights: [
				{ min: 85, addedL: null },
				{ min: null, addedL: null },
				{ min: 45, addedL: 10 },
			],
			lph: null,
			measuredL: null,
		});
	});

	it('a cleared workspace forgets the reading and the no refuel', () => {
		setOnBoard({ measuredL: 52 });
		setMb({ refuel: false });
		clearOnBoard();
		expect(flightPrep.mb.onBoard).toBeNull();
		expect(flightPrep.mb.refuel).toBe(true);
	});
});

/** The departure's fuel state as the pages read it. */
function departureFuel(): { refuel: boolean; onBoard: unknown } {
	return { refuel: flightPrep.mb.refuel, onBoard: JSON.parse(JSON.stringify(flightPrep.mb.onBoard)) };
}

describe('the QNH, per phase', () => {
	beforeEach(() => {
		applyLoadedFlightPrep(undefined, []);
	});

	it('loads a file\'s aerodrome QNH into both phases, a phase\'s own over it', () => {
		applyLoadedFlightPrep({ aerodromes: [{ icao: 'LFPL', qnhHpa: 1019, landing: { qnhHpa: 1011 } }] }, ['LFPL']);
		expect(perfFor('LFPL').takeoff.qnhHpa).toBe(1019);
		expect(perfFor('LFPL').landing.qnhHpa).toBe(1011);
	});

	it('writes one QNH typed for both phases as the aerodrome\'s, as every file did', () => {
		setPerfBlock('LFPL', 'takeoff', { qnhHpa: 1019 });
		setPerfBlock('LFPL', 'landing', { qnhHpa: 1019 });
		const ad = buildFlightPrepForSave(1, ['LFPL'], [])?.aerodromes?.[0];
		expect(ad?.qnhHpa).toBe(1019);
		expect(ad?.takeoff?.qnhHpa).toBeUndefined();
		expect(ad?.landing?.qnhHpa).toBeUndefined();
	});

	it('writes two different ones under their phases, and reads them back', () => {
		setPerfBlock('LFPL', 'takeoff', { qnhHpa: 1028 });
		setPerfBlock('LFPL', 'landing', { qnhHpa: 1008 });
		const doc = buildFlightPrepForSave(1, ['LFPL'], []);
		const ad = doc?.aerodromes?.[0];
		expect(ad?.qnhHpa).toBeUndefined();
		expect(ad?.takeoff?.qnhHpa).toBe(1028);
		expect(ad?.landing?.qnhHpa).toBe(1008);
		applyLoadedFlightPrep(undefined, []);
		applyLoadedFlightPrep(doc, ['LFPL']);
		expect(perfFor('LFPL').takeoff.qnhHpa).toBe(1028);
		expect(perfFor('LFPL').landing.qnhHpa).toBe(1008);
	});

	it('writes a QNH typed for one phase under that phase alone', () => {
		setPerfBlock('LFPL', 'landing', { qnhHpa: 1008 });
		const ad = buildFlightPrepForSave(1, ['LFPL'], [])?.aerodromes?.[0];
		expect(ad?.qnhHpa).toBeUndefined();
		expect(ad?.takeoff?.qnhHpa).toBeUndefined();
		expect(ad?.landing?.qnhHpa).toBe(1008);
	});

	it('reads an older store\'s aerodrome QNH into both phases', async () => {
		vi.resetModules();
		const store = new Map<string, string>([
			[
				'loxodrome:flight-prep',
				JSON.stringify({
					v: 1,
					fuel: { trips: [] },
					mb: { loads: {}, fuelMode: 'full', customLitres: null },
					perf: { byIcao: { LFPL: { qnhHpa: 1019, takeoff: { tempC: 20 }, landing: {} } }, manualIcaos: [] },
				}),
			],
		]);
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k),
		});
		try {
			const fresh = await import('../src/lib/state/flightPrep.svelte');
			expect(fresh.perfFor('LFPL').takeoff).toMatchObject({ qnhHpa: 1019, tempC: 20 });
			expect(fresh.perfFor('LFPL').landing.qnhHpa).toBe(1019);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
