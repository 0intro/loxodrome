/* The TEMSI / WINTEM catalog transport (src/lib/sofia/charts.ts
 * fetchSofiaCharts / fetchSofiaChartsRetrying): every failure reaches the
 * pilot with its cause, the budget outlasts the worker's (a 15 s budget lost
 * both charts of a printed dossier while SOFIA answered in 0.2 s), and the
 * one retry follows the briefing's rules. Fake timers drive the budget and
 * the retry pause; AbortSignal.timeout is asked of the faked clock (the
 * tests/radarFrameFetch.spec.ts shim). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chartsRequestBody, fetchSofiaCharts, fetchSofiaChartsRetrying } from '$lib/sofia/charts';
import { SofiaError } from '$lib/sofia/failure';

const PROXY = 'https://proxy.test';

const CATALOG = {
	zones: [
		{
			id: 'FRANCE',
			name: 'FRANCE',
			temsi: [
				{
					type: 'TEMSI',
					level: 'FL20-150',
					zone: 'FRANCE',
					date: '01 10 2026 12:00',
					deadline: '12 UTC',
					link: '/FR/aviation/affiche_image.php?login=TOKEN&layer=sigwx/fr/france&echeance=20261001120000',
				},
			],
		},
	],
};

function ok(): Response {
	return new Response(JSON.stringify({ 'status.message': JSON.stringify(CATALOG) }), { status: 200 });
}

/** A request that never answers until its signal aborts. */
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

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
		const c = new AbortController();
		setTimeout(() => c.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
		return c.signal;
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function failureOf(p: Promise<unknown>): Promise<SofiaError> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(SofiaError);
		return e as SofiaError;
	}
	throw new Error('expected a SofiaError');
}

describe('fetchSofiaCharts', () => {
	it('posts the catalog operation, with the session when it has one', async () => {
		const fetchMock = vi.fn(() => Promise.resolve(ok()));
		vi.stubGlobal('fetch', fetchMock);
		const charts = await fetchSofiaCharts(PROXY, 'TEMSI', 'FRANCE', { session: 'ABC.1' });
		expect(charts.map((c) => c.deadline)).toEqual(['12 UTC']);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${PROXY}/sofia?session=ABC.1`);
		expect(init.method).toBe('POST');
		expect(init.body).toBe(chartsRequestBody('TEMSI', 'FRANCE'));
		await fetchSofiaCharts(PROXY, 'TEMSI', 'FRANCE');
		expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe(`${PROXY}/sofia`);
	});

	it('waits out the worker, and only then calls it a timeout', async () => {
		vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => stalled(init)));
		const p = failureOf(fetchSofiaCharts(PROXY, 'TEMSI', 'FRANCE'));
		let settled = false;
		void p.then(() => (settled = true));
		// The worker may spend 10 s on the handshake and 35 s on SOFIA.
		await vi.advanceTimersByTimeAsync(45_500);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(5_000);
		const e = await p;
		expect(e.failure.code).toBe('timeout');
		expect(e.failure.detail).toBe('SOFIA chart catalog timed out: signal timed out');
	});

	it('keeps the proxy’s refusal with its status and body', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve(new Response('ceiling reached', { status: 429, headers: { 'Retry-After': '20' } })),
			),
		);
		const busy = await failureOf(fetchSofiaCharts(PROXY, 'WINTEM', 'FRANCE'));
		expect(busy.failure).toEqual({
			code: 'busy',
			detail: 'SOFIA fetch failed: HTTP 429: ceiling reached',
			retryAfterS: 20,
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(new Response('upstream error: reset', { status: 502 }))),
		);
		const up = await failureOf(fetchSofiaCharts(PROXY, 'WINTEM', 'FRANCE'));
		expect(up.failure.code).toBe('upstream');
		expect(up.failure.detail).toContain('upstream error: reset');
	});

	it('reads a 200 that is not JSON as malformed, and SOFIA’s own error as a refusal', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<html>portal</html>', { status: 200 }))));
		expect((await failureOf(fetchSofiaCharts(PROXY, 'TEMSI', 'FRANCE'))).failure.code).toBe('malformed');
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve(
					new Response(JSON.stringify({ 'status.message': 'Erreur serveur' }), { status: 200 }),
				),
			),
		);
		const refused = await failureOf(fetchSofiaCharts(PROXY, 'TEMSI', 'FRANCE'));
		expect(refused.failure).toEqual({ code: 'refused', detail: 'SOFIA: Erreur serveur' });
	});
});

describe('fetchSofiaChartsRetrying', () => {
	it('tries a transport failure once more, 4 s later and without the session', async () => {
		const at: number[] = [];
		const urls: string[] = [];
		const fetchMock = vi.fn((url: string) => {
			at.push(Date.now());
			urls.push(url);
			return at.length === 1
				? Promise.resolve(new Response('upstream error', { status: 502 }))
				: Promise.resolve(ok());
		});
		vi.stubGlobal('fetch', fetchMock);
		const p = fetchSofiaChartsRetrying(PROXY, 'TEMSI', 'FRANCE', { session: 'S1' });
		await vi.advanceTimersByTimeAsync(4_000);
		expect((await p).length).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(urls).toEqual([`${PROXY}/sofia?session=S1`, `${PROXY}/sofia`]);
		expect(at[1] - at[0]).toBe(4_000);
	});

	it('never asks again what the proxy turned away', async () => {
		const fetchMock = vi.fn(() => Promise.resolve(new Response('busy', { status: 429 })));
		vi.stubGlobal('fetch', fetchMock);
		const e = await failureOf(fetchSofiaChartsRetrying(PROXY, 'TEMSI', 'FRANCE'));
		expect(e.failure.code).toBe('busy');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('reports the retry’s explained refusal over the first attempt’s timeout', async () => {
		let n = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) =>
				++n === 1
					? stalled(init)
					: Promise.resolve(
							new Response(JSON.stringify({ 'status.message': 'Erreur serveur' }), { status: 200 }),
						),
			),
		);
		const p = failureOf(fetchSofiaChartsRetrying(PROXY, 'TEMSI', 'FRANCE'));
		await vi.advanceTimersByTimeAsync(60_000);
		expect((await p).failure.code).toBe('refused');
	});

	it('spends no retry when the run says so', async () => {
		const fetchMock = vi.fn(() => Promise.resolve(new Response('upstream error', { status: 502 })));
		vi.stubGlobal('fetch', fetchMock);
		const e = await failureOf(fetchSofiaChartsRetrying(PROXY, 'TEMSI', 'FRANCE', { maxRetries: 0 }));
		expect(e.failure.code).toBe('upstream');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('stops at a cancel during the pause, without a second request landing', async () => {
		const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
			init?.signal?.aborted
				? Promise.reject(new DOMException('aborted', 'AbortError'))
				: Promise.resolve(new Response('upstream error', { status: 502 })),
		);
		vi.stubGlobal('fetch', fetchMock);
		const stop = new AbortController();
		const p = failureOf(fetchSofiaChartsRetrying(PROXY, 'TEMSI', 'FRANCE', { signal: stop.signal }));
		await vi.advanceTimersByTimeAsync(1_000);
		stop.abort();
		await vi.advanceTimersByTimeAsync(10);
		const e = await p;
		expect(e.failure.code).toBe('upstream');
		// The second call, if made at all, went out already aborted.
		const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit] | undefined;
		expect(second === undefined || second[1].signal?.aborted).toBe(true);
	});
});
