/* The importer primes the link cache with the verdict it just computed, and
 * a verdict is stored only under the data it was reached with: the airports
 * landing mid-import (their scheduled retry, during a long batch or while
 * the datum question is open) stored the "no match" the import had reached
 * without them under the key the landed data gives, and every later pass
 * served it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AIRPORT_HEADER, airport, runway, failAlways, serve, serveCoverageSite } from './helpers/coverageSite';

vi.mock('$lib/state/openFile.svelte', () => ({
	askTraceDatum: (): Promise<'msl'> => Promise.resolve('msl'),
}));

const LFPL = { lat: 48.7233, lon: 2.6589 };
const LFPN = { lat: 48.7519, lon: 2.1061 };
const PLAN = ['version: 1', 'routes:', '  - waypoints:', '      - ident: LFPL', '      - ident: LFPN', ''].join('\n');
const T0 = Date.UTC(2026, 6, 7, 9, 30);

function gpx(): string {
	const pts: string[] = [];
	let t = T0;
	const push = (lat: number, lon: number, eleFt: number, kt: number): void => {
		pts.push(
			`<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${(eleFt * 0.3048).toFixed(1)}</ele><time>${new Date(t).toISOString()}</time><speed>${(kt * 0.514444).toFixed(2)}</speed></trkpt>`,
		);
		t += 1000;
	};
	for (let i = 0; i < 90; i++) push(LFPL.lat, LFPL.lon, 300, 3);
	const n = 880;
	for (let i = 0; i <= n; i++) {
		const f = i / n;
		push(LFPL.lat + (LFPN.lat - LFPL.lat) * f, LFPL.lon + (LFPN.lon - LFPL.lon) * f, i < 30 || i > n - 30 ? 300 : 1500, 90);
	}
	for (let i = 0; i < 120; i++) push(LFPN.lat, LFPN.lon, 300, 0);
	return `<?xml version="1.0"?><gpx version="1.1" creator="x"><trk><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
}

let store: Map<string, string>;
beforeEach(() => {
	store = new Map<string, string>();
	globalThis.indexedDB = new IDBFactory();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	vi.stubGlobal('location', { search: '' });
	vi.resetModules();
	serveCoverageSite();
	serve('/data/airports.json', {
		...AIRPORT_HEADER,
		rows: [airport('LFPL', LFPL.lat, LFPL.lon, [runway('08', '26')]), airport('LFPN', LFPN.lat, LFPN.lon, [runway('07', '25')])],
	});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
	(await import('$lib/state/dataRetry.svelte')).resetDataRetryForTest();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('a link primed by the importer', () => {
	it('control: with the airports there, the import links the trace to the stored plan', async () => {
		const db = await import('$lib/state/flightsDb');
		await db.putStoredPlan({ id: 'p1', yaml: PLAN, savedAtMs: 1 });
		const { runImportTexts } = await import('$lib/state/flightImport.svelte');
		const fl = await import('$lib/state/flightLinks.svelte');
		await runImportTexts([{ name: 'flight.gpx', text: gpx() }]);
		await vi.waitFor(() => expect(fl.flightLinks.computing).toBe(false));
		const links = await db.getStoredLinks();
		expect(links.map((l) => l.planId)).toEqual(['p1']);
	});

	it('stores no verdict matched before the airports landed mid-import, and the next pass links it', async () => {
		const db = await import('$lib/state/flightsDb');
		await db.putStoredPlan({ id: 'p1', yaml: PLAN, savedAtMs: 1 });
		const recover = failAlways('/data/airports.json', 503);
		const retry = await import('$lib/state/dataRetry.svelte');
		const lib = await import('$lib/state/flightLibrary.svelte');
		const real = lib.archiveOuting;
		// The airports' scheduled retry lands while the import files the
		// trace (a big batch takes longer than the 5 s wait).
		vi.spyOn(lib, 'archiveOuting').mockImplementation(async (...a: Parameters<typeof real>) => {
			recover();
			await retry.retryDataNow();
			return real(...a);
		});
		const { runImportTexts } = await import('$lib/state/flightImport.svelte');
		const data = await import('$lib/state/data.svelte');
		await runImportTexts([{ name: 'flight.gpx', text: gpx() }]);
		expect(data.dataState.airportsLoaded).toBe(true);
		expect(await db.getStoredLinks()).toEqual([]);
		// The next pass folds it against the airports that landed (the
		// import started one; a call arriving mid-pass only asks for another).
		const fl = await import('$lib/state/flightLinks.svelte');
		await fl.ensureLinks();
		await vi.waitFor(() => expect(fl.flightLinks.computing).toBe(false));
		expect(Object.values(fl.flightLinks.byOuting).map((l) => l.planId)).toEqual(['p1']);
		expect((await db.getStoredLinks()).map((l) => l.planId)).toEqual(['p1']);
	});
});
