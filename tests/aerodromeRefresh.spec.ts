/* The airport panel's NOTAM fetch (state/aerodromeNotams.ts): one
 * aerodrome's NOTAMs from the picker's source, put into the loaded briefing.
 *
 * Pinned here: what each source is asked (SOFIA one PIB with the ident at
 * both ends, autorouter the ident alone over 30 days), that the answer is
 * reduced to what is filed under it, the origin rule (only the source a NOTAM
 * came from can withdraw it by leaving it out: EAD is measured short of the
 * French AIS at aerodromes asked for by name), the briefing's lifecycle around
 * it, the two gates it passes (the fetch region, the route corridor), and
 * that a failure, a Stop or a briefing replaced meanwhile changes nothing.
 * The network is a stubbed fetch; the splice's own rules are
 * notamSplice.spec.ts's. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AutorouterRow } from '$lib/autorouter/client';
import { notamBlocks, parseNotams } from '$lib/notam/parser';
import { bareNotamId } from '$lib/notam/splice';
import type { Notam } from '$lib/notam/types';
import { SOFIA_DURATION_MS, type SofiaNotam } from '$lib/sofia/client';

vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/state/data.svelte')>();
	return {
		...real,
		ensureAirports: () => Promise.resolve([]),
		ensureAirspaces: () => Promise.resolve([]),
	};
});

const {
	amendBriefing,
	clearNotams,
	commitBriefing,
	filteredNotams,
	notamState,
	outOfScopeCount,
	parseInput,
} = await import('$lib/state/notam.svelte');
const { coverageOf, refreshAerodromeNotams, stopAerodromeRefresh } = await import(
	'$lib/state/aerodromeNotams'
);
const { aerodromeRefresh } = await import('$lib/state/aerodromeRefresh.svelte');
const { notamFetchBusy, notamSource, setNotamSource } = await import('$lib/state/notamSource.svelte');
const { autorouter } = await import('$lib/autorouter/state.svelte');
const { ui } = await import('$lib/state/ui.svelte');
const { planScope } = await import('$lib/state/planScope.svelte');
const { filter } = await import('$lib/state/filter.svelte');
const { display } = await import('$lib/state/display.svelte');
const { t } = await import('$lib/state/i18n.svelte');

const PROXY = 'https://proxy.test';
const LFPN = { lat: 48.75, lon: 2.11 };

/** One NOTAM as an ICAO block, filed under LFPN, active from January on. */
function notam(id: string, opts: { a?: string; traffic?: string; e?: string; q?: string } = {}): string {
	const { a = 'LFPN', traffic = 'IV', e = 'RWY 07/25 CLSD.' } = opts;
	return [
		`${id} NOTAMN`,
		`Q) ${opts.q ?? `LFFF/QMRLC/${traffic}/NBO/A/000/999/4845N00207E005`}`,
		`A) ${a} B) 2601010000 C) PERM`,
		`E) ${e}`,
	].join('\n');
}

const briefing = (...blocks: string[]): string => blocks.join('\n\n') + '\n';

/** A SOFIA record, as its PIB tree carries one. */
function sofiaNotam(number: number, opts: { itemA?: string; series?: string | null } = {}): SofiaNotam {
	return {
		id: `S${number}`,
		...(opts.series === null ? {} : { series: opts.series ?? 'A' }),
		number,
		year: 26,
		type: 'N',
		qLine: { fir: 'LFFF', code23: 'MR', code45: 'LC', traffic: 'IV', purpose: 'NBO', scope: 'A', lower: 0, upper: 999 },
		coordinates: '4845N00207E',
		radius: 5,
		itemA: opts.itemA ?? 'LFPN',
		startValidity: '2026-01-01T00:00:00Z',
		endValidity: 'PERM',
		itemE: 'RWY 07/25 CLSD.',
		multiLanguage: { itemE: 'PISTE 07/25 FERMEE.' },
	};
}

