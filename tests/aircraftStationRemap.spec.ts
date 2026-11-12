/* A station renamed or taken out in the aircraft editor, and the loads flight
 * preparation stores for it (massBalance.ts stationKeyRemap,
 * flightPrep.svelte.ts remapStationLoads). The loads are keyed by label, '#2'
 * on a label the sheet repeats, so a renamed station used to drop its load
 * (the page said so in a hint), and taking out the first of two same-named
 * stations handed its load to the other. Only an edit read without doubt
 * moves anything: one label changed in place, or one station taken out. */

import { beforeEach, describe, expect, it } from 'vitest';
import { stationKeyRemap } from '$lib/aircraft/massBalance';
import type { MassStation } from '$lib/aircraft/schema';
import {
	applyLoadedFlightPrep,
	flightPrep,
	remapStationLoads,
	setMbLoad,
	setStopLoad,
	setStopRefuel,
} from '$lib/state/flightPrep.svelte';

const st = (label: string, armM = 1): MassStation => ({ label, armM, defaultMassKg: 0 });
const sheet = (...stations: MassStation[]): { stations: MassStation[] } => ({ stations });
const entries = (m: Map<string, string | null> | null): [string, string | null][] | null => (m ? [...m] : null);

describe('which load follows which station', () => {
	it('follows one station renamed in place', () => {
		const before = sheet(st('Front seats'), st('Rear seats'), st('Baggage'));
		const after = sheet(st('Front seats'), st('Rear bench'), st('Baggage'));
		expect(entries(stationKeyRemap(before, after))).toEqual([
			['Front seats', 'Front seats'],
			['Rear seats', 'Rear bench'],
			['Baggage', 'Baggage'],
		]);
	});

	it('moves a repeat’s #2 along when the first of two same-named stations is renamed', () => {
		const before = sheet(st('Rear seat', 2.1), st('Rear seat', 2.2));
		const after = sheet(st('Rear seat left', 2.1), st('Rear seat', 2.2));
		expect(entries(stationKeyRemap(before, after))).toEqual([
			['Rear seat', 'Rear seat left'],
			['Rear seat#2', 'Rear seat'],
		]);
	});

	it('drops the load of a station taken out, the others keeping theirs', () => {
		const before = sheet(st('Front seats'), st('Rear seats'), st('Baggage'));
		const after = sheet(st('Front seats'), st('Baggage'));
		expect(entries(stationKeyRemap(before, after))).toEqual([
			['Front seats', 'Front seats'],
			['Rear seats', null],
			['Baggage', 'Baggage'],
		]);
	});

	it('gives the second of two same-named stations its own load when the first goes', () => {
		const before = sheet(st('Pilot'), st('Rear seat', 2.1), st('Rear seat', 2.4));
		// The one left is the aft one: the arms say which went.
		const after = sheet(st('Pilot'), st('Rear seat', 2.4));
		expect(entries(stationKeyRemap(before, after))).toEqual([
			['Pilot', 'Pilot'],
			['Rear seat', null],
			['Rear seat#2', 'Rear seat'],
		]);
		// The forward one left: nothing moves, the aft one's load goes.
		expect(entries(stationKeyRemap(before, sheet(st('Pilot'), st('Rear seat', 2.1))))).toEqual([
			['Pilot', 'Pilot'],
			['Rear seat', 'Rear seat'],
			['Rear seat#2', null],
		]);
	});

	it('tells two same-named stations apart by that name’s arms alone, never guessing', () => {
		const before = sheet(st('Pilot', 1.0), st('Rear seat', 2.1), st('Rear seat', 2.4));
		// The aft seat out, the pilot's arm corrected in the same save: the
		// forward seat keeps its load.
		expect(entries(stationKeyRemap(before, sheet(st('Pilot', 1.05), st('Rear seat', 2.1))))).toEqual([
			['Pilot', 'Pilot'],
			['Rear seat', 'Rear seat'],
			['Rear seat#2', null],
		]);
		// The seat left re-armed too, or two seats alike: nothing tells which
		// went, so nothing moves.
		expect(stationKeyRemap(before, sheet(st('Pilot', 1.0), st('Rear seat', 2.2)))).toBeNull();
		const twins = sheet(st('Pilot'), st('Rear seat', 2.1), st('Rear seat', 2.1));
		expect(stationKeyRemap(twins, sheet(st('Pilot'), st('Rear seat', 2.1)))).toBeNull();
	});

	it('moves nothing on an edit it cannot read without doubt, nor on one changing no key', () => {
		const before = sheet(st('A'), st('B'), st('C'));
		// Two labels changed at once: renames, or a removal beside an addition.
		expect(stationKeyRemap(before, sheet(st('A'), st('C'), st('D')))).toBeNull();
		expect(stationKeyRemap(before, sheet(st('X'), st('Y'), st('C')))).toBeNull();
		// A station added: no key changes.
		expect(stationKeyRemap(before, sheet(st('A'), st('B'), st('C'), st('D')))).toBeNull();
		// Two taken out at once.
		expect(stationKeyRemap(before, sheet(st('A')))).toBeNull();
		// One taken out and another renamed.
		expect(stationKeyRemap(before, sheet(st('A'), st('Z')))).toBeNull();
		// Arms and masses only.
		expect(stationKeyRemap(before, sheet(st('A', 2), st('B', 3), st('C', 4)))).toBeNull();
	});
});

describe('the loads typed in flight preparation', () => {
	beforeEach(() => {
		applyLoadedFlightPrep(undefined, []);
	});

	it('follow their station at the departure and at each stop', () => {
		setMbLoad('Front seats', 160);
		setMbLoad('Rear seats', 70);
		setMbLoad('Baggage', 12);
		setStopLoad('LFQH', 'Rear seats', 0);
		const before = sheet(st('Front seats'), st('Rear seats'), st('Baggage'));
		remapStationLoads(stationKeyRemap(before, sheet(st('Front seats'), st('Rear bench'), st('Baggage')))!);
		expect(flightPrep.mb.loads).toEqual({ 'Front seats': 160, 'Rear bench': 70, Baggage: 12 });
		expect(flightPrep.mb.stopovers.LFQH.loads).toEqual({ 'Rear bench': 0 });
	});

	it('go with a station taken out, a stop left stating nothing going too', () => {
		setMbLoad('Rear seats', 70);
		setStopLoad('LFQH', 'Rear seats', 0);
		setStopLoad('LFOT', 'Rear seats', 80);
		setStopRefuel('LFOT', true);
		const before = sheet(st('Front seats'), st('Rear seats'), st('Baggage'));
		remapStationLoads(stationKeyRemap(before, sheet(st('Front seats'), st('Baggage')))!);
		expect(flightPrep.mb.loads).toEqual({});
		expect(flightPrep.mb.stopovers.LFQH).toBeUndefined();
		expect(flightPrep.mb.stopovers.LFOT.loads).toEqual({});
		expect(flightPrep.mb.stopovers.LFOT.refuel).toBe(true);
	});

	it('leave a load under no station of the sheet where it is, and never hand it to a station renamed onto it', () => {
		setMbLoad('Front seats', 160);
		setMbLoad('Rear bench', 55); // left by an older rename
		setMbLoad('Cargo', 30); // left by an older removal
		const before = sheet(st('Front seats'), st('Rear seats'));
		remapStationLoads(stationKeyRemap(before, sheet(st('Front seats'), st('Rear bench')))!);
		// The renamed station had no load: it keeps its default, not the 55.
		expect(flightPrep.mb.loads).toEqual({ 'Front seats': 160, Cargo: 30 });
	});
});
