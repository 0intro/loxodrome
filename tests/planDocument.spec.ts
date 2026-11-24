/* The flight plan as a document (state/planDocument.svelte.ts): Save writes
 * over the entry the plan was opened from, or a new entry for a plan never
 * saved, and replacing the plan on screen asks first, only while it holds
 * unsaved work (docs/flights-library.md, "The plan-editing loop").
 *
 * Each case builds a fresh module graph over a fresh fake IndexedDB (the
 * tests/planStore.spec.ts harness). The rich build's nav-log snapshot
 * wants the datasets and the winds, which this environment has no network
 * for: the lean routes stand in. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { memoryStorage } from './helpers/storage';

// The file dispatcher reaches Leaflet through the map fit; nothing here draws.
vi.mock('leaflet', () => ({ default: {} }));

/** One two-leg route of FREE points, so no dataset has to resolve anything. */
const PLAN = [
	'version: 1',
	'routes:',
	'  - waypoints:',
	'      - name: ALPHA',
	'        lat: 48.5',
	'        lon: 2.5',
	'      - name: BRAVO',
	'        lat: 49',
	'        lon: 3',
	'',
].join('\n');

/** Another plan, which a replacement brings in. */
const OTHER = PLAN.replace('ALPHA', 'CHARLIE').replace('lat: 48.5', 'lat: 47.5');

/** PLAN plus an ident nothing resolves here: dropped on load, a lossy copy. */
const PLAN_WITH_IDENT = `${PLAN}      - ident: LFPL\n`;

/** A plan carrying what New must put back: its name, its own settings, a
 *  contingency, a stop's refuel and the fuel on board. */
const RICH = [
	'version: 1',
	'name: Nav examen',
	'settings:',
	'  vfr: false',
	'  transition_altitude: 6000',
	'  cruise_speed: 115',
	'  wind_dir: 270',
	'  wind_speed: 15',
	'  wind_forecast: false',
	'routes:',
	'  - waypoints:',
	'      - name: ALPHA',
	'        lat: 48.5',
	'        lon: 2.5',
	'      - name: BRAVO',
	'        lat: 49',
	'        lon: 3',
	'  - waypoints:',
	'      - name: BRAVO',
	'        lat: 49',
	'        lon: 3',
	'      - name: CHARLIE',
	'        lat: 49.5',
	'        lon: 3.5',
	'flight_prep:',
	'  fuel:',
	'    trips:',
	'      - contingency: 10',
	'  mass_balance:',
	'    fuel_mode: minimum',
	'    stopovers:',
	"      '49.0000,3.0000': { fuel_mode: full }",
	'',
].join('\n');

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	vi.stubGlobal('localStorage', memoryStorage());
	vi.stubGlobal('location', { search: '' });
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))),
	);
	vi.resetModules();
	vi.doMock('$lib/data/aircraft', async () => {
		const actual = await vi.importActual<typeof import('$lib/data/aircraft')>('$lib/data/aircraft');
		return { ...actual, loadCommittedAircraft: () => Promise.resolve([]) };
	});
	vi.doMock('$lib/state/data.svelte', async () => {
		const actual =
			await vi.importActual<typeof import('$lib/state/data.svelte')>('$lib/state/data.svelte');
		return { ...actual, ensureAirports: () => Promise.resolve([]), ensureNavaids: () => Promise.resolve([]) };
	});
	vi.doMock('$lib/route/navlogExport', async () => {
		const actual =
			await vi.importActual<typeof import('$lib/route/navlogExport')>('$lib/route/navlogExport');
		return {
			...actual,
			buildSaveRoutes: (rs: { name: string; waypoints: unknown[]; alternate: boolean }[]) =>
				Promise.resolve(rs.map((r) => ({ name: r.name, waypoints: r.waypoints, alternate: r.alternate }))),
		};
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock('$lib/data/aircraft');
	vi.doUnmock('$lib/state/data.svelte');
	vi.doUnmock('$lib/route/navlogExport');
	vi.doUnmock('$lib/state/flightsDb');
	vi.doUnmock('$lib/state/routePersist');
});

