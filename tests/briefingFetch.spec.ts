/* The automatic briefing's run (state/briefingFetch.ts): the picked
 * source's route fetch, then the aerodromes asked for by name. While the
 * loaded briefing still covers the plan, an answer short of it is refused
 * and the briefing stands. After a commit, the aerodromes the pilot fetched
 * by name and the performance page's own (route ends aside) are asked
 * again, and one that gives no answer becomes a reason of the verdict.
 * SOFIA is stubbed at the fetch, so the paces run in real time. */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SofiaNotam } from '$lib/sofia/client';

vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	ensureAirports: () => Promise.resolve([]),
	ensureAirspaces: () => Promise.resolve([]),
	ensureNavaids: () => Promise.resolve([]),
}));

const { amendBriefing, clearNotams, commitBriefing, notamState, parseInput, snapshotBriefing } = await import(
	'$lib/state/notam.svelte'
);
const { briefingRun, briefingVerdictNow, briefingWanted, briefingWatch, planSignature, refreshInputNow, runFailures } =
	await import('$lib/state/briefing.svelte');
const { refreshDue } = await import('$lib/notam/briefingRefresh');
const { display } = await import('$lib/state/display.svelte');
const { notamSource } = await import('$lib/state/notamSource.svelte');
const { ensureBriefing, holdBriefingRuns, runBriefing } = await import('$lib/state/briefingFetch');
const { stopSofiaFetch } = await import('$lib/sofia/fetch');
const { installFlightScope } = await import('$lib/state/flightScope');
const { flightPrep } = await import('$lib/state/flightPrep.svelte');
const { autorouter } = await import('$lib/autorouter/state.svelte');
const { routes, routeSettings } = await import('$lib/state/route.svelte');
const { sofia } = await import('$lib/sofia/state.svelte');
import type { Route, Waypoint } from '$lib/state/route.svelte';

const PROXY = 'https://proxy.test';
const H = 3_600_000;
const T = Date.UTC(2026, 10, 24, 19, 0);
const DAY = Date.UTC(2026, 10, 25);

const ad = (id: string, lat: number, lon: number): Waypoint =>
	({ id, lat, lon, kind: 'airport', ident: id, alt: 2500, altAuto: true }) as unknown as Waypoint;
const free = (id: string, lat: number, lon: number): Waypoint =>
	({ id, lat, lon, kind: 'free', alt: 2500, altAuto: true }) as unknown as Waypoint;
const route = (id: string, waypoints: Waypoint[]): Route => ({ id, name: null, waypoints, selectedWaypointId: null });

const R1 = route('r1', [ad('LFPN', 48.75194, 2.10611), ad('LFOZ', 47.89694, 2.16333)]);
// No aerodrome to anchor on: SOFIA is never asked, the route is lost.
const R2 = route('r2', [free('x', 48.5, 2.5), free('y', 48.2, 2.9)]);

function record(number: number, itemA = 'LFFF'): SofiaNotam {
	return {
		id: `S${number}`,
		series: 'W',
		number,
		year: 26,
		type: 'N',
		qLine: { fir: 'LFFF', code23: 'WP', code45: 'LW', traffic: 'IV', purpose: 'BO', scope: 'W', lower: 0, upper: 115 },
		coordinates: '4826N00209E',
		radius: 3,
		itemA,
		startValidity: '2026-01-01T00:00:00Z',
		endValidity: 'PERM',
		itemE: 'PJE WI 3NM ETAMPES.',
	};
}

/** SOFIA by route: each PIB answers what `answers` gives its first token,
 *  a 429 for null. Every request is logged by its tokens. */
let answers: Record<string, SofiaNotam[] | null> = {};
let asked: string[] = [];
function serveSofia(): void {
	vi.stubGlobal(
		'fetch',
		vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			if (url.endsWith('/sofia/session')) {
				return Promise.resolve(new Response(JSON.stringify({ session: 'S1' })));
			}
			const body = init?.body;
			const tokens = new URLSearchParams(typeof body === 'string' || body instanceof URLSearchParams ? body : '').getAll(
				'route[]',
			);
			asked.push(tokens.join(','));
			const list = answers[tokens[0] ?? ''];
			if (list === null || list === undefined) {
				return Promise.resolve(new Response('busy', { status: 429 }));
			}
			const status = JSON.stringify({ nbNotams: list.length, listnotams: { Other: { g: list } } });
			return Promise.resolve(new Response(JSON.stringify({ 'status.message': status })));
		}),
	);
}

