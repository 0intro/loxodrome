/* Reset application (state/reset.ts): the destructive sibling of Restore
 * default settings. Each stored key goes with the group its class in
 * state/storageKeys.ts names: briefing and aircraft with their own
 * checkboxes, every other key, one nobody registered included, with the
 * settings group, so clearing stays the default. The settings group also
 * takes the layers out of the URL before the reload, since a present #map=
 * wins over the stored seed at boot and would put the erased base map and
 * chart stack straight back. On a shared session the settings group ENDS
 * it, at the device's defaults whichever groups are kept (what its sign-in
 * found going back as found), and never under a recording. The flights
 * library, the sync layer and the native recorder are outside the key sweep
 * and mocked here. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage, type MemoryStorage } from './helpers/storage';
import { KEEP_SEEDS, PREF_SEEDS } from './helpers/prefSeeds';
import { storageClassOf } from '$lib/state/storageKeys';
import { viewHashWithoutLayers } from '$lib/map/viewHash';

const lib = vi.hoisted(() => ({
	wipeFlights: vi.fn(() => Promise.resolve()),
	archiveCurrentOuting: vi.fn(() => Promise.resolve()),
	haltSync: vi.fn(() => Promise.resolve()),
	stopNativeRecorder: vi.fn(() => Promise.resolve()),
	clearNativeJournal: vi.fn(() => Promise.resolve()),
	wipeSessionIdb: vi.fn(
		(_end: { reg: { docs: Record<string, unknown> }; owed: boolean }, _untilMs: number) =>
			Promise.resolve(),
	),
	stampOwed: vi.fn(() => false),
	recordingRefusal: vi.fn((): Promise<'recording' | 'recording-elsewhere' | null> => Promise.resolve(null)),
}));

vi.mock('$lib/state/sync.svelte', () => ({
	haltSync: lib.haltSync,
	stampOwed: lib.stampOwed,
	recordingRefusal: lib.recordingRefusal,
}));
vi.mock('$lib/sync/wipe', async (original) => ({
	...(await original<typeof import('$lib/sync/wipe')>()),
	wipeSessionIdb: lib.wipeSessionIdb,
}));
vi.mock('$lib/state/flightLibrary.svelte', async (original) => ({
	...(await original<typeof import('$lib/state/flightLibrary.svelte')>()),
	wipeFlights: lib.wipeFlights,
	archiveCurrentOuting: lib.archiveCurrentOuting,
}));
vi.mock('$lib/native/navRecorder', () => ({
	startNativeRecorder: vi.fn(() => Promise.resolve('ok')),
	stopNativeRecorder: lib.stopNativeRecorder,
	drainNativeAfter: vi.fn(() => Promise.resolve([])),
	getNativeRecorderState: vi.fn(() => Promise.resolve(null)),
	clearNativeJournal: lib.clearNativeJournal,
	setNativeAutoStop: vi.fn(() => Promise.resolve()),
	watchNativeFixes: vi.fn(() => Promise.resolve()),
	watchNativeStopped: vi.fn(() => Promise.resolve()),
	nativeBatteryStatus: vi.fn(() => Promise.resolve(null)),
	nativeOpenBatterySettings: vi.fn(() => Promise.resolve()),
}));

const HASH = '#map=6/48.00000/2.00000&layer=ign&charts=fr500';

let ls: MemoryStorage;
let replaceState: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.resetModules();
	for (const f of Object.values(lib)) {
		f.mockClear();
	}
	ls = memoryStorage({ ...PREF_SEEDS, ...KEEP_SEEDS, 'loxodrome:zzz': 'nobody registers me' });
	// The seeds hold one key of every class, the shared flag among them; a
	// device in a shared session is what seedAccount makes.
	ls.removeItem('loxodrome:shared-session');
	vi.stubGlobal('localStorage', ls);
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))),
	);
	reload = vi.fn();
	replaceState = vi.fn();
	vi.stubGlobal('location', { pathname: '/', search: '', hash: HASH, reload });
	vi.stubGlobal('history', { state: null, replaceState });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

type Group = 'briefing' | 'aircraft' | 'settings';

function groupOf(key: string): Group {
	const cls = storageClassOf(key);
	return cls === 'briefing' || cls === 'aircraft' ? cls : 'settings';
}

/** Reset with the given groups ticked, returning what was stored before it
 *  (the modules' own boot migrations done) and after it. */
