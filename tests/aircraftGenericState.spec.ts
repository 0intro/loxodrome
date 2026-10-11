/* Generic library sheets in the fleet state (src/lib/state/aircraft.svelte.ts):
 * keyed apart, a pilot's registration-less plane of the same type is never
 * captured as a shadow; the flag is library-only (an import, a synced copy
 * and an editor save drop it); a generic sheet is read-only; and an export
 * never writes its "generic:" key as a registration. */

import { describe, it, expect, beforeEach } from 'vitest';
import { parseAircraftYaml, stringifyAircraftYaml, aircraftKey, type Aircraft } from '$lib/aircraft/schema';
import {
	aircraftState,
	fleet,
	importUserAircraft,
	applyRemoteAircraft,
	saveEditedAircraft,
	updateAircraft,
	isGenericKey,
	isShadowed,
	isUserOnly,
	exportRegistration,
	automaticCruiseFrom,
	selectAircraft,
} from '$lib/state/aircraft.svelte';

const GENERIC = `version: 1
aircraft: { type: C172S, icaoType: C172, name: 'Cessna 172S, s/n 172S8001 and on', generic: c172s }
cruise: { speedKt: 124 }
`;
const generic = parseAircraftYaml(GENERIC);
const club = parseAircraftYaml('version: 1\naircraft: { registration: F-GORQ, type: DR400/120 }\n');
const own = (yaml: string): Aircraft => parseAircraftYaml(yaml);

beforeEach(() => {
	aircraftState.library = [club, generic];
	aircraftState.libraryLoaded = true;
	aircraftState.user = {};
	aircraftState.selectedKey = null;
});

describe('generic sheets in the fleet', () => {
	it('a pilot plane typed C172S without a registration stays the pilot’s own', () => {
		aircraftState.user = { C172S: own('version: 1\naircraft: { type: C172S, name: Mine }\n') };
		const keys = fleet().map(aircraftKey);
		expect(keys).toEqual(['F-GORQ', 'generic:c172s', 'C172S']);
		expect(isUserOnly('C172S')).toBe(true);
		expect(isShadowed('generic:c172s')).toBe(false);
		expect(isGenericKey('generic:c172s')).toBe(true);
		expect(isGenericKey('C172S')).toBe(false);
	});

	it('an imported generic sheet becomes the pilot’s plane, flag dropped', () => {
		const key = importUserAircraft(parseAircraftYaml(GENERIC));
		expect(key).toBe('C172S');
		expect(aircraftState.user['C172S'].identity.generic).toBeUndefined();
		expect(aircraftState.user['generic:c172s']).toBeUndefined();
		expect(isUserOnly('C172S')).toBe(true);
	});

	it('a synced copy and an editor save drop the flag too', () => {
		expect(applyRemoteAircraft(stringifyAircraftYaml(generic))).toBe('C172S');
		expect(aircraftState.user['C172S'].identity.generic).toBeUndefined();
		aircraftState.user = {};
		// An editor result still flagged (a pasted generic YAML) saves as the
		// pilot's plane: the schema refuses a registration beside the flag, so
		// the object is built past it, as a caller could.
		const flagged: Aircraft = { ...generic, identity: { ...generic.identity, registration: 'F-HABC' } };
		expect(saveEditedAircraft(null, flagged)).toBeNull();
		expect(aircraftState.user['F-HABC'].identity.generic).toBeUndefined();
		expect(aircraftState.selectedKey).toBe('F-HABC');
	});

	it('a generic sheet is read-only', () => {
		updateAircraft('generic:c172s', (x) => {
			x.cruise!.speedKt = 99;
		});
		expect(aircraftState.user).toEqual({});
		expect(fleet().find((a) => aircraftKey(a) === 'generic:c172s')?.cruise?.speedKt).toBe(124);
	});

	it('an export writes no registration for a generic sheet, gone or not', () => {
		expect(exportRegistration('generic:c172s')).toBe('');
		expect(exportRegistration('generic:retired-sheet')).toBe('');
		expect(exportRegistration('F-GORQ')).toBe('F-GORQ');
		aircraftState.user = { C172S: own('version: 1\naircraft: { type: C172S }\n') };
		expect(exportRegistration('C172S')).toBe('C172S');
		expect(exportRegistration(null)).toBe('');
	});

	it('the Route tab names a generic sheet by its type, never its key', () => {
		selectAircraft('generic:c172s');
		expect(automaticCruiseFrom()).toBe('C172S');
		selectAircraft('F-GORQ');
		expect(automaticCruiseFrom()).toBeNull(); // no cruise block: the default speed
	});
});