async function mods() {
	return {
		doc: await import('$lib/state/planDocument.svelte'),
		plan: await import('$lib/state/activePlan.svelte'),
		route: await import('$lib/state/route.svelte'),
		load: await import('$lib/state/routeLoad.svelte'),
		db: await import('$lib/state/flightsDb'),
	};
}

type Mods = Awaited<ReturnType<typeof mods>>;

function scratch(m: Mods): void {
	m.route.addWaypoint(48.5, 2.5);
	m.route.addWaypoint(49, 3);
}

describe('saving the plan on screen', () => {
	it('saves a plan never saved as a new entry, then over it', async () => {
		const m = await mods();
		scratch(m);
		expect(m.plan.planUnsaved()).toBe(true);
		expect(m.plan.canSavePlan()).toBe(true);
		expect(await m.doc.savePlan()).toEqual({ kind: 'saved', asNew: true });
		const first = await m.db.getStoredPlans();
		expect(first).toHaveLength(1);
		expect(m.plan.activePlan.source?.id).toBe(first[0].id);
		expect(m.plan.planUnsaved()).toBe(false);
		expect(m.doc.planDocument.receipt).toBe('savedAs');
		m.route.addWaypoint(49.5, 3.5);
		expect(m.plan.planUnsaved()).toBe(true);
		expect(await m.doc.savePlan()).toEqual({ kind: 'saved', asNew: false });
		const again = await m.db.getStoredPlans();
		expect(again.map((r) => r.id)).toEqual([first[0].id]);
		expect(m.doc.planDocument.receipt).toBe('saved');
	});

	it('writes nothing for a plan its entry already holds, and nothing for no route', async () => {
		const m = await mods();
		expect(await m.doc.savePlan()).toEqual({ kind: 'unchanged' });
		scratch(m);
		await m.doc.savePlan();
		const [row] = await m.db.getStoredPlans();
		expect(await m.doc.savePlan()).toEqual({ kind: 'unchanged' });
		expect((await m.db.getStoredPlans())[0].savedAtMs).toBe(row.savedAtMs);
	});

	it('forks a saved plan into a second entry', async () => {
		const m = await mods();
		scratch(m);
		await m.doc.savePlan();
		const [first] = await m.db.getStoredPlans();
		expect(await m.doc.savePlanAsNew()).toEqual({ kind: 'saved', asNew: true });
		const rows = await m.db.getStoredPlans();
		expect(rows).toHaveLength(2);
		expect(m.plan.activePlan.source?.id).not.toBe(first.id);
	});

	it('asks before a lossy copy goes over its fuller original', async () => {
		const m = await mods();
		await m.db.putStoredPlan({ id: 'p1', yaml: PLAN_WITH_IDENT, savedAtMs: 1000 });
		await m.load.loadRoutesFromYaml(PLAN_WITH_IDENT, { id: 'p1', savedAtMs: 1000 });
		const declined = m.doc.savePlan();
		await vi.waitFor(() => expect(m.doc.planDocument.question).toBe('lossy'));
		m.doc.answerPlanQuestion('cancel');
		expect(await declined).toEqual({ kind: 'cancelled' });
		expect((await m.db.getStoredPlans())[0].yaml).toBe(PLAN_WITH_IDENT);
		const accepted = m.doc.savePlan();
		await vi.waitFor(() => expect(m.doc.planDocument.question).toBe('lossy'));
		m.doc.answerPlanQuestion('confirm');
		expect(await accepted).toEqual({ kind: 'saved', asNew: false });
		expect((await m.db.getStoredPlans())[0].yaml).not.toBe(PLAN_WITH_IDENT);
	});

	it('asks before overwriting an entry changed since it was opened', async () => {
		const m = await mods();
		await m.db.putStoredPlan({ id: 'p1', yaml: PLAN, savedAtMs: 1000 });
		await m.load.loadRoutesFromYaml(PLAN, { id: 'p1', savedAtMs: 1000 });
		await m.db.putStoredPlan({ id: 'p1', yaml: PLAN, savedAtMs: 2000 });
		m.route.addWaypoint(49.5, 3.5);
		const out = m.doc.savePlan();
		await vi.waitFor(() => expect(m.doc.planDocument.question).toBe('conflict'));
		m.doc.answerPlanQuestion('confirm');
		expect(await out).toEqual({ kind: 'saved', asNew: false });
		expect((await m.db.getStoredPlans())[0].savedAtMs).toBeGreaterThan(2000);
	});

	/* Undo restores the routes alone. Undoing the activation of B over A
	 * left A's routes under B's name, settings, workbook and entry, and Save
	 * wrote them over B unasked. */
	it('saves a new entry after an undo across an activation, the activated entry kept', async () => {
		const m = await mods();
		const named = OTHER.replace('version: 1', 'version: 1\nname: Plan B');
		await m.db.putStoredPlan({ id: 'pa', yaml: PLAN, savedAtMs: 1000 });
		await m.db.putStoredPlan({ id: 'pb', yaml: named, savedAtMs: 1000 });
		await m.load.loadRoutesFromYaml(PLAN, { id: 'pa', savedAtMs: 1000 });
		await m.load.loadRoutesFromYaml(named, { id: 'pb', savedAtMs: 1000 });

		// An edit made since the activation undoes within plan B.
		m.route.addWaypoint(49.5, 3.5);
		m.route.undoRoute();
		expect(m.plan.activePlan.source?.id).toBe('pb');

		m.route.undoRoute();
		expect(m.route.routes.list[0].waypoints[0].label).toBe('ALPHA');
		expect(m.plan.activePlan.source).toBeNull();
		expect(m.route.routes.planName).toBeNull();
		expect(await m.doc.savePlan()).toEqual({ kind: 'saved', asNew: true });
		const rows = await m.db.getStoredPlans();
		expect(rows).toHaveLength(3);
		expect(rows.find((r) => r.id === 'pb')?.yaml).toBe(named);
	});
});