async function reset(groups: Partial<Record<Group | 'flights', boolean>>) {
	const { resetApplication } = await import('$lib/state/reset');
	const before = ls.dump();
	await resetApplication({
		settings: groups.settings ?? false,
		briefing: groups.briefing ?? false,
		aircraft: groups.aircraft ?? false,
		flights: groups.flights ?? false,
	});
	return { before, after: ls.dump() };
}

/** A signed-in account whose registry lists a plan, an outing, one of the two
 *  planes stored, the tanked grades and the pilot block. */
async function seedAccount() {
	const reg = {
		v: 1,
		deviceId: 'd',
		lastSeq: 3,
		docs: {
			'plans/p1': { rev: 1, hash: 'h' },
			'outings/7': { rev: 1, hash: 'h' },
			'aircraft/F-OURS': { rev: 1, hash: 'h' },
			'acstate/tanked-fuel': { rev: 1, hash: 'h' },
			'pilot/pilot': { rev: 1, hash: 'h' },
		},
		tombstones: [],
		// The anonymous plane was on the device at the sign-in (the stamp);
		// F-MINE was added in the session and never synced.
		preexisting: ['aircraft/F-LEFT'],
	};
	ls.setItem('loxodrome:sync', JSON.stringify(reg));
	ls.setItem(
		'loxodrome:aircraft-user',
		JSON.stringify({ v: 1, planes: { 'F-OURS': {}, 'F-LEFT': {}, 'F-MINE': {} } }),
	);
	ls.setItem('loxodrome:shared-session', '1');
	return Promise.resolve(reg);
}

/** What a reset of these groups must leave: every key of the others. */
function kept(before: Record<string, string>, erased: Group[]): Record<string, string> {
	return Object.fromEntries(Object.entries(before).filter(([k]) => !erased.includes(groupOf(k))));
}

