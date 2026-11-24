/* The automatic briefing's clock (state/briefingClock.svelte.ts), run from
 * an effect as BriefingHost runs it: a boot with a stored plan fetches once,
 * an edit waits for the plan to hold still 15 s, a burst of edits costs one
 * run, a failure waits its backoff, an offline page waits to be online, and
 * the switch off fetches nothing. SOFIA is stubbed at the fetch, each PIB
 * logged by its tokens, and the clock and the timers are faked. */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SofiaNotam } from '$lib/sofia/client';
import type { Route, Waypoint } from '$lib/state/route.svelte';

vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	ensureAirports: () => Promise.resolve([]),
	ensureAirspaces: () => Promise.resolve([]),
	ensureNavaids: () => Promise.resolve([]),
}));

const { flushSync } = await import('svelte');
// The data store before the NOTAM state: its root effect reads the NOTAM
// state, which the client runtime has not finished evaluating when the
// NOTAM module comes first and pulls the store in.
await import('$lib/state/data.svelte');
const { clearNotams } = await import('$lib/state/notam.svelte');
const { briefingRun, briefingWatch } = await import('$lib/state/briefing.svelte');
const { createBriefingClock } = await import('$lib/state/briefingClock.svelte');
const { installFlightScope } = await import('$lib/state/flightScope');
const { flightPrep } = await import('$lib/state/flightPrep.svelte');
const { autorouter } = await import('$lib/autorouter/state.svelte');
const { display } = await import('$lib/state/display.svelte');
const { routes, routeSettings } = await import('$lib/state/route.svelte');
const { mountEffect } = await import('./helpers/derivedHost.svelte');

const S = 1000;
const MIN = 60 * S;
const T = Date.UTC(2026, 10, 24, 19, 0);

const ad = (id: string, lat: number, lon: number): Waypoint =>
	({ id, lat, lon, kind: 'airport', ident: id, alt: 2500, altAuto: true }) as unknown as Waypoint;
const free = (id: string, lat: number, lon: number): Waypoint =>
	({ id, lat, lon, kind: 'free', alt: 2500, altAuto: true }) as unknown as Waypoint;

/** Toussus to Orléans by Étampes, the middle point moved `nm` east, across
 *  the track. */
const plan = (nm = 0): Route => ({
	id: 'r1',
	name: null,
	waypoints: [
		ad('LFPN', 48.75194, 2.10611),
		free('m', 48.433, 2.16 + nm / (60 * Math.cos((48.433 * Math.PI) / 180))),
		ad('LFOZ', 47.89694, 2.16333),
	],
	selectedWaypointId: null,
});

const NOTAM: SofiaNotam = {
	id: 'S3001',
	series: 'W',
	number: 3001,
	year: 26,
	type: 'N',
	qLine: { fir: 'LFFF', code23: 'WP', code45: 'LW', traffic: 'IV', purpose: 'BO', scope: 'W', lower: 0, upper: 115 },
	coordinates: '4826N00209E',
	radius: 3,
	itemA: 'LFFF',
	startValidity: '2026-01-01T00:00:00Z',
	endValidity: 'PERM',
	itemE: 'PJE WI 3NM ETAMPES.',
};

/** Each PIB SOFIA was asked, whether it answers (a 429 when not), and an
 *  answer held until the case releases it. */
let pibs = 0;
let answering = true;
let hold: Promise<void> | null = null;
function serveSofia(): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			if (url.endsWith('/sofia/session')) {
				return new Response(JSON.stringify({ session: 'S1' }));
			}
			pibs++;
			if (hold) {
				await hold;
			}
			if (!answering) {
				return new Response('busy', { status: 429 });
			}
			const status = JSON.stringify({ nbNotams: 1, listnotams: { Other: { g: [NOTAM] } } });
			return new Response(JSON.stringify({ 'status.message': status }));
		}),
	);
}