function envelope(notams: SofiaNotam[]): string {
	return JSON.stringify({
		'status.code': '200',
		'status.message': JSON.stringify({
			nbNotams: notams.length,
			listnotams: { ADDep: { code: 'LFPN', name: 'TOUSSUS', avertissements_navigation: notams } },
		}),
	});
}

const degToGarmin = (d: number): number => Math.round((d * 0x40000000) / 90);

function row(number: number, opts: { itema?: string[]; series?: string } = {}): AutorouterRow {
	return {
		series: opts.series ?? 'A',
		number,
		year: 2026,
		code23: 'MR',
		code45: 'LC',
		fir: 'LFFF',
		traffic: 'IV',
		purpose: 'NBO',
		scope: 'A',
		lower: 0,
		upper: 999,
		lat: degToGarmin(LFPN.lat),
		lon: degToGarmin(LFPN.lon),
		radius: 5,
		itema: opts.itema ?? ['LFPN'],
		iteme: 'RWY 07/25 CLSD.',
		startvalidity: 1767225600,
		endvalidity: 2147483647,
	};
}

interface Call {
	url: string;
	method: string;
	body: string;
}

/** Route every request through `handler`, recording it. */
function serve(handler: (url: string, init: RequestInit | undefined) => Promise<Response> | Response): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const body = typeof init?.body === 'string' ? init.body : '';
			calls.push({ url, method: init?.method ?? 'GET', body });
			return handler(url, init);
		}),
	);
	return calls;
}

/** SOFIA answering `notams` for the PIB, after a session. */
function sofiaAnswers(notams: SofiaNotam[]): Call[] {
	return serve((url) =>
		url.endsWith('/sofia/session')
			? new Response(JSON.stringify({ session: 'S1' }), { status: 200 })
			: new Response(envelope(notams), { status: 200 }),
	);
}

/** A request that never answers until its signal aborts, or `release` is called. */
function held(): { serve: Call[]; release: (body: string) => void } {
	let release: (body: string) => void = () => {};
	const calls = serve((url, init) => {
		if (url.endsWith('/sofia/session')) {
			return new Response(JSON.stringify({ session: 'S1' }), { status: 200 });
		}
		return new Promise<Response>((resolve, reject) => {
			release = (body) => resolve(new Response(body, { status: 200 }));
			init?.signal?.addEventListener('abort', () =>
				reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
			);
		});
	});
	return { serve: calls, release: (body) => release(body) };
}

const ids = (): string[] => notamState.notams.map((n) => n.id);
const shown = (): string[] => [...new Set(filteredNotams().map((it) => it.notam.id))];
const proxyUrl = autorouter.proxyUrl;

beforeEach(() => {
	clearNotams();
	autorouter.proxyUrl = PROXY;
	setNotamSource('sofia');
	aerodromeRefresh.error = null;
	aerodromeRefresh.errorDetail = null;
	aerodromeRefresh.errorIdent = null;
	filter.window.mode = 'now';
	filter.trafficMode = 'all';
	filter.query = '';
	filter.kind = { area: true, position: true, qualifierLine: true };
	filter.altitude.enabled = false;
	ui.detail = null;
	ui.detailBack = null;
});

afterEach(() => {
	vi.unstubAllGlobals();
	autorouter.proxyUrl = proxyUrl;
	setNotamSource('sofia');
	display.sofiaLang = 'auto';
	planScope.corridor = null;
});