/** A route briefing of `tracks`, every one landed, fetched `ageH` ago. */
function briefed(tracks: Route[], ageH: number): void {
	vi.setSystemTime(T - ageH * H);
	commitBriefing(
		['W0001/26 NOTAMN', 'Q) LFFF/QWPLW/IV/BO/W/000/115/4826N00209E003', 'A) LFFF B) 2601010000 C) PERM', 'E) PJE.'].join('\n'),
		{
			source: 'sofia',
			kind: 'route',
			briefed: { from: DAY, to: DAY + 24 * H - 60_000 },
			asked: {
				region: {
					kind: 'tracks',
					tracks: tracks.map((r) => ({
						label: '?',
						path: r.waypoints.map((w) => ({ lat: w.lat, lon: w.lon })),
						landed: true,
						ends: ['LFPN', 'LFOZ'],
					})),
					halfWidthNM: 15.3,
				},
				aim: 'flight',
			},
		},
	);
	vi.setSystemTime(T);
}

const proxy = autorouter.proxyUrl;
const radius = routeSettings.corridorRadiusNM;
beforeAll(() => {
	installFlightScope();
});
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T);
	clearNotams();
	answers = { LFPN: [record(3001)] };
	asked = [];
	serveSofia();
	autorouter.proxyUrl = PROXY;
	routeSettings.corridorRadiusNM = 15;
	routes.list = [R1];
	flightPrep.dossier.flightDate = '2026-11-25';
	flightPrep.dossier.departureTime = null;
	flightPrep.perf.manualIcaos = [];
	Object.assign(briefingRun, { running: false, lastMs: null, failures: 0, failedMs: null, left: null });
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	autorouter.proxyUrl = proxy;
	routeSettings.corridorRadiusNM = radius;
	routes.list = [];
	flightPrep.dossier.flightDate = null;
	flightPrep.perf.manualIcaos = [];
});

describe('the route fetch', () => {
	it('briefs a plan with none, and records what it left standing', async () => {
		expect(await runBriefing()).toBe('committed');
		expect(notamState.lastFetch?.at).toBe(T);
		expect(briefingRun).toMatchObject({ failures: 0, left: { day: '2026-11-24', source: 'sofia', codes: [] } });
	});

	it('records the plan it fetched for, a plan edited meanwhile being one to fetch again', async () => {
		const before = planSignature();
		const run = runBriefing();
		routes.list = [route('r1', [ad('LFPN', 48.75194, 2.10611), ad('LFOB', 49.45, 2.11)])];
		expect(await run).toBe('committed');
		expect(planSignature()).not.toBe(before);
		expect(briefingRun.left?.sig).toBe(before);
		expect(briefingVerdictNow().reasons.map((r) => r.code)).toContain('route');
	});

	it('says why it refuses an empty answer over a covering briefing', { timeout: 20_000 }, async () => {
		briefed([R1], 4);
		answers = { LFPN: [] };
		expect(await runBriefing()).toBe('refused');
		expect(notamState.lastFetch?.at).toBe(T - 4 * H);
		expect(sofia.error?.()).toBe('The answer held no NOTAM, so the briefing loaded stands.');
	});

	it('refuses a lost route while the loaded briefing covers the plan', { timeout: 20_000 }, async () => {
		routes.list = [R1, R2];
		briefed([R1, R2], 4);
		expect(briefingVerdictNow().reasons.map((r) => r.code)).toEqual(['age']);
		expect(await runBriefing()).toBe('refused');
		expect(notamState.lastFetch?.at).toBe(T - 4 * H);
		expect(briefingRun).toMatchObject({ failures: 1, failedMs: T });
		// The notice's row says why: the lost route's cause.
		expect(sofia.error).not.toBeNull();
	});

	it('takes the same answer once the route has changed', { timeout: 20_000 }, async () => {
		routes.list = [R1, R2];
		briefed([route('r1', [ad('LFPN', 48.75194, 2.10611), ad('LFOB', 49.45, 2.11)]), R2], 1);
		expect(briefingVerdictNow().reasons.map((r) => r.code)).toContain('route');
		expect(await runBriefing()).toBe('committed');
		expect(notamState.lastFetch?.at).toBe(T);
		expect(notamState.gaps?.routes.map((g) => g.cause)).toEqual(['noAerodrome']);
	});
});

