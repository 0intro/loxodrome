/* An aircraft sheet imported over the pilot's own (state/aircraft.svelte.ts
 * importOverwrites, state/openFile.svelte.ts importAircraftSheet). An import
 * replaces by key, by design, and used to do it in silence, so a file
 * exported before an evening's work in the editor destroyed that work. It
 * now asks first, and only then: a new plane, a sheet identical to theirs
 * and a library plane they never changed (its Revert brings it back) import
 * at once. The question stands in FileOpenHost, the dispatcher's and the
 * Aircraft tab's picker's alike; the tab's half is pinned at the source,
 * since the node project renders no component to click through. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAircraftYaml, stringifyAircraftYaml } from '$lib/aircraft/schema';
import { memoryStorage } from './helpers/storage';

// The dispatcher reaches Leaflet through the map fit; nothing here draws.
vi.mock('leaflet', () => ({ default: {} }));

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const LIBRARY = `version: 1
aircraft: { registration: F-GORQ, type: DR400/120 }
cruise: { speedKt: 100 }
`;
const EXPORTED = LIBRARY.replace('speedKt: 100', 'speedKt: 105');
const EDITED = LIBRARY.replace('speedKt: 100', 'speedKt: 98');

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
	const aircraft = await import('$lib/state/aircraft.svelte');
	const open = await import('$lib/state/openFile.svelte');
	aircraft.aircraftState.library = [parseAircraftYaml(LIBRARY)];
	aircraft.aircraftState.libraryLoaded = true;
	aircraft.aircraftState.user = {};
	aircraft.aircraftState.selectedKey = null;
	return { ...aircraft, ...open };
}

const speed = (m: Awaited<ReturnType<typeof load>>): number | undefined =>
	m.aircraftByKey('F-GORQ')?.cruise?.speedKt;

describe('an aircraft sheet imported over the pilot’s own', () => {
	it('loses nothing, so asks nothing, for a new plane, an identical sheet or an unchanged library plane', async () => {
		const m = await load();
		expect(m.importOverwrites(parseAircraftYaml(EXPORTED))).toBeNull();
		m.aircraftState.user = { 'F-GORQ': parseAircraftYaml(EDITED) };
		expect(m.importOverwrites(parseAircraftYaml(EDITED))).toBeNull();
		expect(m.importOverwrites(parseAircraftYaml('version: 1\naircraft: { registration: F-HXYZ, type: TB10 }\n'))).toBeNull();
	});

	it('asks before replacing the pilot’s sheet holding other figures, and replaces once answered', { timeout: 30_000 }, async () => {
		const m = await load();
		m.aircraftState.user = { 'F-GORQ': parseAircraftYaml(EDITED) };
		await m.openIncomingFile('f-gorq.yaml', EXPORTED);
		expect(m.openFile.pendingAircraft?.key).toBe('F-GORQ');
		expect(speed(m)).toBe(98);
		m.applyPendingAircraft();
		expect(m.openFile.pendingAircraft).toBeNull();
		expect(speed(m)).toBe(105);
		expect(m.aircraftState.selectedKey).toBe('F-GORQ');
	});

	it('keeps the pilot’s sheet when the question is declined', { timeout: 30_000 }, async () => {
		const m = await load();
		m.aircraftState.user = { 'F-GORQ': parseAircraftYaml(EDITED) };
		m.importAircraftSheet(parseAircraftYaml(EXPORTED));
		m.dismissPendingAircraft();
		expect(m.openFile.pendingAircraft).toBeNull();
		expect(stringifyAircraftYaml(m.aircraftByKey('F-GORQ')!)).toBe(stringifyAircraftYaml(parseAircraftYaml(EDITED)));
	});

	it('imports at once where nothing is lost', { timeout: 30_000 }, async () => {
		const m = await load();
		m.importAircraftSheet(parseAircraftYaml(EXPORTED));
		expect(m.openFile.pendingAircraft).toBeNull();
		expect(speed(m)).toBe(105);
	});

	it('asks the same way from the Aircraft tab’s own picker', () => {
		const tab = read('src/lib/components/tabs/AircraftTab.svelte');
		expect(tab).toContain('importAircraftSheet(parseAircraftYaml(');
		expect(tab).not.toMatch(/importUserAircraft\(/);
	});
});