describe('the SOFIA fetch', () => {
	it('asks one PIB, the ident at both ends, and keeps only what is filed under it', async () => {
		commitBriefing(briefing(notam('B0001/26', { a: 'LFPG' })), {
			source: 'sofia',
			kind: 'route',
			briefed: null,
		});
		display.sofiaLang = 'fr';
		const calls = sofiaAnswers([
			sofiaNotam(1),
			sofiaNotam(99, { itemA: 'LFPG' }),
			sofiaNotam(7, { series: null }),
		]);
		await refreshAerodromeNotams('lfpn');

		expect(calls.map((c) => c.url)).toEqual([`${PROXY}/sofia/session`, `${PROXY}/sofia?session=S1`]);
		const body = new URLSearchParams(calls[1].body);
		expect(body.getAll('route[]')).toEqual(['LFPN', 'LFPN']);
		expect(body.get('width')).toBe('15');
		expect(body.get('radiusAD')).toBe('10');

		expect(ids()).toEqual(['B0001/26', 'A0001/26']);
		expect(notamState.notams[1].fullContent).toContain('PISTE 07/25 FERMEE.');
		const record = notamState.aerodromeFetches.LFPN;
		expect(record).toMatchObject({ source: 'sofia', count: 1, withdrawn: [], unconfirmed: [], kept: [] });
		expect(record.briefed.to - record.briefed.from).toBe(SOFIA_DURATION_MS);
		expect(notamState.lastFetch).toMatchObject({ source: 'sofia', kind: 'route' });
		expect(aerodromeRefresh).toMatchObject({ fetching: null, error: null });
	});

	it('withdraws what SOFIA itself gave and no longer carries', async () => {
		commitBriefing(briefing(notam('A0001/26'), notam('A0002/26')), {
			source: 'sofia',
			kind: 'route',
			briefed: null,
		});
		sofiaAnswers([sofiaNotam(1)]);
		await refreshAerodromeNotams('LFPN');
		expect(ids()).toEqual(['A0001/26']);
		expect(notamState.aerodromeFetches.LFPN.withdrawn).toEqual(['A0002/26']);
	});

	it('keeps, unconfirmed, what another source gave or a paste brought', async () => {
		commitBriefing(briefing(notam('A0001/26'), notam('A0002/26')), {
			source: 'autorouter',
			kind: 'route',
			briefed: null,
		});
		sofiaAnswers([sofiaNotam(1)]);
		await refreshAerodromeNotams('LFPN');
		expect(ids()).toEqual(['A0001/26', 'A0002/26']);
		expect(notamState.aerodromeFetches.LFPN.unconfirmed).toEqual(['A0002/26']);

		notamState.rawText = briefing(notam('A0001/26'), notam('A0003/26'));
		parseInput();
		await refreshAerodromeNotams('LFPN');
		expect(ids()).toEqual(['A0001/26', 'A0003/26']);
		expect(notamState.aerodromeFetches.LFPN.unconfirmed).toEqual(['A0003/26']);
	});
});

describe('the autorouter fetch', () => {
	it('asks for the aerodrome alone over the next 30 days', async () => {
		setNotamSource('autorouter');
		const calls = serve(
			() => new Response(JSON.stringify({ total: 3, rows: [row(1), row(2, { itema: ['LFPG'] }), row(3, { series: '' })] }), { status: 200 }),
		);
		await refreshAerodromeNotams('LFPN');
		const url = new URL(calls[0].url);
		expect(url.pathname).toBe('/notam');
		expect(JSON.parse(url.searchParams.get('itemas') ?? '')).toEqual(['LFPN']);
		const span = Number(url.searchParams.get('endvalidity')) - Number(url.searchParams.get('startvalidity'));
		expect(span).toBe(30 * 86400);
		// Filed under another aerodrome, or rebuilt without a header: left out.
		expect(ids()).toEqual(['A0001/26']);
		expect(notamState.aerodromeFetches.LFPN).toMatchObject({ source: 'autorouter', count: 1 });
	});
});