describe('replacing the plan on screen', () => {
	it('replaces a saved, unchanged plan and an empty one without asking', async () => {
		const m = await mods();
		const apply = vi.fn();
		expect(await m.doc.replacePlan(apply)).toBe(true);
		scratch(m);
		await m.doc.savePlan();
		expect(await m.doc.replacePlan(apply)).toBe(true);
		expect(apply).toHaveBeenCalledTimes(2);
		expect(m.doc.planDocument.question).toBeNull();
	});

	it('asks in the tick of the call, so a menu closing beside it hands its history entry to the dialog', async () => {
		// ui/backClose: a registration after the release's microtask pushes
		// an entry the release's back() then consumes, and the next Back
		// leaves the app.
		const m = await mods();
		scratch(m);
		const asked = m.doc.replacePlan(vi.fn());
		expect(m.doc.planDocument.question).toBe('replace');
		m.doc.answerPlanQuestion('cancel');
		expect(await asked).toBe(false);
	});

	it('asks before unsaved work goes: Cancel keeps it, Discard replaces it', async () => {
		const m = await mods();
		scratch(m);
		const apply = vi.fn();
		const kept = m.doc.replacePlan(apply);
		expect(m.doc.planDocument.question).toBe('replace');
		m.doc.answerPlanQuestion('cancel');
		expect(await kept).toBe(false);
		expect(apply).not.toHaveBeenCalled();
		const discarded = m.doc.replacePlan(apply);
		m.doc.answerPlanQuestion('confirm');
		expect(await discarded).toBe(true);
		expect(apply).toHaveBeenCalledTimes(1);
		expect(await m.db.getStoredPlans()).toHaveLength(0);
	});

	it('Save and continue saves the plan, then replaces it', async () => {
		const m = await mods();
		scratch(m);
		const saved: number[] = [];
		const out = m.doc.replacePlan(async () => {
			saved.push((await m.db.getStoredPlans()).length);
		});
		m.doc.answerPlanQuestion('alt');
		expect(await out).toBe(true);
		expect(saved).toEqual([1]);
	});

	it('a failed save replaces nothing', async () => {
		vi.doMock('$lib/state/flightsDb', async () => {
			const actual = await vi.importActual<typeof import('$lib/state/flightsDb')>('$lib/state/flightsDb');
			return { ...actual, putStoredPlan: () => Promise.reject(new Error('QuotaExceededError')) };
		});
		const m = await mods();
		scratch(m);
		const apply = vi.fn();
		const out = m.doc.replacePlan(apply);
		m.doc.answerPlanQuestion('alt');
		expect(await out).toBe(false);
		expect(apply).not.toHaveBeenCalled();
		expect(m.doc.planDocument.error).toEqual({ op: 'save', detail: 'QuotaExceededError' });
	});

	it('a save that fails where no menu was open opens it on its error line', async () => {
		// Ctrl+S, the palette and the phone's plan line save with no menu
		// on screen, and planDocument.error renders only in the menu.
		vi.doMock('$lib/state/flightsDb', async () => {
			const actual = await vi.importActual<typeof import('$lib/state/flightsDb')>('$lib/state/flightsDb');
			return { ...actual, putStoredPlan: () => Promise.reject(new Error('QuotaExceededError')) };
		});
		const m = await mods();
		scratch(m);
		await m.doc.saveAndAnswer();
		expect(m.doc.planDocument.error).toEqual({ op: 'save', detail: 'QuotaExceededError' });
		expect(m.doc.planDocument.menuOpen).toBe(true);
	});

	it('a newer request takes the question’s place', async () => {
		const m = await mods();
		scratch(m);
		const first = vi.fn();
		const second = vi.fn();
		const p1 = m.doc.replacePlan(first);
		const p2 = m.doc.replacePlan(second);
		expect(await p1).toBe(false);
		expect(m.doc.planDocument.question).toBe('replace');
		m.doc.answerPlanQuestion('confirm');
		expect(await p2).toBe(true);
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});

	it('a route file opened over unsaved work waits for the answer', { timeout: 30_000 }, async () => {
		const m = await mods();
		const open = await import('$lib/state/openFile.svelte');
		scratch(m);
		const before = m.route.routes.list[0].waypoints.map((w) => w.lat);
		const opening = open.openIncomingFile('other.yaml', OTHER);
		await vi.waitFor(() => expect(m.doc.planDocument.question).toBe('replace'));
		expect(m.route.routes.list[0].waypoints.map((w) => w.lat)).toEqual(before);
		m.doc.answerPlanQuestion('confirm');
		await opening;
		expect(m.route.routes.list[0].waypoints.map((w) => w.lat)).toEqual([47.5, 49]);
	});
});

