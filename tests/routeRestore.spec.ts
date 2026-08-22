/* The boot restore of the route workspace (state/routePersist.ts), which
 * ran untested while three ways of losing a flight plan lived in it.
 *
 * The pins here are the ones whose failure is INVISIBLE in the app: the
 * plan simply is not there at startup, the stored copy is then overwritten
 * by the first edit, and nothing anywhere says so.
 *
 * Every case builds a fresh module graph (vi.resetModules + dynamic
 * import), because PRISTINE_SIG / PRISTINE_YAML are captured at module
 * evaluation and ARE the pristine-workspace baseline. localStorage and
 * location are stubbed per case: vitest runs in a node environment. */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

const KEY = 'loxodrome:routes';
const RESCUE_KEY = 'loxodrome:routes-rescued';

let store: Map<string, string>;

/** Whether the dataset ensures resolve. Read at call time, so a case can
 *  fail the first attempt and let the retry succeed. */
let datasetsOk = true;
/** When set, the ensures return THIS promise instead: a case can hold the
 *  restore mid-await and probe what the armed writer does meanwhile. */
let datasetGate: Promise<unknown> | null = null;

beforeEach(() => {
	store = new Map<string, string>();
	datasetsOk = true;
	datasetGate = null;
	globalThis.indexedDB = new IDBFactory();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	vi.stubGlobal('location', { search: '' });
	vi.resetModules();

	// The restore's two awaits. Resolving them with empty datasets is enough:
	// the resolver these tests use is injected below through waypointSearch,
	// and free lat/lon waypoints need no dataset at all.
	vi.doMock('$lib/state/data.svelte', async () => {
		const actual =
			await vi.importActual<typeof import('$lib/state/data.svelte')>('$lib/state/data.svelte');
		return {
			...actual,
			ensureAirports: () =>
				datasetGate ?? (datasetsOk ? Promise.resolve([]) : Promise.reject(new Error('offline'))),
			ensureNavaids: () =>
				datasetGate ?? (datasetsOk ? Promise.resolve([]) : Promise.reject(new Error('offline'))),
		};
	});
});

/** Every module graph a test imported: the debounce runs on REAL timers,
 *  and a 1 s write scheduled by one test would otherwise fire into a LATER
 *  test's store (the localStorage stub closes over the live `store` let).
 *  Flushing each graph at teardown clears its timer inside its own world. */
const persistMods: (typeof import('$lib/state/routePersist'))[] = [];

afterEach(() => {
	for (const p of persistMods) {
		p.flushRoutesPersist();
	}
	persistMods.length = 0;
	vi.unstubAllGlobals();
	vi.doUnmock('$lib/state/data.svelte');
});

async function mods(): Promise<{
	persist: typeof import('$lib/state/routePersist');
	route: typeof import('$lib/state/route.svelte');
	load: typeof import('$lib/state/routeLoad.svelte');
	db: typeof import('$lib/state/flightsDb');
}> {
	const persist = await import('$lib/state/routePersist');
	persistMods.push(persist);
	return {
		persist,
		route: await import('$lib/state/route.svelte'),
		load: await import('$lib/state/routeLoad.svelte'),
		db: await import('$lib/state/flightsDb'),
	};
}

/** A stored doc holding one two-leg route of FREE points (no dataset
 *  needed to resolve them), with the flight rules the case is about. */