describe('the briefing around it', () => {
	it("keeps the briefing's own provenance, and only a fresh briefing drops the aerodrome's", async () => {
		commitBriefing(briefing(notam('B0001/26', { a: 'LFPG' })), {
			source: 'sofia',
			kind: 'route',
			briefed: null,
			gaps: { total: 2, routes: [{ label: 'LFPL-LFPK', cause: 'timeout', detail: 'x' }] },
			fetchScope: { kind: 'bbox', bbox: { minLat: 40, minLon: -5, maxLat: 52, maxLon: 9 } },
		});
		const before = { lastFetch: notamState.lastFetch, gaps: notamState.gaps, fetchScope: notamState.fetchScope };
		sofiaAnswers([sofiaNotam(1)]);
		await refreshAerodromeNotams('LFPN');
		expect({ lastFetch: notamState.lastFetch, gaps: notamState.gaps, fetchScope: notamState.fetchScope }).toEqual(before);
		expect(Object.keys(notamState.aerodromeFetches)).toEqual(['LFPN']);

		parseInput({ reparse: true });
		expect(Object.keys(notamState.aerodromeFetches)).toEqual(['LFPN']);
		expect(ids()).toEqual(['B0001/26', 'A0001/26']);

		parseInput();
		expect(notamState.aerodromeFetches).toEqual({});
		await refreshAerodromeNotams('LFPN');
		commitBriefing(briefing(notam('B0001/26', { a: 'LFPG' })), { source: 'sofia', kind: 'route', briefed: null });
		expect(notamState.aerodromeFetches).toEqual({});
		await refreshAerodromeNotams('LFPN');
		clearNotams();
		expect(notamState.aerodromeFetches).toEqual({});
	});

	it('keeps the airport panel open and a NOTAM back target on its own NOTAM', async () => {
		commitBriefing(briefing(notam('A0002/26'), notam('B0001/26', { a: 'LFPG' })), {
			source: 'sofia',
			kind: 'route',
			briefed: null,
		});
		ui.detail = { kind: 'airport', id: 'LFPN' };
		ui.detailBack = { kind: 'notam', index: 1 };
		sofiaAnswers([sofiaNotam(1)]);
		await refreshAerodromeNotams('LFPN');
		// A0002 withdrawn ahead of it, B0001 moved up: the back target follows.
		expect(ids()).toEqual(['B0001/26', 'A0001/26']);
		expect(ui.detail).toEqual({ kind: 'airport', id: 'LFPN' });
		expect(ui.detailBack).toEqual({ kind: 'notam', index: 0 });
	});

	// Parses the 12 MB world briefing twice.
	it("drops a back target whose NOTAM is withdrawn, never moving it onto another State's of that number", { timeout: 60_000 }, () => {
		const worldFr = readFileSync(new URL('./fixtures/world-fr-20260610.txt', import.meta.url), 'utf8');
		commitBriefing(worldFr, { source: 'autorouter', kind: 'route', briefed: null });
		const lfpo = notamState.notams.findIndex((n) => n.id === 'A0958/26' && n.icaoCodes[0] === 'LFPO');
		expect(lfpo).toBeGreaterThanOrEqual(0);
		ui.detail = { kind: 'airport', id: 'LFPO' };
		ui.detailBack = { kind: 'notam', index: lfpo };
		const answer = notamBlocks(worldFr)
			.filter((b) => /(?:^|\s)A\)\s*LFPO\b/.test(b.content) && bareNotamId(b.id) !== 'A0958/26')
			.map((b) => worldFr.slice(b.start, b.end));
		amendBriefing('LFPO', answer, { source: 'autorouter', at: Date.now(), briefed: { from: 0, to: Date.now() + 86400e3 * 365 } }, () => true);
		expect(notamState.aerodromeFetches.LFPO.withdrawn).toEqual(['A0958/26']);
		// Salzburg's A0958/26 now carries the bare id; the back target is gone, not moved.
		expect(notamState.notams.some((n) => n.id === 'A0958/26' && n.icaoCodes[0] === 'LOWS')).toBe(true);
		expect(ui.detailBack).toBeNull();
		expect(ui.detail).toEqual({ kind: 'airport', id: 'LFPO' });
	});

	it('leaves an edit not yet displayed in the paste box', async () => {
		commitBriefing(briefing(notam('B0001/26', { a: 'LFPG' })), { source: 'sofia', kind: 'route', briefed: null });
		notamState.rawText = 'A DRAFT NOBODY DISPLAYED';
		sofiaAnswers([sofiaNotam(1)]);
		await refreshAerodromeNotams('LFPN');
		expect(notamState.rawText).toBe('A DRAFT NOBODY DISPLAYED');
		expect(ids()).toEqual(['B0001/26', 'A0001/26']);
	});
});

