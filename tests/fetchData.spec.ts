/* Reading a file off /data/ (src/lib/data/fetchData.ts): what is an answer,
 * what is a failure worth asking again, and the watchdog that turns a read
 * which stalls into one.
 *
 * The idle clock is the global setTimeout, faked here with Date alone
 * beside it: the streams under the read run on microtasks, which
 * advanceTimersByTimeAsync lets run between two fake timers. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DATA_IDLE_MS,
	DataReadError,
	isTransient,
	readDataJson,
	readDataJsonSoft,
	readDataText,
} from '$lib/data/fetchData';

const URL_ = '/data/x.json';
const JSON_TYPE = { 'content-type': 'application/json' };

let signals: (AbortSignal | undefined)[] = [];

function answer(make: (signal: AbortSignal | undefined) => Response | Promise<Response>): void {
	vi.stubGlobal('fetch', (_input: string, init?: RequestInit) => {
		const signal = init?.signal ?? undefined;
		signals.push(signal);
		return Promise.resolve(make(signal));
	});
}

/** Follow a read without awaiting it, so the fake clock can move under it. */
function track<T>(p: Promise<T>): { out: () => T | DataReadError | 'pending' } {
	let out: T | DataReadError | 'pending' = 'pending';
	p.then(
		(v) => {
			out = v;
		},
		(e: DataReadError) => {
			out = e;
		},
	);
	return { out: () => out };
}

/** A body delivering one chunk at each of the given clock offsets (ms),
 *  closing after the last, on the (fake) setTimeout. */
function timedBody(atMs: number[], parts: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(c) {
			atMs.forEach((ms, i) => {
				setTimeout(() => {
					c.enqueue(new TextEncoder().encode(parts[i]));
					if (i === atMs.length - 1) {
						c.close();
					}
				}, ms);
			});
		},
	});
}

beforeEach(() => {
	signals = [];
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	expect(vi.getTimerCount()).toBe(0);
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function failure(p: Promise<unknown>): Promise<DataReadError> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(DataReadError);
		return e as DataReadError;
	}
	throw new Error('the read answered');
}

describe('an answer', () => {
	it('is the document', async () => {
		answer(() => new Response(JSON.stringify({ rows: [1] }), { headers: JSON_TYPE }));
		await expect(readDataJson(URL_)).resolves.toEqual({ rows: [1] });
		expect(signals[0]).toBeInstanceOf(AbortSignal);
	});

	it.each([404, 410])('is an absent file for a %i, never worth asking again', async (status) => {
		answer(() => new Response('gone', { status }));
		const e = await failure(readDataJson(URL_));
		expect(e).toMatchObject({ absent: true, transient: false, status });
		expect(e.message).toBe(`${URL_}: HTTP ${status}`);
	});

	it('is an absent file for the HTML the dev server falls back to', async () => {
		answer(() => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
		const e = await failure(readDataJson(URL_, { htmlIsAbsent: true }));
		expect(e).toMatchObject({ absent: true, transient: false, status: 200 });
		expect(e.message).toBe(`${URL_}: not JSON (got text/html)`);
	});

	it('is the document whatever type the server states', async () => {
		// An Android WebView before API 29 serves the APK's own .json with no
		// type at all; the body is what tells a document.
		for (const headers of [{ 'content-type': 'text/plain' }, {}]) {
			answer(() => new Response(JSON.stringify({ rows: [2] }), { headers }));
			await expect(readDataJson(URL_, { htmlIsAbsent: false })).resolves.toEqual({ rows: [2] });
		}
	});

	it('is a fact for a document that does not parse, cut short or empty', async () => {
		answer(() => new Response('{"rows":', { headers: JSON_TYPE }));
		expect(await failure(readDataJson(URL_))).toMatchObject({ transient: false, status: 200 });
		answer(() => new Response(null, { headers: JSON_TYPE }));
		expect(await failure(readDataJson(URL_))).toMatchObject({ transient: false, status: 200 });
	});

	it('reads text whatever type the server states', async () => {
		answer(() => new Response('version: 1\n', { headers: { 'content-type': 'application/octet-stream' } }));
		await expect(readDataText('/data/aircraft/a.yaml')).resolves.toBe('version: 1\n');
	});
});

describe('a failure worth asking again', () => {
	it.each([500, 502, 503, 504, 408, 429, 400, 401, 403, 407])('is a %i, any refusal but an absent file', async (status) => {
		// A server's "not now", and an intermediary's refusal (a portal's
		// 401 or 407, a firewall's 403): a static site answers its own files.
		answer(() => new Response('not now', { status }));
		const e = await failure(readDataJson(URL_));
		expect(e).toMatchObject({ transient: true, absent: false, status });
		expect(e.message).toBe(`${URL_}: HTTP ${status}`);
		expect(isTransient(e)).toBe(true);
	});

	it('is a fetch that rejects, with no status', async () => {
		vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
		const e = await failure(readDataJson(URL_));
		expect(e).toMatchObject({ transient: true, status: null });
		expect(e.message).toBe(`${URL_}: Failed to fetch`);
	});

	it('is a body that breaks off', async () => {
		let sent = false;
		answer(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(c) {
							if (!sent) {
								sent = true;
								c.enqueue(new TextEncoder().encode('{"rows":['));
							} else {
								c.error(new TypeError('terminated'));
							}
						},
					}),
					{ headers: JSON_TYPE },
				),
		);
		expect(await failure(readDataJson(URL_))).toMatchObject({ transient: true, status: 200 });
	});

	it('is a portal page in a production build, whatever type it states', async () => {
		for (const headers of [{ 'content-type': 'text/html' }, JSON_TYPE, {}]) {
			answer(() => new Response('\n  <!doctype html><title>Sign in</title>', { headers }));
			expect(await failure(readDataJson(URL_, { htmlIsAbsent: false }))).toMatchObject({
				transient: true,
				absent: false,
			});
		}
	});

	it('is a portal page where an aircraft sheet was due', async () => {
		answer(() => new Response('<html>portal</html>', { headers: { 'content-type': 'text/html' } }));
		const e = await failure(readDataText('/data/aircraft/a.yaml', { htmlIsAbsent: false }));
		expect(e).toMatchObject({ transient: true, absent: false });
		expect(e.message).toBe('/data/aircraft/a.yaml: not a data file (got text/html)');
	});

	it('is never a decode error of the loader reading it', () => {
		expect(isTransient(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
	});
});