describe('a replacement during the boot restore', () => {
	it('waits for nothing before a restore begins', async () => {
		const rp = await import('$lib/state/routePersist');
		expect(rp.restoreInFlight()).toBeNull();
	});

	it('waits for the restore in flight, then asks about the plan it brought back', async () => {
		let land: () => void = () => undefined;
		vi.doMock('$lib/state/routePersist', async () => {
			const actual = await vi.importActual<typeof import('$lib/state/routePersist')>('$lib/state/routePersist');
			const running = new Promise<void>((r) => (land = r));
			return { ...actual, restoreInFlight: () => running };
		});
		const m = await mods();
		const apply = vi.fn();
		const replacing = m.doc.replacePlan(apply);
		await new Promise((r) => setTimeout(r, 20));
		expect(m.doc.planDocument.question).toBeNull();
		expect(apply).not.toHaveBeenCalled();
		// The restore lands the pilot's plan, never saved.
		scratch(m);
		land();
		await vi.waitFor(() => expect(m.doc.planDocument.question).toBe('replace'));
		m.doc.answerPlanQuestion('cancel');
		expect(await replacing).toBe(false);
		expect(apply).not.toHaveBeenCalled();
	});
});

describe('a new flight plan', () => {
	it('starts from the defaults a file load uses, the pilot and the aircraft kept', async () => {
		const m = await mods();
		const prep = await import('$lib/state/flightPrep.svelte');
		const aircraft = await import('$lib/state/aircraft.svelte');
		const wind = await import('$lib/state/windAloft.svelte');
		aircraft.selectAircraft('F-GORQ');
		prep.setDossierPilot({ name: 'D. Pilote' });
		expect(await m.load.loadRoutesFromYaml(RICH)).toBe(true);
		prep.setOnBoard({ measuredL: 52 });
		expect(m.route.routes.planName).toBe('Nav examen');
		expect(m.route.routeSettings.transitionAltitudeFt).toBe(6000);
		expect(prep.flightPrep.mb.stopovers).not.toEqual({});

		m.load.loadEmptyPlan();
		expect(m.route.routes.list).toHaveLength(1);
		expect(m.route.routes.list[0].waypoints).toEqual([]);
		expect(m.route.routes.planName).toBeNull();
		expect(m.route.routeSettings.transitionAltitudeFt).toBeNull();
		expect(m.route.routeSettings.cruiseSpeedKt).toBeNull();
		expect(m.route.routeSettings.windDirDeg).toBeNull();
		expect(m.route.routeSettings.windSpeedKt).toBeNull();
		// The session's own choices stay: the flight rules the file set.
		expect(m.route.routeSettings.vfr).toBe(false);
		expect(wind.windAloft.useForecastForLegs).toBe(true);
		expect(prep.flightPrep.mb.stopovers).toEqual({});
		expect(prep.flightPrep.mb.onBoard).toBeNull();
		expect(prep.flightPrep.fuel.trips.every((t) => t.contingencyMin == null)).toBe(true);
		expect(prep.flightPrep.dossier.pilot.name).toBe('D. Pilote');
		expect(aircraft.aircraftState.selectedKey).toBe('F-GORQ');
		expect(m.plan.activePlan.source).toBeNull();
		// One undo step brings the routes back.
		m.route.undoRoute();
		expect(m.route.routes.list).toHaveLength(2);
	});

	it('asks first only when the plan on screen holds unsaved work', async () => {
		const m = await mods();
		scratch(m);
		const asked = m.doc.newPlan();
		expect(m.doc.planDocument.question).toBe('replace');
		m.doc.answerPlanQuestion('confirm');
		expect(await asked).toBe(true);
		expect(m.route.routes.list[0].waypoints).toEqual([]);
		expect(await m.doc.newPlan()).toBe(true);
		expect(m.doc.planDocument.question).toBeNull();
	});
});