describe('the aerodromes by name', () => {
	it('asks again for those fetched from their panel and the performance page’s own, route ends aside', { timeout: 20_000 }, async () => {
		briefed([R1], 4);
		amendBriefing('LFPT', [], { source: 'sofia', at: T - 4 * H, briefed: { from: DAY, to: DAY + 24 * H } }, () => true);
		flightPrep.perf.manualIcaos = ['LFOX', 'LFOZ'];
		answers.LFPT = [record(3002, 'LFPT')];
		answers.LFOX = null;
		expect(await runBriefing()).toBe('committed');
		expect(asked).toEqual(['LFPN,LFOZ', 'LFPT,LFPT', 'LFOX,LFOX']);
		expect(notamState.aerodromeFetches.LFPT?.at).toBe(T);
		expect(notamState.aerodromeFetches.LFOX).toBeUndefined();
		// The one that gave no answer is a reason of the verdict.
		expect(briefingVerdictNow().reasons).toContainEqual({ code: 'aerodromes', idents: ['LFOX'] });
	});

	const byName = (id: string) =>
		amendBriefing(id, [], { source: 'sofia', at: T - H, briefed: { from: DAY, to: DAY + 24 * H } }, () => true);

	it('owes what a fetch outside a run dropped, and asks it by name alone', { timeout: 20_000 }, async () => {
		briefed([R1], 1);
		byName('LFPT');
		// The fetch view's own fetch commits outside a run.
		briefed([R1], 0);
		expect(briefingVerdictNow().reasons).toEqual([{ code: 'aerodromes', idents: ['LFPT'] }]);
		answers.LFPT = [record(3002, 'LFPT')];
		expect(await ensureBriefing()).toBe('committed');
		expect(asked).toEqual(['LFPT,LFPT']);
		expect(briefingVerdictNow().reasons).toEqual([]);
	});

	it('owes the performance page’s aerodrome added after the briefing', { timeout: 20_000 }, async () => {
		briefed([R1], 0);
		expect(briefingVerdictNow().reasons).toEqual([]);
		flightPrep.perf.manualIcaos = ['LFOX'];
		expect(briefingVerdictNow().reasons).toEqual([{ code: 'aerodromes', idents: ['LFOX'] }]);
		answers.LFOX = [record(3003, 'LFOX')];
		expect(await ensureBriefing()).toBe('committed');
		expect(asked).toEqual(['LFOX,LFOX']);
		expect(briefingVerdictNow().reasons).toEqual([]);
	});

	it('owes the aerodromes past what one run asks', { timeout: 60_000 }, async () => {
		briefed([R1], 4);
		const idents = ['LFOA', 'LFOB', 'LFOC', 'LFOD', 'LFOE', 'LFOF', 'LFOG', 'LFOH', 'LFOI'];
		flightPrep.perf.manualIcaos = idents;
		idents.forEach((id, i) => (answers[id] = [record(4000 + i, id)]));
		expect(await runBriefing()).toBe('committed');
		expect(asked.length).toBe(9);
		expect(briefingVerdictNow().reasons).toContainEqual({ code: 'aerodromes', idents: ['LFOI'] });
	});

	it('records what it owes by name from its commit on', { timeout: 20_000 }, async () => {
		briefed([R1], 4);
		byName('LFPT');
		answers.LFPT = [record(3002, 'LFPT')];
		const run = runBriefing();
		// The commit, once SOFIA's pace since the last case allows the POST.
		await vi.waitFor(() => expect(notamState.lastFetch?.at ?? 0).toBeGreaterThanOrEqual(T), { timeout: 10_000 });
		// The aerodromes are asked after a pace: a record kept now owes LFPT.
		expect(snapshotBriefing()?.aerodromesMissed).toEqual(['LFPT']);
		expect(await run).toBe('committed');
		expect(notamState.aerodromesMissed).toEqual([]);
	});

	it('judges what it leaves standing at its commit', { timeout: 20_000 }, async () => {
		briefed([R1], 4);
		byName('LFPT');
		answers.LFPT = [record(3002, 'LFPT')];
		const run = runBriefing();
		// The commit, once SOFIA's pace since the last case allows the POST.
		await vi.waitFor(() => expect(notamState.lastFetch?.at ?? 0).toBeGreaterThanOrEqual(T), { timeout: 10_000 });
		// A Clear while the aerodromes are asked takes the briefing the run
		// would record on.
		clearNotams();
		await run;
		expect(briefingRun.left?.codes ?? []).not.toContain('none');
	});
});