function storedDoc(opts: { vfr: boolean; name?: string }): string {
	const yaml = [
		'version: 1',
		...(opts.name === undefined ? [] : [`name: ${opts.name}`]),
		'settings:',
		`  vfr: ${String(opts.vfr)}`,
		'  semi_circular: true',
		'  wind_forecast: true',
		'  temperature_tas: false',
		'routes:',
		'  - waypoints:',
		'      - name: ALPHA',
		'        lat: 48.5',
		'        lon: 2.5',
		'        leg:',
		'          altitude: 2500',
		'          auto: true',
		'      - name: BRAVO',
		'        lat: 49',
		'        lon: 3',
		'',
	].join('\n');
	return JSON.stringify({
		v: 1,
		activeIndex: 0,
		settings: {
			corridorRadiusNM: 15,
			minAltCorridorRadiusNM: 5,
			cruiseSpeedKt: 100,
			defaultAltitudeFt: 2000,
			windDirDeg: null,
			windSpeedKt: null,
			airportFreqsInNavlog: true,
			enrouteFreqsInNavlog: true,
			vorRadialsInNavlog: true,
		},
		yaml,
		source: null,
	});
}

describe('the stored workspace comes back', () => {
	it('restores a VFR plan', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		const { persist, route } = await mods();
		await persist.restoreRoutes();
		expect(route.routes.list[0].waypoints.map((w) => w.label)).toEqual(['ALPHA', 'BRAVO']);
	});

	/* The plan's descriptive name rides the same document: a reload that
	 * dropped it would leave the workspace storing its catalog row back
	 * unnamed. */
	it('restores the plan name', async () => {
		store.set(KEY, storedDoc({ vfr: true, name: 'Nav examen' }));
		const { persist, route } = await mods();
		await persist.restoreRoutes();
		expect(route.routes.planName).toBe('Nav examen');
	});

	/* THE regression. The restore seeds routeSettings.vfr synchronously
	 * ahead of its dataset awaits (so the airspace alerts never grade an
	 * IFR profile as VFR), and that seed lands in the very settings block
	 * leanWorkspaceYaml serializes. Comparing the post-await workspace
	 * against the module-eval PRISTINE_YAML therefore read the restore's
	 * OWN write back as "the user planned something" and aborted, so an
	 * IFR plan never returned. The guard now compares against a baseline
	 * captured after the seed. */
	it('restores an IFR plan, which its own flight-rules seed used to abort', async () => {
		store.set(KEY, storedDoc({ vfr: false }));
		const { persist, route } = await mods();
		await persist.restoreRoutes();
		expect(route.routes.list[0].waypoints.map((w) => w.label)).toEqual(['ALPHA', 'BRAVO']);
		expect(route.routeSettings.vfr).toBe(false);
	});

	it('leaves the workspace alone when the user planned first', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		const { persist, route } = await mods();
		route.addWaypoint(45, 1);
		await persist.restoreRoutes();
		expect(route.routes.list[0].waypoints).toHaveLength(1);
	});
});