describe('naming the plan on screen', () => {
	it('names a plan never saved in the workspace, which its first save writes', async () => {
		const m = await mods();
		scratch(m);
		const sig = m.plan.planSig();
		await m.doc.renameActivePlan('  Nav   examen  ');
		expect(m.route.routes.planName).toBe('Nav examen');
		expect(m.plan.planSig()).toBe(sig);
		expect(m.doc.planIdentity()).toBe('Nav examen');
		await m.doc.savePlan();
		expect((await m.db.getStoredPlans())[0].yaml).toMatch(/^name: Nav examen$/m);
	});

	it('names a saved plan in its stored row too, its stamp kept', async () => {
		const m = await mods();
		await m.db.putStoredPlan({ id: 'p1', yaml: PLAN, savedAtMs: 1000 });
		await m.load.loadRoutesFromYaml(PLAN, { id: 'p1', savedAtMs: 1000 });
		await m.doc.renameActivePlan('Training sheet 3');
		const [row] = await m.db.getStoredPlans();
		expect(row.yaml).toMatch(/^name: Training sheet 3$/m);
		expect(row.savedAtMs).toBe(1000);
		expect(m.route.routes.planName).toBe('Training sheet 3');
		expect(m.plan.planUnsaved()).toBe(false);
		// Emptied, it hands the plan back to its route.
		await m.doc.renameActivePlan(null);
		expect(m.route.routes.planName).toBeNull();
		expect((await m.db.getStoredPlans())[0].yaml).not.toMatch(/^name:/m);
	});

	it('lands before a save started after it', async () => {
		const m = await mods();
		await m.db.putStoredPlan({ id: 'p1', yaml: PLAN, savedAtMs: 1000 });
		await m.load.loadRoutesFromYaml(PLAN, { id: 'p1', savedAtMs: 1000 });
		m.route.addWaypoint(49.5, 3.5);
		const renamed = m.doc.renameActivePlan('Nav examen');
		const saved = m.doc.savePlan();
		await renamed;
		expect(await saved).toEqual({ kind: 'saved', asNew: false });
		expect((await m.db.getStoredPlans())[0].yaml).toMatch(/^name: Nav examen$/m);
	});
});