describe('what no fetch by the picked source cures', () => {
	const due = () => refreshDue(refreshInputNow(Date.now(), null)).due;
	beforeEach(() => {
		notamSource.source = 'sofia';
		display.autoNotams = true;
		Object.assign(briefingWatch, { online: true, visible: true, restored: true, planSince: 0 });
	});
	afterEach(() => {
		briefingWatch.restored = false;
	});

	it('refreshes a covering briefing only with a source that briefs every route whole', () => {
		routes.list = [R1, R2];
		briefed([R1, R2], 4);
		expect(briefingVerdictNow().reasons.map((r) => r.code)).toEqual(['age']);
		// SOFIA has no aerodrome on R2 to anchor on: its answer would be refused.
		expect(due()).toBe(false);
		routes.list = [R1];
		briefed([R1], 4);
		expect(due()).toBe(true);
	});

	it('holds the runs after the pilot’s Stop, counting no failure', async () => {
		const run = runBriefing();
		stopSofiaFetch();
		expect(await run).toBe('stopped');
		expect(briefingRun.failures).toBe(0);
		vi.setSystemTime(T + 5 * 60_000);
		expect(due()).toBe(false);
		routes.list = [route('r1', [ad('LFPN', 48.75194, 2.10611), ad('LFOB', 49.45, 2.11)])];
		expect(due()).toBe(true);
	});

	it('holds the runs after the pilot’s Clear', () => {
		briefed([R1], 0);
		clearNotams();
		holdBriefingRuns();
		vi.setSystemTime(T + 5 * 60_000);
		expect(briefingVerdictNow().reasons.map((r) => r.code)).toEqual(['none']);
		expect(due()).toBe(false);
	});

	it('leaves to the pilot a period past what the source briefs, and a route it cannot anchor', () => {
		routes.list = [R1, R2];
		const v = (r: import('$lib/notam/briefingVerdict').BriefingReason) => ({
			plan: true,
			source: 'fetch' as const,
			at: T,
			reasons: [r],
		});
		const period = (days: number) => ({ code: 'period' as const, briefed: { from: DAY, to: DAY + 24 * H }, span: { from: DAY, to: DAY + days * 24 * H } });
		briefed([R1, R2], 0);
		expect(briefingWanted(T, v(period(2)))).toBe(true);
		expect(briefingWanted(T, v(period(5)))).toBe(false);
		expect(briefingWanted(T, v({ code: 'failed', labels: ['?'], total: 2 }))).toBe(false);
		expect(briefingWanted(T, v({ code: 'failed', labels: ['LFPN-LFOZ'], total: 2 }))).toBe(true);
	});
});

describe('the paste box', () => {
	const TYPED = ['W0009/26 NOTAMN', 'Q) LFFF/QWPLW/IV/BO/W/000/115/4826N00209E003', 'A) LFFF B) 2601010000 C) PERM', 'E) PJE.'].join('\n');

	it('keeps a paste not yet displayed when a fetch commits, and takes the fetch while it shows the loaded text', () => {
		briefed([R1], 1);
		const loaded = notamState.rawText;
		notamState.rawText = TYPED;
		briefed([R1], 0);
		expect(notamState.rawText).toBe(TYPED);
		expect(notamState.lastFetch?.at).toBe(T);
		notamState.rawText = loaded;
		briefed([R1], 0);
		expect(notamState.rawText).toBe(loaded);
	});

	it('keeps the fetch when Display on map shows its own text again', () => {
		briefed([R1], 1);
		parseInput();
		expect(notamState.lastFetch?.at).toBe(T - H);
		expect(notamState.byHand).toBeNull();
	});
});

describe('the failures of the runs', () => {
	it('count none once a fetch committed after the last, the pilot’s own included', { timeout: 20_000 }, async () => {
		answers = { LFPN: null };
		expect(await runBriefing()).toBe('failed');
		expect(runFailures()).toBe(1);
		// The fetch view's own fetch, a minute later.
		briefed([R1], -1 / 60);
		expect(runFailures()).toBe(0);
	});
});

describe('the briefing a print or the Fly tap needs', () => {
	it('runs only when the app may replace it and the verdict holds a reason', async () => {
		briefed([R1], 0);
		expect(await ensureBriefing()).toBe('skipped');
		// A bulletin by hand: the box edited, then displayed.
		notamState.rawText = `${notamState.rawText}\n`;
		parseInput();
		vi.setSystemTime(T + 5 * H);
		expect(briefingVerdictNow().reasons.map((r) => r.code)).toContain('age');
		expect(await ensureBriefing()).toBe('skipped');
		expect(asked).toEqual([]);
	});

	it('waits for a run going on, then runs again while the verdict still wants one', { timeout: 20_000 }, async () => {
		answers = { LFPN: null };
		const first = runBriefing();
		const gesture = ensureBriefing();
		expect(await first).toBe('failed');
		answers = { LFPN: [record(3001)] };
		expect(await gesture).toBe('committed');
		expect(notamState.lastFetch?.at).toBe(T);
	});
});

describe('a run beside the pilot', () => {
	it('leaves a bulletin pasted during it, and counts no failure', async () => {
		const run = runBriefing();
		notamState.rawText = ['W0002/26 NOTAMN', 'Q) LFFF/QWPLW/IV/BO/W/000/115/4826N00209E003', 'A) LFFF B) 2601010000 C) PERM', 'E) PJE.'].join('\n');
		parseInput();
		expect(await run).toBe('skipped');
		expect(notamState.byHand).not.toBeNull();
		expect(notamState.lastFetch).toBeNull();
		expect(briefingRun.failures).toBe(0);
	});

	it('counts no failure when another fetch is going on', async () => {
		sofia.fetching = true;
		expect(await runBriefing()).toBe('skipped');
		sofia.fetching = false;
		expect(briefingRun.failures).toBe(0);
		expect(asked).toEqual([]);
	});
});
