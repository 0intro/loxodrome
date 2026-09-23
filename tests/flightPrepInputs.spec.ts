/* Pins the rule the flight-preparation bridge decides in both directions: an
 * input the pilot never typed is AUTOMATIC, and automatic states nothing. The
 * fuel plan's five per-trip minutes and the overview's ground stops all hold
 * null for it, so the page can show the value in force as a placeholder and the
 * pilot's own minutes as a typed value; the file and localStorage then carry
 * the same distinction, since a stored 10 would come back as a decision nobody
 * made. The defaults themselves live in aircraft/fuel.ts, which is where they
 * are applied. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
	applyLoadedFlightPrep,
	buildFlightPrepForSave,
	defaultTripFuel,
	dossierStopEffectiveMin,
	dossierStopMin,
	setDossierStop,
	setTripFuel,
	tripFuel,
} from '../src/lib/state/flightPrep.svelte';

describe('the automatic / stated distinction', () => {
	beforeEach(() => {
		// A fresh plan: two trips, nothing typed.
		applyLoadedFlightPrep(undefined, []);
	});

	it('starts every fuel minute and every stop automatic', () => {
		expect(defaultTripFuel()).toEqual({
			taxiMin: null,
			procedureMin: null,
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
		expect(buildFlightPrepForSave(2, [])).toBeUndefined();
	});

	it('writes only what the pilot stated', () => {
		setTripFuel(1, { taxiMin: 5 });
		const doc = buildFlightPrepForSave(2, []);
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

	it('drops a trailing automatic trip rather than stating it', () => {
		setTripFuel(0, { procedureMin: 15 });
		expect(buildFlightPrepForSave(3, [])!.fuelTrips).toHaveLength(1);
	});

	it('brings a stated minute back as stated and an absent one as automatic', () => {
		applyLoadedFlightPrep({ fuelTrips: [{ taxiMin: 5, finalReserveMin: 45 }] }, []);
		expect(tripFuel(0)).toEqual({
			taxiMin: 5,
			procedureMin: null,
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
		const doc = buildFlightPrepForSave(2, []);
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
		expect(buildFlightPrepForSave(2, [])).toBeUndefined();
	});
});