describe('naming while a save runs', () => {
	it('waits for a save already running, then names the row', async () => {
		const m = await mods();
		await m.db.putStoredPlan({ id: 'p1', yaml: PLAN, savedAtMs: 1000 });
		await m.load.loadRoutesFromYaml(PLAN, { id: 'p1', savedAtMs: 1000 });
		m.route.addWaypoint(49.5, 3.5);
		const saved = m.doc.savePlan();
		const renamed = m.doc.renameActivePlan('Nav examen');
		expect(await saved).toEqual({ kind: 'saved', asNew: false });
		await renamed;
		expect((await m.db.getStoredPlans())[0].yaml).toMatch(/^name: Nav examen$/m);
		expect(m.plan.planUnsaved()).toBe(false);
	});
});

describe('where the plan stands', () => {
	it('reads empty, new, dirty, lossy and saved', async () => {
		const m = await mods();
		expect(m.doc.planState()).toBe('empty');
		scratch(m);
		expect(m.doc.planState()).toBe('new');
		await m.doc.savePlan();
		expect(m.doc.planState()).toBe('saved');
		m.route.addWaypoint(49.5, 3.5);
		expect(m.doc.planState()).toBe('dirty');
		await m.db.putStoredPlan({ id: 'p2', yaml: PLAN_WITH_IDENT, savedAtMs: 1000 });
		await m.load.loadRoutesFromYaml(PLAN_WITH_IDENT, { id: 'p2', savedAtMs: 1000 });
		expect(m.doc.planState()).toBe('lossy');
	});
});

describe('downloading the plan file', () => {
	afterEach(() => {
		vi.doUnmock('$lib/ui/dom');
	});

	it('puts a write the shell refused on the menu error line', async () => {
		// In the Android shell the file is written to the app cache before
		// the share sheet (ui/dom.ts), and a failed write (a full device)
		// rejected unobserved while the download read as done.
		vi.doMock('$lib/ui/dom', async () => {
			const actual = await vi.importActual<typeof import('$lib/ui/dom')>('$lib/ui/dom');
			return { ...actual, downloadBlob: () => Promise.reject(new Error('No space left on device')) };
		});
		const m = await mods();
		scratch(m);
		expect(await m.doc.downloadPlanFile()).toBe(false);
		expect(m.doc.planDocument.error).toEqual({ op: 'download', detail: 'No space left on device' });
		expect(m.doc.planDocument.downloading).toBe(false);
	});
});