describe('Reset application', () => {
	it('erases the settings group, an unregistered key included, and keeps the rest', { timeout: 30_000 }, async () => {
		const { before, after } = await reset({ settings: true });
		expect(after).toEqual(kept(before, ['settings']));
		expect(after['loxodrome:zzz']).toBeUndefined();
		expect(after['loxodrome:routes']).toBe(before['loxodrome:routes']);
		expect(after['loxodrome:aircraft-user']).toBe(before['loxodrome:aircraft-user']);
		// The view stays in the address, its layers go.
		expect(replaceState).toHaveBeenCalledOnce();
		expect(replaceState.mock.calls[0]?.[2]).toBe(`/${viewHashWithoutLayers(HASH)}`);
		expect(viewHashWithoutLayers(HASH)).toBe('#map=6/48.00000/2.00000');
		expect(reload).toHaveBeenCalledOnce();
		expect(lib.haltSync).toHaveBeenCalledOnce();
		expect(lib.wipeFlights).not.toHaveBeenCalled();
		// Sealed before the reload: a write the page still makes (PersistHost's
		// layers effect, re-run by the reset of the choices) lands nowhere.
		const { persistLayers, layers } = await import('$lib/state/layers.svelte');
		layers.baseLayer = 'ign';
		persistLayers();
		expect(ls.dump()).toEqual(after);
	});

	it('erases the briefing group alone, and leaves the address as it is', { timeout: 30_000 }, async () => {
		const { before, after } = await reset({ briefing: true });
		expect(after).toEqual(kept(before, ['briefing']));
		expect(after['loxodrome:routes']).toBeUndefined();
		expect(after['loxodrome:layers']).toBe(before['loxodrome:layers']);
		expect(replaceState).not.toHaveBeenCalled();
		// The native journal would bring the erased trace back at next boot.
		expect(lib.stopNativeRecorder).toHaveBeenCalledOnce();
		expect(lib.clearNativeJournal).toHaveBeenCalledOnce();
		expect(reload).toHaveBeenCalledOnce();
	});

	it('erases the aircraft group alone', { timeout: 30_000 }, async () => {
		const { before, after } = await reset({ aircraft: true });
		expect(after).toEqual(kept(before, ['aircraft']));
		expect(after['loxodrome:pilot']).toBeUndefined();
		expect(after['loxodrome:theme']).toBe(before['loxodrome:theme']);
	});

	it("ends a shared session's account data with the settings group, whatever is kept", { timeout: 30_000 }, async () => {
		const account = await seedAccount();
		const { after } = await reset({ settings: true });
		// The registry's plans and outings from IndexedDB with what the
		// session made, its plane, grades and pilot block entry by entry, and
		// the plane it added and never synced; the anonymous plane stays.
		expect(lib.wipeSessionIdb).toHaveBeenCalledOnce();
		expect(Object.keys(lib.wipeSessionIdb.mock.calls[0]?.[0].reg.docs ?? {})).toEqual(
			Object.keys(account.docs),
		);
		expect(lib.wipeSessionIdb.mock.calls[0]?.[0].owed).toBe(false);
		expect(JSON.parse(after['loxodrome:aircraft-user'] ?? '{}')).toEqual({ v: 1, planes: { 'F-LEFT': {} } });
		expect(after['loxodrome:pilot']).toBeUndefined();
		expect(after['loxodrome:aircraft-fuel']).toBeUndefined();
		// The session ends at the device's defaults whichever groups are kept:
		// its workspace, its trace and its preparation inputs go with it.
		expect(after['loxodrome:routes']).toBeUndefined();
		expect(after['loxodrome:nav-trace']).toBeUndefined();
		expect(after['loxodrome:flight-prep']).toBeUndefined();
		expect(after['loxodrome:shared-session']).toBeUndefined();
	});

	it("keeps the device's own flight a shared session's sign-in found, the briefing kept", { timeout: 30_000 }, async () => {
		await seedAccount();
		const crash = JSON.stringify({ v: 1, recording: false, points: [{ lat: 48, lon: 2, timeMs: 5_000 }] });
		ls.setItem('loxodrome:nav-trace', crash);
		ls.setItem(
			'loxodrome:sync-found',
			JSON.stringify({ v: 1, userId: 'u', keys: ['outings/5000'], pilot: null, fuel: null, parked: false, planes: {}, trace: 5_000, listed: true, rows: false }),
		);
		const { after } = await reset({ settings: true });
		expect(after['loxodrome:nav-trace']).toBe(crash);
		// Ticked, the briefing group erases the device's own as well.
		ls.setItem('loxodrome:shared-session', '1');
		const ticked = await reset({ settings: true, briefing: true });
		expect(ticked.after['loxodrome:nav-trace']).toBeUndefined();
	});

	it('ends no shared session under a recording, in this tab or another', { timeout: 30_000 }, async () => {
		await seedAccount();
		lib.recordingRefusal.mockResolvedValueOnce('recording-elsewhere');
		const { resetApplication } = await import('$lib/state/reset');
		const before = ls.dump();
		expect(await resetApplication({ settings: true, briefing: true, aircraft: true, flights: true })).toBe(
			'recording-elsewhere',
		);
		expect(ls.dump()).toEqual(before);
		expect(lib.wipeSessionIdb).not.toHaveBeenCalled();
		expect(lib.wipeFlights).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
		// A reset that ends no session is not held, nor asked: the briefing alone.
		await resetApplication({ settings: false, briefing: true, aircraft: false, flights: false });
		expect(lib.recordingRefusal).toHaveBeenCalledOnce();
		expect(reload).toHaveBeenCalled();
	});

	it('keeps what it cannot tell apart while the sign-in stamp is owed', { timeout: 30_000 }, async () => {
		await seedAccount();
		lib.stampOwed.mockReturnValue(true);
		const { after } = await reset({ settings: true });
		expect(lib.wipeSessionIdb.mock.calls[0]?.[0].owed).toBe(true);
		expect(JSON.parse(after['loxodrome:aircraft-user'] ?? '{}')).toEqual({
			v: 1,
			planes: { 'F-LEFT': {}, 'F-MINE': {} },
		});
		lib.stampOwed.mockReturnValue(false);
	});

	it("puts back what a shared session's sign-in found, whatever groups are kept", { timeout: 30_000 }, async () => {
		await seedAccount();
		// The club's F-LEFT was found and typed over in the session.
		ls.setItem(
			'loxodrome:sync-found',
			JSON.stringify({
				v: 1,
				userId: 'u',
				keys: ['aircraft/F-LEFT'],
				pilot: null,
				fuel: null,
				parked: false,
				planes: { 'F-LEFT': { sheet: 'orig' } },
				trace: null,
				rows: false,
			}),
		);
		ls.setItem(
			'loxodrome:aircraft-user',
			JSON.stringify({ v: 1, planes: { 'F-OURS': {}, 'F-LEFT': { sheet: 'edited' }, 'F-MINE': {} } }),
		);
		const { after } = await reset({ settings: true });
		expect(lib.wipeSessionIdb.mock.calls[0]?.[0]).toMatchObject({ found: { keys: ['aircraft/F-LEFT'] } });
		expect(JSON.parse(after['loxodrome:aircraft-user'] ?? '{}')).toEqual({
			v: 1,
			planes: { 'F-LEFT': { sheet: 'orig' } },
		});
		expect(after['loxodrome:sync-found']).toBeUndefined();
	});

	it("leaves a personal session's data to the groups ticked", { timeout: 30_000 }, async () => {
		await seedAccount();
		ls.removeItem('loxodrome:shared-session');
		const { before, after } = await reset({ settings: true });
		expect(lib.wipeSessionIdb).not.toHaveBeenCalled();
		// No session ends, so no recording holds it back.
		expect(lib.recordingRefusal).not.toHaveBeenCalled();
		expect(after['loxodrome:aircraft-user']).toBe(before['loxodrome:aircraft-user']);
		expect(after['loxodrome:pilot']).toBe(before['loxodrome:pilot']);
	});

	it('stops a kept trace claiming a row the flights wipe took', { timeout: 30_000 }, async () => {
		const t = Date.now() - 3_600_000;
		const points = [
			{ lat: 48, lon: 2, timeMs: t, altFt: 400, speedKt: 4 },
			{ lat: 48, lon: 2.001, timeMs: t + 1000, altFt: 400, speedKt: 4 },
		];
		ls.setItem(
			'loxodrome:nav-trace',
			JSON.stringify({ v: 1, altDatum: 'msl', recording: false, origin: 'recording', filed: [t, t + 1000], points }),
		);
		const { after } = await reset({ flights: true });
		const kept = JSON.parse(after['loxodrome:nav-trace'] ?? '{}') as Record<string, unknown>;
		expect(kept.points).toHaveLength(2);
		expect('filed' in kept).toBe(false);
	});

	it('waits for the flights library before it reloads', { timeout: 30_000 }, async () => {
		await reset({ flights: true });
		expect(lib.wipeFlights).toHaveBeenCalledOnce();
		expect(lib.wipeFlights.mock.invocationCallOrder[0]).toBeLessThan(
			reload.mock.invocationCallOrder[0] ?? 0,
		);
	});
});