describe('a restore that cannot run holds the stored plan', () => {
	it('does not overwrite it when the datasets fail, and retries when they arrive', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		datasetsOk = false;
		const { persist, route, load } = await mods();

		await persist.restoreRoutes();
		expect(route.routes.list[0].waypoints).toHaveLength(0);
		expect(persist.routesRestorePending()).toBe(true);
		expect(load.routeLoad.restore?.reason).toBe('data');

		// The writer arms on the empty workspace exactly as PersistHost does.
		persist.armRoutesPersist();
		expect(store.get(KEY)).toBe(storedDoc({ vfr: true }));

		// The datasets arrive; PersistHost's effect calls back in.
		datasetsOk = true;
		await persist.retryRestoreRoutes();
		expect(route.routes.list[0].waypoints.map((w) => w.label)).toEqual(['ALPHA', 'BRAVO']);
		expect(persist.routesRestorePending()).toBe(false);
		expect(load.routeLoad.restore).toBeNull();
	});

	it('rescues it into the flight plan catalog when the user plans instead', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		datasetsOk = false;
		const { persist, route, load, db } = await mods();
		await persist.restoreRoutes();
		persist.armRoutesPersist();

		// The user starts planning over the empty workspace: this is the edit
		// that used to destroy the stored plan.
		route.addWaypoint(45, 1);
		persist.persistRoutesSoon();
		await vi.waitFor(async () => {
			expect(await db.getStoredPlans()).toHaveLength(1);
		});

		const [kept] = await db.getStoredPlans();
		expect(kept.yaml).toContain('ALPHA');
		expect(kept.yaml).toContain('BRAVO');
		expect(load.routeLoad.restore?.stage).toBe('rescued');
		// The synchronous shelter is dropped once the catalog copy landed.
		expect(store.get(RESCUE_KEY)).toBeUndefined();
		expect(persist.routesRestorePending()).toBe(false);
	});

	/* The boot's own machine writers touch the knobs OUTSIDE the yaml: the
	 * eager aircraft-library load re-applies the selected plane's cruise
	 * speed the moment it resolves. Releasing the hold on a whole-doc
	 * comparison read that as planning and wrote the empty workspace over
	 * the plan with nobody having typed anything. */
	it('is not released by a boot writer touching the out-of-yaml knobs', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		datasetsOk = false;
		const { persist, route, db } = await mods();
		await persist.restoreRoutes();
		persist.armRoutesPersist();

		route.routeSettings.cruiseSpeedKt = 137;
		persist.persistRoutesSoon();
		await new Promise((r) => setTimeout(r, 20));

		expect(persist.routesRestorePending()).toBe(true);
		expect(await db.getStoredPlans()).toHaveLength(0);
		expect(store.get(KEY)).toBe(storedDoc({ vfr: true }));
	});

	/* persistRoutesSoon is the hold, but flushRoutesPersist is what deletes
	 * the key outright on a pristine signature, so it refuses too. */
	it('survives a flush, which must neither write nor remove the key', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		datasetsOk = false;
		const { persist } = await mods();
		await persist.restoreRoutes();
		persist.armRoutesPersist();

		persist.flushRoutesPersist();
		expect(store.get(KEY)).toBe(storedDoc({ vfr: true }));
	});

	/* The retry has to compare against the workspace the hold was taken
	 * against, not the module default: the flight-rules seed already ran and
	 * is never rolled back, so a held IFR plan measured against the default
	 * declines every retry for ever and the manual button is dead. */
	it('retries an IFR plan, whose seed has already moved the workspace', async () => {
		store.set(KEY, storedDoc({ vfr: false }));
		datasetsOk = false;
		const { persist, route } = await mods();
		await persist.restoreRoutes();
		persist.armRoutesPersist();
		expect(persist.routesRestorePending()).toBe(true);

		datasetsOk = true;
		await persist.retryRestoreRoutes();
		expect(route.routes.list[0].waypoints.map((w) => w.label)).toEqual(['ALPHA', 'BRAVO']);
	});

	/* Two offline sessions in a row must not breed one catalog row each:
	 * the rescue id is derived from the content and putStoredPlan upserts. */
	it('rescues the same plan onto one catalog row, however many sessions', async () => {
		const doc = storedDoc({ vfr: true });
		for (let session = 0; session < 2; session++) {
			store.clear();
			store.set(KEY, doc);
			datasetsOk = false;
			vi.resetModules();
			const { persist, route, db } = await mods();
			await persist.restoreRoutes();
			persist.armRoutesPersist();
			route.addWaypoint(45, 1);
			persist.persistRoutesSoon();
			await vi.waitFor(async () => {
				expect(await db.getStoredPlans()).toHaveLength(1);
			});
		}
		const { db } = await mods();
		expect(await db.getStoredPlans()).toHaveLength(1);
	});

	it('holds nothing when nothing is stored', async () => {
		const { persist } = await mods();
		await persist.restoreRoutes();
		expect(persist.routesRestorePending()).toBe(false);
	});

	/* The in-flight doctrine at its chokepoint: the automatic effect skips
	 * while recording, and the manual button must too, or a tap would swap
	 * the workspace under a pilot in flight. */
	it('declines the retry while a recording runs', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		datasetsOk = false;
		const { persist, route } = await mods();
		await persist.restoreRoutes();
		persist.armRoutesPersist();

		const { nav } = await import('$lib/state/navRecording.svelte');
		datasetsOk = true;
		nav.recording = true;
		try {
			await persist.retryRestoreRoutes();
			expect(route.routes.list[0].waypoints).toHaveLength(0);
			expect(persist.routesRestorePending()).toBe(true);
		} finally {
			nav.recording = false;
		}
		await persist.retryRestoreRoutes();
		expect(route.routes.list[0].waypoints).toHaveLength(2);
	});

	/* Re-running loadRoutes on unchanged coverage rebuilds the identical
	 * mutilated workspace at the cost of an undo step, re-minted waypoint
	 * ids and an active-route yank, once per dataset revision bump. A lossy
	 * retry runs only when one of ITS missing idents resolves. */
	it('leaves the workspace alone on a lossy retry that cannot improve', async () => {
		const yaml = [
			'version: 1',
			'routes:',
			'  - waypoints:',
			'      - name: ALPHA',
			'        lat: 48.5',
			'        lon: 2.5',
			'      - name: NOWHERE',
			'        ident: ZZZZ',
			'      - name: BRAVO',
			'        lat: 49',
			'        lon: 3',
			'',
		].join('\n');
		store.set(KEY, JSON.stringify({ v: 1, activeIndex: 0, settings: {}, yaml, source: null }));
		const { persist, route } = await mods();
		await persist.restoreRoutes();
		persist.armRoutesPersist();
		expect(persist.routesRestorePending()).toBe(true);
		const idsBefore = route.routes.list[0].waypoints.map((w) => w.id);

		await persist.retryRestoreRoutes();
		expect(route.routes.list[0].waypoints.map((w) => w.id)).toEqual(idsBefore);
		expect(persist.routesRestorePending()).toBe(true);
	});

	/* The rescue past the hold, staged: the sentence and the button must
	 * track where the plan actually stands, not where the hold left it. */
	it('says the plan is set aside when the catalog refuses the deposit', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		datasetsOk = false;
		const { persist, route, load, db } = await mods();
		vi.spyOn(db, 'putStoredPlan').mockRejectedValue(new Error('idb refused'));
		await persist.restoreRoutes();
		persist.armRoutesPersist();

		route.addWaypoint(45, 1);
		persist.persistRoutesSoon();
		await vi.waitFor(() => {
			// The failed deposit settles: the stage stops at 'sheltered', the
			// shelter key stands for the next boot's outbox pass, and the
			// hold is gone (nothing a retry could restore).
			expect(load.routeLoad.restore).toEqual({ reason: 'data', stage: 'sheltered' });
		});
		expect(store.get(RESCUE_KEY)).toBe(storedDoc({ vfr: true }));
		expect(persist.routesRestorePending()).toBe(false);
		expect(await db.getStoredPlans()).toHaveLength(0);
	});

	/* The promise "at the next start" is kept AND shown: the boot that
	 * drains the outbox stamps the receipt. */
	it('drains the shelter at the next boot and shows the receipt', async () => {
		store.set(RESCUE_KEY, storedDoc({ vfr: true }));
		const { persist, load, db } = await mods();
		await persist.restoreRoutes();
		await vi.waitFor(async () => {
			expect(await db.getStoredPlans()).toHaveLength(1);
		});
		expect((await db.getStoredPlans())[0].yaml).toContain('ALPHA');
		expect(store.get(RESCUE_KEY)).toBeUndefined();
		expect(load.routeLoad.restore).toEqual({ reason: 'superseded', stage: 'rescued' });
	});

	/* Last session's deposit landing must not dress up THIS session's hold:
	 * the drained plan is in the catalog, but the plan the new hold protects
	 * is not, and the Restore-it button belongs to it. */
	it('a draining deposit never upgrades a live hold', async () => {
		store.set(RESCUE_KEY, storedDoc({ vfr: false }));
		store.set(KEY, storedDoc({ vfr: true }));
		datasetsOk = false;
		const { persist, load, db } = await mods();
		await persist.restoreRoutes();
		await vi.waitFor(async () => {
			expect(await db.getStoredPlans()).toHaveLength(1);
		});
		expect(load.routeLoad.restore).toEqual({ reason: 'data', stage: 'held' });
	});

	/* The restore success tail clears HOLD outcomes only: a rescued receipt
	 * stamped while it awaited must survive onto the boot meant to show it. */
	it('a rescued receipt survives a successful restore', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		const { persist, route, load } = await mods();
		load.markRouteRestoreRescued(); // the boot-drain receipt, order-independent
		await persist.restoreRoutes();
		expect(route.routes.list[0].waypoints).toHaveLength(2);
		expect(load.routeLoad.restore).toEqual({ reason: 'superseded', stage: 'rescued' });
	});

	/* The stored bytes cannot change, so a parse hold retried is a parse
	 * hold failed again, for ever, on every dataset revision bump. */
	it('never retries a parse hold', async () => {
		store.set(KEY, JSON.stringify({ v: 1, activeIndex: 0, settings: {}, yaml: '{{nope', source: null }));
		const { persist, route, load } = await mods();
		await persist.restoreRoutes();
		persist.armRoutesPersist();
		expect(load.routeLoad.restore?.reason).toBe('parse');

		await persist.retryRestoreRoutes();
		expect(persist.routesRestorePending()).toBe(true);
		expect(route.routes.list[0].waypoints).toHaveLength(0);
		expect(store.get(KEY)).toContain('nope');
	});
});