/** Let `ms` pass, the run's promises and the effects settling on the way. */
async function pass(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	flushSync();
	await vi.advanceTimersByTimeAsync(0);
}

/** The clock as BriefingHost runs it, the plan restored. */
function start(): () => void {
	const clock = createBriefingClock();
	const effect = mountEffect(() => clock.tick());
	briefingWatch.restored = true;
	flushSync();
	return () => {
		effect.stop();
		clock.stop();
	};
}

const proxy = autorouter.proxyUrl;
const radius = routeSettings.corridorRadiusNM;
let stop: (() => void) | null = null;
beforeAll(() => {
	installFlightScope();
});
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
	vi.setSystemTime(T);
	clearNotams();
	pibs = 0;
	answering = true;
	hold = null;
	serveSofia();
	autorouter.proxyUrl = 'https://proxy.test';
	display.autoNotams = true;
	routeSettings.corridorRadiusNM = 15;
	routes.list = [plan()];
	flightPrep.dossier.flightDate = '2026-11-25';
	flightPrep.dossier.departureTime = null;
	flightPrep.perf.manualIcaos = [];
	Object.assign(briefingRun, { running: false, lastMs: null, failures: 0, failedMs: null, left: null });
	Object.assign(briefingWatch, { online: true, visible: true, restored: false, planSince: 0, folded: null });
});
afterEach(() => {
	stop?.();
	stop = null;
	vi.useRealTimers();
	vi.unstubAllGlobals();
	autorouter.proxyUrl = proxy;
	routeSettings.corridorRadiusNM = radius;
	routes.list = [];
	clearNotams();
});

describe('the automatic briefing’s clock', () => {
	it('fetches once at a boot with a stored plan, and a covering briefing asks nothing more', async () => {
		stop = start();
		await pass(0);
		expect(pibs).toBe(1);
		await pass(30 * MIN);
		expect(pibs).toBe(1);
	});

	it('waits for an edited plan to hold still 15 s', async () => {
		stop = start();
		await pass(3 * MIN);
		routes.list = [plan(2)];
		await pass(14 * S);
		expect(pibs).toBe(1);
		await pass(1 * S);
		expect(pibs).toBe(2);
	});

	it('runs once for a burst of edits, 15 s after the last', async () => {
		stop = start();
		await pass(3 * MIN);
		for (const nm of [2, 4, 6]) {
			routes.list = [plan(nm)];
			await pass(5 * S);
		}
		expect(pibs).toBe(1);
		await pass(9 * S);
		expect(pibs).toBe(1);
		await pass(1 * S);
		expect(pibs).toBe(2);
		await pass(10 * MIN);
		expect(pibs).toBe(2);
	});

	it('waits a minute after a failed run', async () => {
		answering = false;
		stop = start();
		await pass(0);
		expect(pibs).toBe(1);
		answering = true;
		await pass(59 * S);
		expect(pibs).toBe(1);
		await pass(1 * S);
		expect(pibs).toBe(2);
	});

	it('runs an edit made during a run as soon as that run ends', async () => {
		let release = (): void => {};
		hold = new Promise<void>((r) => (release = r));
		stop = start();
		await pass(0);
		expect(pibs).toBe(1);
		routes.list = [plan(2)];
		// Due once the plan holds still and the spacing has passed, the run
		// still going.
		await pass(3 * MIN);
		expect(pibs).toBe(1);
		hold = null;
		release();
		await pass(0);
		expect(pibs).toBe(2);
	});

	it('waits for the page to be online', async () => {
		briefingWatch.online = false;
		stop = start();
		await pass(10 * MIN);
		expect(pibs).toBe(0);
		briefingWatch.online = true;
		await pass(0);
		expect(pibs).toBe(1);
	});

	it('fetches nothing with the switch off', async () => {
		display.autoNotams = false;
		stop = start();
		await pass(10 * MIN);
		expect(pibs).toBe(0);
	});
});
