/* The TEMSI / WINTEM catalog cache (src/lib/state/sofiaCharts.svelte.ts):
 * one session spent on both products, each product landing or failing on its
 * own, the Weather tab's TTL pacing, and what a print may take from the cache
 * (never a failure it did not see happen: one used to be re-served to every
 * print for five minutes, with no request at all). Fake timers drive the
 * pacing and the budgets; the module is re-imported per case, so its
 * in-flight bookkeeping starts empty. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/storage';

type Kind = 'session' | 'TEMSI' | 'WINTEM';
interface Call {
	kind: Kind;
	zone: string | null;
	url: string;
	at: number;
}
type Handler = (kind: Kind, zone: string | null, init?: RequestInit) => Promise<Response>;

const CATALOG = (product: 'TEMSI' | 'WINTEM'): string =>
	JSON.stringify({
		'status.message': JSON.stringify({
			zones: [
				{
					id: 'FRANCE',
					name: 'FRANCE',
					[product === 'TEMSI' ? 'temsi' : 'wintem']: [
						{
							type: product,
							level: product === 'TEMSI' ? 'FL20-150' : 'FL20-100',
							zone: 'FRANCE',
							date: '01 10 2026 12:00',
							deadline: '12 UTC',
							link: `/FR/aviation/affiche_image.php?login=T&layer=${product === 'TEMSI' ? 'sigwx/fr/france' : 'wintemp/fr/france/fl020'}&echeance=20261001120000`,
						},
					],
				},
			],
		}),
	});

const okCatalog: Handler = (kind) =>
	Promise.resolve(
		kind === 'session'
			? new Response(JSON.stringify({ session: 'S1' }), { status: 200 })
			: new Response(CATALOG(kind), { status: 200 }),
	);

function stalled(init?: RequestInit): Promise<Response> {
	return new Promise((_, reject) => {
		init?.signal?.addEventListener(
			'abort',
			() => {
				const reason: unknown = init.signal!.reason;
				reject(reason instanceof Error ? reason : new Error(String(reason)));
			},
			{ once: true },
		);
	});
}

let calls: Call[];

function stubFetch(handler: Handler): void {
	calls = [];
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init?: RequestInit) => {
			const body = typeof init?.body === 'string' ? init.body : '';
			const kind: Kind = url.endsWith('/sofia/session')
				? 'session'
				: body.includes('postTemsi')
					? 'TEMSI'
					: 'WINTEM';
			const zone = /zone=([A-Z_]+)/.exec(body)?.[1] ?? null;
			calls.push({ kind, zone, url, at: Date.now() });
			return handler(kind, zone, init);
		}),
	);
}

const posts = (): Call[] => calls.filter((c) => c.kind !== 'session');

async function load() {
	vi.resetModules();
	const m = await import('$lib/state/sofiaCharts.svelte');
	const { display } = await import('$lib/state/display.svelte');
	display.liveWeather = true;
	return { ...m, display };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(Date.parse('2026-10-01T10:47:00Z'));
	vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
		const c = new AbortController();
		setTimeout(() => c.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
		return c.signal;
	});
	vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(async () => {
	await vi.advanceTimersByTimeAsync(600_000);
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('a zone refresh', () => {
	it('spends one session on both products, paced', async () => {
		stubFetch(okCatalog);
		const m = await load();
		const p = m.sofiaChartsFor(['FRANCE'], { runStartMs: Date.now() });
		await vi.advanceTimersByTimeAsync(2_000);
		const out = await p;
		expect(calls.map((c) => c.kind)).toEqual(['session', 'TEMSI', 'WINTEM']);
		expect(posts().every((c) => c.url.endsWith('/sofia?session=S1'))).toBe(true);
		expect(calls[2].at - calls[1].at).toBe(800);
		expect(out.FRANCE?.status).toBe('ok');
		expect(out.FRANCE?.temsi.length).toBe(1);
		expect(out.FRANCE?.wintem.length).toBe(1);
	});

	it('keeps the TEMSI when the WINTEM fails, and says why the WINTEM did', async () => {
		stubFetch((kind, zone, init) =>
			kind === 'WINTEM'
				? Promise.resolve(new Response('upstream error: reset', { status: 502 }))
				: okCatalog(kind, zone, init),
		);
		const m = await load();
		const p = m.sofiaChartsFor(['FRANCE'], { runStartMs: Date.now() });
		await vi.advanceTimersByTimeAsync(10_000);
		const e = (await p).FRANCE!;
		expect(e.status).toBe('ok');
		expect(m.catalogOf(e, 'TEMSI').charts?.length).toBe(1);
		const w = m.catalogOf(e, 'WINTEM');
		expect(w.charts).toBeNull();
		expect(w.failure?.code).toBe('upstream');
		// The WINTEM was asked twice (its one retry), the TEMSI once.
		expect(posts().map((c) => c.kind)).toEqual(['TEMSI', 'WINTEM', 'WINTEM']);
	});

	it('posts without a session when the handshake fails', async () => {
		stubFetch((kind, zone, init) =>
			kind === 'session'
				? Promise.resolve(new Response('sofia session error', { status: 502 }))
				: okCatalog(kind, zone, init),
		);
		const m = await load();
		const p = m.sofiaChartsFor(['FRANCE'], { runStartMs: Date.now() });
		await vi.advanceTimersByTimeAsync(2_000);
		expect((await p).FRANCE?.status).toBe('ok');
		expect(posts().every((c) => c.url.endsWith('/sofia'))).toBe(true);
	});

	it('asks nothing while live weather is off', async () => {
		stubFetch(okCatalog);
		const m = await load();
		m.display.liveWeather = false;
		m.ensureSofiaCharts('FRANCE');
		expect(await m.sofiaChartsFor(['FRANCE'], { runStartMs: Date.now() })).toEqual({});
		expect(calls).toEqual([]);
	});
});

describe('the run breaker', () => {
	it('gives one attempt to everything after a transport failure spent its retry', async () => {
		stubFetch((kind, zone, init) => (kind === 'session' ? okCatalog(kind, zone, init) : stalled(init)));
		const m = await load();
		const p = m.sofiaChartsFor(['FRANCE', 'EUROC'], { runStartMs: Date.now() });
		await vi.advanceTimersByTimeAsync(400_000);
		const out = await p;
		// TEMSI FRANCE twice (its retry), then one attempt each.
		expect(posts().map((c) => `${c.kind} ${c.zone}`)).toEqual([
			'TEMSI FRANCE',
			'TEMSI FRANCE',
			'WINTEM FRANCE',
			'TEMSI EUROC',
			'WINTEM EUROC',
		]);
		expect(out.FRANCE?.status).toBe('error');
		expect(out.EUROC?.failures.WINTEM?.code).toBe('timeout');
	});

	it('asks nothing more once the proxy refuses as busy, and says so for each', async () => {
		stubFetch((kind, zone, init) =>
			kind === 'session'
				? okCatalog(kind, zone, init)
				: Promise.resolve(new Response('ceiling', { status: 429 })),
		);
		const m = await load();
		const p = m.sofiaChartsFor(['FRANCE', 'EUROC'], { runStartMs: Date.now() });
		await vi.advanceTimersByTimeAsync(10_000);
		const out = await p;
		expect(posts().length).toBe(1);
		expect(out.FRANCE?.failures.WINTEM?.code).toBe('busy');
		expect(out.EUROC?.failures.TEMSI?.code).toBe('busy');
	});
});

describe('the Weather tab ensure', () => {
	it('paces refreshes by the TTL, failures included', async () => {
		stubFetch(() => Promise.resolve(new Response('upstream error', { status: 502 })));
		const m = await load();
		m.ensureSofiaCharts('FRANCE');
		await vi.advanceTimersByTimeAsync(20_000);
		expect(m.sofiaCharts.byZone.FRANCE?.status).toBe('error');
		const asked = calls.length;
		m.ensureSofiaCharts('FRANCE');
		expect(calls.length).toBe(asked);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		m.ensureSofiaCharts('FRANCE');
		expect(calls.length).toBeGreaterThan(asked);
	});

	it('asks again, once, for a failure older than a gesture', async () => {
		stubFetch(() => Promise.resolve(new Response('upstream error', { status: 502 })));
		const m = await load();
		m.ensureSofiaCharts('FRANCE');
		await vi.advanceTimersByTimeAsync(20_000);
		const opened = Date.now();
		stubFetch(okCatalog);
		m.ensureSofiaCharts('FRANCE', { errorsBeforeMs: opened });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(m.sofiaCharts.byZone.FRANCE?.status).toBe('ok');
		const asked = calls.length;
		m.ensureSofiaCharts('FRANCE', { errorsBeforeMs: opened });
		expect(calls.length).toBe(asked);
	});
});

describe('what a print takes from the cache', () => {
	it('asks again for a failure from before the run', async () => {
		stubFetch(() => Promise.resolve(new Response('upstream error', { status: 502 })));
		const m = await load();
		m.ensureSofiaCharts('FRANCE');
		await vi.advanceTimersByTimeAsync(20_000);
		expect(m.sofiaCharts.byZone.FRANCE?.status).toBe('error');
		stubFetch(okCatalog);
		const p = m.sofiaChartsFor(['FRANCE'], { runStartMs: Date.now() });
		await vi.advanceTimersByTimeAsync(2_000);
		expect((await p).FRANCE?.status).toBe('ok');
		expect(posts().length).toBe(2);
	});

	it('takes a success under a minute old, and asks again past it', async () => {
		stubFetch(okCatalog);
		const m = await load();
		m.ensureSofiaCharts('FRANCE');
		await vi.advanceTimersByTimeAsync(2_000);
		stubFetch(okCatalog);
		await vi.advanceTimersByTimeAsync(30_000);
		const fresh = await m.sofiaChartsFor(['FRANCE'], { runStartMs: Date.now() });
		expect(fresh.FRANCE?.status).toBe('ok');
		expect(calls).toEqual([]);
		await vi.advanceTimersByTimeAsync(60_000);
		const p = m.sofiaChartsFor(['FRANCE'], { runStartMs: Date.now() });
		await vi.advanceTimersByTimeAsync(2_000);
		await p;
		expect(posts().length).toBe(2);
	});

	it('joins a refresh in flight, and asks once more when it began before the run and failed', async () => {
		// The Weather tab's refresh holds its first TEMSI until the print has
		// joined it, then fails throughout: its WINTEM, the last request it
		// makes, is the moment SOFIA comes back.
		let fail = true;
		let release: (() => void) | null = null;
		let held = false;
		stubFetch((kind, zone, init) => {
			if (kind === 'session' || !fail) {
				return okCatalog(kind, zone, init);
			}
			if (kind === 'TEMSI' && !held) {
				held = true;
				return new Promise((resolve) => {
					release = () => resolve(new Response('upstream error', { status: 502 }));
				});
			}
			if (kind === 'WINTEM') {
				fail = false;
			}
			return Promise.resolve(new Response('upstream error', { status: 502 }));
		});
		const m = await load();
		m.ensureSofiaCharts('FRANCE');
		await vi.advanceTimersByTimeAsync(100);
		const runStartMs = Date.now();
		const p = m.sofiaChartsFor(['FRANCE'], { runStartMs });
		await vi.advanceTimersByTimeAsync(100);
		release!();
		await vi.advanceTimersByTimeAsync(20_000);
		const out = await p;
		expect(out.FRANCE?.status).toBe('ok');
		expect(out.FRANCE!.startedAtMs).toBeGreaterThanOrEqual(runStartMs);
	});

	it('takes the run’s own failure as it stands, without asking twice', async () => {
		stubFetch(() => Promise.resolve(new Response('upstream error', { status: 502 })));
		const m = await load();
		const runStartMs = Date.now();
		const first = m.sofiaChartsFor(['FRANCE'], { runStartMs });
		await vi.advanceTimersByTimeAsync(20_000);
		await first;
		const asked = calls.length;
		const again = await m.sofiaChartsFor(['FRANCE'], { runStartMs });
		expect(again.FRANCE?.status).toBe('error');
		expect(calls.length).toBe(asked);
	});
});