/* An incoming route file cold-starts the app on Android ("Open with") and
 * lands WHILE the restore is running. What the user opened must persist:
 * a hold taken against the workspace already on screen has nothing left to
 * write, so the file would never reach storage and the next boot would
 * bring the old plan back instead. Reported from the phone, as "I can't
 * load laon.yaml any more". */
describe('a workspace the user already has', () => {
	it('keeps persisting, and the plan it displaced goes to the catalog', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		const { persist, route, db } = await mods();

		// The incoming file lands before the restore's own guard runs.
		route.addWaypoint(45, 1);
		route.addWaypoint(46, 2);
		await persist.restoreRoutes();
		expect(persist.routesRestorePending()).toBe(false);

		// The file is what the writer stores from here on.
		persist.armRoutesPersist();
		route.addWaypoint(47, 3);
		persist.persistRoutesSoon();
		persist.flushRoutesPersist();
		const written = store.get(KEY);
		expect(written).toBeDefined();
		expect(written).not.toBe(storedDoc({ vfr: true }));
		expect((JSON.parse(written!) as { yaml: string }).yaml).not.toContain('ALPHA');

		// And the plan it displaced is safe.
		await vi.waitFor(async () => {
			expect(await db.getStoredPlans()).toHaveLength(1);
		});
		expect((await db.getStoredPlans())[0].yaml).toContain('ALPHA');
	});

	it('deposits that plan on one catalog row across repeat boots', async () => {
		const doc = storedDoc({ vfr: true });
		for (let i = 0; i < 2; i++) {
			store.clear();
			store.set(KEY, doc);
			vi.resetModules();
			const { persist, route, db } = await mods();
			route.addWaypoint(45, 1);
			route.addWaypoint(46, 2);
			await persist.restoreRoutes();
			await vi.waitFor(async () => {
				expect(await db.getStoredPlans()).toHaveLength(1);
			});
		}
		const { db } = await mods();
		expect(await db.getStoredPlans()).toHaveLength(1);
	});

	/* Arming is where the displacement STICKS: seeding lastSig alone
	 * declared the file persisted without writing it, so a no-edit session
	 * ended with the next boot bringing the old plan back. */
	it('writes the displacing workspace through at arm, no edit needed', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		const { persist, route } = await mods();
		route.addWaypoint(45, 1);
		route.addWaypoint(46, 2);
		await persist.restoreRoutes();
		persist.armRoutesPersist();

		const written = store.get(KEY);
		expect(written).toBeDefined();
		const yaml = (JSON.parse(written!) as { yaml: string }).yaml;
		expect(yaml).not.toContain('ALPHA');
		expect(yaml).toContain('45');
	});
});