describe('the gates a fetched aerodrome passes', () => {
	it("passes the briefing's fetch region, which nothing else lifts", async () => {
		commitBriefing(briefing(notam('A0001/26'), notam('B0001/26', { a: 'LFPG' })), {
			source: 'autorouter',
			kind: 'viewport',
			briefed: null,
			// A viewport over the south of France: neither Paris field is in it.
			fetchScope: { kind: 'bbox', bbox: { minLat: 42, minLon: 1, maxLat: 45, maxLon: 5 } },
		});
		expect(shown()).toEqual([]);
		expect(outOfScopeCount()).toBe(2);
		sofiaAnswers([sofiaNotam(1)]);
		await refreshAerodromeNotams('LFPN');
		expect(shown()).toEqual(['A0001/26']);
		expect(outOfScopeCount()).toBe(1);
	});

	it('passes "Show only route NOTAMs", by decision, and no content filter', async () => {
		commitBriefing(
			briefing(notam('A0001/26'), notam('A0002/26', { traffic: 'I' }), notam('B0001/26', { a: 'LFPG' }), notam('B0002/26', { a: 'LFPG' })),
			{ source: 'sofia', kind: 'route', briefed: null },
		);
		planScope.corridor = () => new Set(['B0001/26']);
		filter.trafficMode = 'vfr';
		expect(shown()).toEqual(['B0001/26']);
		sofiaAnswers([sofiaNotam(1), { ...sofiaNotam(2), qLine: { ...sofiaNotam(2).qLine, traffic: 'I' } }]);
		await refreshAerodromeNotams('LFPN');
		// LFPN's IFR-only NOTAM stays hidden by the flight rules, LFPG's other
		// NOTAM by the corridor.
		expect(shown()).toEqual(['A0001/26', 'B0001/26']);
	});
});

describe('busy, guards and failures', () => {
	it('runs one at a time, and Stop leaves the briefing as it was', async () => {
		commitBriefing(briefing(notam('A0001/26')), { source: 'sofia', kind: 'route', briefed: null });
		const parsedAt = notamState.parsedAt;
		const h = held();
		const running = refreshAerodromeNotams('LFPN');
		await vi.waitFor(() => expect(h.serve.length).toBe(2));
		expect(notamFetchBusy()).toBe(true);
		expect(aerodromeRefresh.fetching).toBe('LFPN');
		await refreshAerodromeNotams('LFOB');
		expect(h.serve.length).toBe(2);
		stopAerodromeRefresh();
		await running;
		expect(aerodromeRefresh).toMatchObject({ fetching: null, error: null });
		expect(notamState.parsedAt).toBe(parsedAt);
		expect(notamFetchBusy()).toBe(false);
	});

	it('lets go of an answer whose briefing was cleared meanwhile', async () => {
		commitBriefing(briefing(notam('B0001/26', { a: 'LFPG' })), { source: 'sofia', kind: 'route', briefed: null });
		const h = held();
		const running = refreshAerodromeNotams('LFPN');
		await vi.waitFor(() => expect(h.serve.length).toBe(2));
		clearNotams();
		h.release(envelope([sofiaNotam(1)]));
		await running;
		expect(notamState.notams).toEqual([]);
		expect(notamState.aerodromeFetches).toEqual({});
	});

	it('says why a fetch failed and changes nothing', async () => {
		commitBriefing(briefing(notam('A0001/26')), { source: 'autorouter', kind: 'route', briefed: null });
		const text = notamState.rawText;
		const parsedAt = notamState.parsedAt;
		setNotamSource('autorouter');
		serve(() => new Response('upstream down', { status: 502 }));
		await refreshAerodromeNotams('LFPN');
		expect(aerodromeRefresh.errorIdent).toBe('LFPN');
		expect(aerodromeRefresh.error?.()).toMatch(/HTTP 502/);
		expect(notamState.rawText).toBe(text);
		expect(notamState.parsedAt).toBe(parsedAt);

		setNotamSource('sofia');
		serve((url) =>
			url.endsWith('/sofia/session')
				? new Response(JSON.stringify({ session: 'S1' }), { status: 200 })
				: new Response('rate limited', { status: 429 }),
		);
		await refreshAerodromeNotams('LFPN');
		expect(aerodromeRefresh.error?.()).toBe(t.errors.sofiaCause.busy);
		expect(aerodromeRefresh.errorDetail).toBeTruthy();
		expect(notamState.parsedAt).toBe(parsedAt);
	});

	it('refuses what it cannot ask, before asking', async () => {
		const calls = serve(() => new Response('{}', { status: 200 }));
		await refreshAerodromeNotams('LF1234');
		expect(calls).toEqual([]);

		autorouter.proxyUrl = '';
		await refreshAerodromeNotams('LFPN');
		expect(aerodromeRefresh.error?.()).toBe(t.errors.proxyNotConfigured);
		autorouter.proxyUrl = PROXY;

		filter.window.mode = 'custom';
		filter.window.fromDate = '2020-01-01';
		filter.window.fromTime = '00:00';
		filter.window.toDate = '2020-01-02';
		filter.window.toTime = '00:00';
		await refreshAerodromeNotams('LFPN');
		expect(aerodromeRefresh.error?.()).toBe(t.errors.sofiaPeriodPast);
		expect(calls).toEqual([]);
		expect(notamSource.source).toBe('sofia');
	});
});