describe('the watchdog', () => {
	it('abandons a read with no headers after the idle time', async () => {
		answer((signal) => new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason as Error))));
		const r = track(readDataJson(URL_));
		await vi.advanceTimersByTimeAsync(DATA_IDLE_MS - 1);
		expect(r.out()).toBe('pending');
		await vi.advanceTimersByTimeAsync(1);
		expect(r.out()).toMatchObject({ transient: true, status: null });
		expect((r.out() as DataReadError).message).toBe(`${URL_}: no data for 30 s`);
		expect(signals[0]?.aborted).toBe(true);
	});

	it('abandons a body that stops after one chunk', async () => {
		answer(
			(signal) =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(c) {
							c.enqueue(new TextEncoder().encode('{"rows":'));
							signal?.addEventListener('abort', () => c.error(signal.reason));
						},
					}),
					{ headers: JSON_TYPE },
				),
		);
		const r = track(readDataJson(URL_));
		await vi.advanceTimersByTimeAsync(DATA_IDLE_MS);
		expect(r.out()).toMatchObject({ transient: true, status: 200 });
	});

	it('abandons a read whose body ignores the abort', async () => {
		answer(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(c) {
							c.enqueue(new TextEncoder().encode('{"rows":'));
						},
					}),
					{ headers: JSON_TYPE },
				),
		);
		const r = track(readDataJson(URL_));
		await vi.advanceTimersByTimeAsync(DATA_IDLE_MS);
		expect(r.out()).toMatchObject({ transient: true, status: 200 });
	});

	it('lets a slow body finish, as long as it keeps coming', async () => {
		answer(
			() =>
				new Response(timedBody([20_000, 40_000, 60_000, 80_000, 100_000], ['{"ro', 'ws":', '[1,', '2', ']}']), {
					headers: JSON_TYPE,
				}),
		);
		const r = track(readDataJson(URL_));
		await vi.advanceTimersByTimeAsync(100_000);
		expect(r.out()).toEqual({ rows: [1, 2] });
		expect(signals[0]?.aborted).toBe(false);
	});

	it('restarts its clock on the headers and on every chunk', async () => {
		vi.stubGlobal('fetch', (_input: string, init?: RequestInit) => {
			signals.push(init?.signal ?? undefined);
			return new Promise<Response>((resolve) =>
				setTimeout(
					() => resolve(new Response(timedBody([25_000, 50_000], ['{"rows":', '[]}']), { headers: JSON_TYPE })),
					25_000,
				),
			);
		});
		const r = track(readDataJson(URL_));
		await vi.advanceTimersByTimeAsync(75_000);
		expect(r.out()).toEqual({ rows: [] });
	});
});

describe('the fail-soft read', () => {
	it('answers null for a file the deployment does not hold, warning', async () => {
		for (const make of [
			() => new Response('gone', { status: 404 }),
			() => new Response('gone', { status: 410 }),
			() => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
		]) {
			answer(make);
			await expect(readDataJsonSoft(URL_, { htmlIsAbsent: true })).resolves.toBeNull();
		}
		expect(console.warn).toHaveBeenCalledTimes(3);
	});

	it('rejects everything else, which an empty list would hide', async () => {
		answer(() => new Response('not now', { status: 503 }));
		expect((await failure(readDataJsonSoft(URL_))).transient).toBe(true);
		answer(() => new Response('no', { status: 403 }));
		expect((await failure(readDataJsonSoft(URL_))).transient).toBe(true);
		// A document that does not parse is a fact, and still not "nothing
		// there": the caller reads it again later, slowly.
		answer(() => new Response('{"rows":', { headers: JSON_TYPE }));
		expect((await failure(readDataJsonSoft(URL_))).transient).toBe(false);
		expect(console.warn).not.toHaveBeenCalled();
	});
});