/* A ?file= boot DEFERS the restore rather than skipping it for the session:
 * the file is most often a NOTAM briefing, which says nothing about the
 * flight plan. */
describe('a boot carrying an incoming file', () => {
	it('still restores the plan when the file was not a route', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		vi.stubGlobal('location', { search: '?file=notams.txt' });
		const { persist, route } = await mods();

		await persist.restoreRoutes();
		expect(route.routes.list[0].waypoints).toHaveLength(0); // deferred

		await persist.resumeRoutesRestore();
		expect(route.routes.list[0].waypoints.map((w) => w.label)).toEqual(['ALPHA', 'BRAVO']);
	});

	it('keeps the stored plan when the file WAS a route, without erasing it', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		vi.stubGlobal('location', { search: '?file=plan.yaml' });
		const { persist, route, db } = await mods();
		await persist.restoreRoutes();

		// The incoming route file replaces the workspace, then the resume runs.
		route.addWaypoint(45, 1);
		route.addWaypoint(46, 2);
		await persist.resumeRoutesRestore();
		expect(persist.routesRestorePending()).toBe(false);
		await vi.waitFor(async () => {
			expect(await db.getStoredPlans()).toHaveLength(1);
		});
	});

	/* The resume ends in the rearm, whose sync must WRITE the opened file:
	 * cancelling the writer's queued first persist and seeding lastSig on
	 * the file's own signature left ROUTES_KEY holding the OLD plan, so a
	 * no-edit session brought it back at the next boot (found on G2). */
	it('persists the opened route file with no further edit', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		vi.stubGlobal('location', { search: '?file=plan.yaml' });
		const { persist, route } = await mods();
		await persist.restoreRoutes();
		persist.armRoutesPersist(); // PersistHost arms on the deferred settle

		route.addWaypoint(45, 1);
		route.addWaypoint(46, 2);
		await persist.resumeRoutesRestore();

		const written = store.get(KEY);
		expect(written).toBeDefined();
		expect((JSON.parse(written!) as { yaml: string }).yaml).not.toContain('ALPHA');
	});

	it('persists the opened route file when nothing was stored', async () => {
		vi.stubGlobal('location', { search: '?file=plan.yaml' });
		const { persist, route } = await mods();
		await persist.restoreRoutes();
		persist.armRoutesPersist();

		route.addWaypoint(45, 1);
		route.addWaypoint(46, 2);
		await persist.resumeRoutesRestore();

		expect(store.get(KEY)).toBeDefined();
	});

	/* The stored doc sits unrestored under an ARMED writer while the file
	 * downloads: an edit in that window must not flush over it. The write
	 * lands after the resume instead, once shelter and rescue had their
	 * look. */
	it('an edit made while the file downloads cannot overwrite the stored plan', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		vi.stubGlobal('location', { search: '?file=slow.txt' });
		const { persist, route, db } = await mods();
		await persist.restoreRoutes();
		persist.armRoutesPersist();

		route.addWaypoint(45, 1);
		persist.persistRoutesSoon();
		persist.flushRoutesPersist(); // the debounce firing mid-download
		expect(store.get(KEY)).toBe(storedDoc({ vfr: true }));

		await persist.resumeRoutesRestore();
		// The displaced plan is safe and the edit is now the stored workspace.
		await vi.waitFor(async () => {
			expect(await db.getStoredPlans()).toHaveLength(1);
		});
		expect((await db.getStoredPlans())[0].yaml).toContain('ALPHA');
		expect((JSON.parse(store.get(KEY)!) as { yaml: string }).yaml).not.toContain('ALPHA');
	});

	/* The restore's own flight-rules seed is a yaml-affecting write under an
	 * armed writer on the resume path: a debounce firing during the dataset
	 * await must not flush the near-pristine seed doc over the stored plan
	 * it is restoring. */
	it('a flush firing during the resumed restore cannot overwrite the stored plan', async () => {
		store.set(KEY, storedDoc({ vfr: false }));
		vi.stubGlobal('location', { search: '?file=notams.txt' });
		let release: (v: unknown[]) => void = () => undefined;
		const { persist, route } = await mods();
		await persist.restoreRoutes();
		persist.armRoutesPersist();

		datasetGate = new Promise((r) => {
			release = r;
		});
		const resume = persist.resumeRoutesRestore();
		await Promise.resolve(); // the seed has run; the restore awaits the datasets
		persist.persistRoutesSoon();
		persist.flushRoutesPersist();
		expect(store.get(KEY)).toBe(storedDoc({ vfr: false }));

		release([]);
		await resume;
		expect(route.routes.list[0].waypoints.map((w) => w.label)).toEqual(['ALPHA', 'BRAVO']);
	});

	/* The flights boot archive waits on whenRoutesRestored to snapshot the
	 * flown plan; settling at the DEFERRAL handed it a pristine workspace. */
	it('whenRoutesRestored waits for the resume on a ?file= boot', async () => {
		store.set(KEY, storedDoc({ vfr: true }));
		vi.stubGlobal('location', { search: '?file=notams.txt' });
		const { persist } = await mods();
		let settled = false;
		void persist.whenRoutesRestored().then(() => {
			settled = true;
		});
		await persist.restoreRoutes();
		await Promise.resolve();
		expect(settled).toBe(false);
		await persist.resumeRoutesRestore();
		await Promise.resolve();
		expect(settled).toBe(true);
	});
});