describe('what each source speaks for', () => {
	// SOFIA's own window on the corpus' Friday night: 22:18Z to Saturday 22:17Z.
	const briefed = { from: Date.parse('2026-09-18T22:18:00Z'), to: Date.parse('2026-09-19T22:17:00Z') };
	const entry = (text: string): Notam => {
		const [n] = parseNotams(text);
		expect(n).toBeDefined();
		return n;
	};
	const inForce = (id: string, q: string, a: string, b: string, c: string, d: string): Notam =>
		entry([`${id} NOTAMN`, `Q) ${q}`, `A) ${a} B) ${b} C) ${c}`, `D) ${d}`, 'E) TEXT.'].join('\n'));

	// The three NOTAMs SOFIA left out of that window, with their real D) items:
	// in force by B)/C), off by D) for the whole of it.
	const omitted = [
		inForce('B3859/26', 'LFMM/QACCD/IV/NBO/AE/000/020/4240N00252E005', 'LFMP', '2609120600', '2609251730', '12 25 0600-0630 1700-1730, 13 20 1000-1100 1730-1800, 22 1730-1800'),
		inForce('R0688/26', 'LFFF/QRTCA/IV/BO/AW/000/024/4703N00236E001', 'LFOA', '2603300600', '2610221500', 'MON-THU 0600-1500'),
		inForce('E4185/26', 'LFRR/QSFLT/IV/BO/A/000/999/4743N00243W005', 'LFRV', '2609060700', '2609201600', '06 12 20 0700-1600, 09 16 0700-1030, 08 10 15 17 1200-1600'),
	];

	it('SOFIA does not speak for a NOTAM off by its schedule; autorouter does', () => {
		for (const n of omitted) {
			expect(coverageOf('sofia', briefed)(n)).toBe(false);
			expect(coverageOf('autorouter', briefed)(n)).toBe(true);
		}
	});

	it('SOFIA speaks for an active aerodrome NOTAM, and no one can tell the rest', () => {
		const sofia = coverageOf('sofia', briefed);
		const at = (scope: string, d: string): Notam =>
			inForce('A0001/26', `LFFF/QMRLC/IV/NBO/${scope}/000/999/4845N00207E005`, 'LFPN', '2609010000', '2612312359', d);
		expect(sofia(at('A', 'DAILY 0600-1800'))).toBe(true);
		// A schedule the app cannot read.
		expect(sofia(at('A', 'WHEN THE MOON IS FULL'))).toBeNull();
		// An en-route scope filed under an aerodrome: SOFIA may select it by area.
		expect(sofia(at('E', 'DAILY 0600-1800'))).toBeNull();
		// Active only in the last half hour: inside the window, outside its guard band.
		expect(sofia(at('A', 'SAT 2145-2215'))).toBeNull();
	});
});
