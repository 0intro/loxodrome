/* The Aircraft tab card's inline edits (state/aircraft.svelte.ts
 * updateAircraft). The card stored and synced the mutated sheet unchecked,
 * and a stored sheet the schema refuses is dropped at the next boot
 * (initialUser): a tank capacity typed on a copy of the DR400/180, whose
 * wing tanks must hold the fuel section's litres, or F-GIEQ's usable fuel
 * lowered under its 128 L tabs preset, lost the whole plane or every edit of
 * its shadow. The edit is now checked as the editor's save is, and refused
 * with the schema's reason, the sheet and its stored copy as they were. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAircraftYaml, type Aircraft } from '$lib/aircraft/schema';
import { memoryStorage } from './helpers/storage';

// A client spec: the server compile's $state.snapshot hands back the object
// itself, so an edit there would land in the library sheet in place.
const sheet = (p: string): Aircraft =>
	parseAircraftYaml(readFileSync(join(process.cwd(), 'public/data/aircraft', p), 'utf8'));

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', memoryStorage());
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function load() {
	const m = await import('$lib/state/aircraft.svelte');
	m.aircraftState.library = [sheet('f-gieq.yaml')];
	m.aircraftState.libraryLoaded = true;
	m.aircraftState.user = {};
	m.aircraftState.selectedKey = null;
	return m;
}

/** The pilot's planes as the next boot reads them. */
function stored(): Record<string, string> {
	const raw = localStorage.getItem('loxodrome:aircraft-user');
	return raw === null ? {} : (JSON.parse(raw) as { planes: Record<string, string> }).planes;
}

describe('the card’s inline edits', () => {
	it('refuse a tank capacity the tanks do not hold, the copy kept as it was', async () => {
		const m = await load();
		const generic = sheet('generic/dr400-180-sn2216.yaml');
		const key = m.addUserAircraft({ ...generic, identity: { ...generic.identity, registration: 'F-HABC' } });
		const before = stored()[key];
		const err = m.updateAircraft(key, (x) => {
			x.fuel!.capacityL = 240;
		});
		expect(err?.()).toMatch(/fuelTanks hold 190 L \(capacityL\) where fuel\.capacityL is 240/);
		expect(m.aircraftState.user[key].fuel?.capacityL).toBe(190);
		expect(stored()[key]).toBe(before);
		expect(parseAircraftYaml(stored()[key]).fuel?.capacityL).toBe(190);
	});

	it('refuse a usable fuel under the tabs preset, no shadow born', async () => {
		const m = await load();
		const err = m.updateAircraft('F-GIEQ', (x) => {
			x.fuel!.usableL = 100;
		});
		expect(err?.()).toMatch(/fuel\.presets\[0\]\.litres must be <= fuel\.usableL/);
		expect(m.aircraftState.user['F-GIEQ']).toBeUndefined();
		expect(stored()['F-GIEQ']).toBeUndefined();
	});

	it('still take an edit the sheet holds', async () => {
		const m = await load();
		expect(
			m.updateAircraft('F-GIEQ', (x) => {
				x.fuel!.usableL = 150;
			}),
		).toBeNull();
		expect(m.aircraftState.user['F-GIEQ'].fuel?.usableL).toBe(150);
		expect(parseAircraftYaml(stored()['F-GIEQ']).fuel?.usableL).toBe(150);
	});
});