describe('what the restore had to drop is reported', () => {
	it('says so when the stored plan lost a waypoint', async () => {
		const yaml = [
			'version: 1',
			'routes:',
			'  - waypoints:',
			'      - name: ALPHA',
			'        lat: 48.5',
			'        lon: 2.5',
			'      - name: NOWHERE',
			'        ident: ZZZZ',
			'      - name: BRAVO',
			'        lat: 49',
			'        lon: 3',
			'',
		].join('\n');
		store.set(KEY, JSON.stringify({ v: 1, activeIndex: 0, settings: {}, yaml, source: null }));
		const { persist, load } = await mods();
		await persist.restoreRoutes();
		expect(load.routeLoad.notice?.dropped).toContain('ZZZZ');
		// And it is not treated as a success: the fuller stored doc stays held,
		// so a later retry can recover the waypoint and the first edit rescues.
		expect(persist.routesRestorePending()).toBe(true);
		expect(load.routeLoad.restore?.reason).toBe('lossy');
	});

	/* A lossy restore must mark the provenance lossy however the stored flag
	 * read, or "Store flight plan" silently replaces the fuller catalog entry
	 * with the mutilated workspace, skipping its own confirm. */
	it('flags the plan lossy so Store cannot overwrite the fuller entry unasked', async () => {
		const yaml = [
			'version: 1',
			'routes:',
			'  - waypoints:',
			'      - name: ALPHA',
			'        lat: 48.5',
			'        lon: 2.5',
			'      - name: NOWHERE',
			'        ident: ZZZZ',
			'      - name: BRAVO',
			'        lat: 49',
			'        lon: 3',
			'',
		].join('\n');
		store.set(
			KEY,
			JSON.stringify({
				v: 1,
				activeIndex: 0,
				settings: {},
				yaml,
				source: { id: 'p1', savedAtMs: 1, sig: 'x', lossy: false },
			}),
		);
		const { persist } = await mods();
		await persist.restoreRoutes();
		const { activePlan } = await import('$lib/state/activePlan.svelte');
		expect(activePlan.source?.lossy).toBe(true);
	});
});
