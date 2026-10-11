/* A served site for the coverage and retry specs (tests/coverageExtend.spec.ts,
 * tests/coverageWatch.client.spec.ts, tests/dataRetry*.spec.ts): every sidecar
 * a publisher could be asked for, with France, Italy, Austria and the FAA
 * placed where they are and every other publisher far out of any view; the
 * airports that tell the merges apart; an empty document for every other
 * dataset. A path can be HELD, so a spec can move the area while a first load
 * is in flight, and it can FAIL, the way a network or a server does: a status,
 * a rejected fetch, a read that stalls before or during its body, a body cut
 * short, a document that does not parse, or the HTML page a portal answers.
 * The stub honours the request's abort signal like a real fetch, which is
 * what lets a stalled read be abandoned at all. */

import { vi } from 'vitest';

// [minLon, minLat, maxLon, maxLat], the order internal/aip/bbox.go writes.
const BOX: Record<string, number[]> = {
	fr: [-5.2, 41.3, 9.6, 51.1],
	it: [6.6, 36.6, 18.5, 47.1],
	at: [9.5, 46.3, 17.2, 49.1],
	faa: [-125, 24, -66, 50],
};
const ELSEWHERE = [170, -80, 171, -79];

export const PARIS = { minLat: 48.5, minLon: 2.0, maxLat: 49.1, maxLon: 2.8 };
export const FOLIGNO = { minLat: 42.8, minLon: 12.6, maxLat: 43.0, maxLon: 12.8 };
export const INNSBRUCK = { minLat: 47.1, minLon: 11.2, maxLat: 47.4, maxLon: 11.6 };
export const KANSAS = { minLat: 37.5, minLon: -98.5, maxLat: 38.5, maxLon: -97.5 };

export const AIRPORT_HEADER = {
	fields: [
		'ident', 'type', 'name', 'lat', 'lon', 'elev_ft', 'iso_country', 'municipality', 'iata',
		'runways', 'access', 'military', 'vfr', 'ifr', 'joint', 'frequencies',
	],
	runwayFields: [],
	frequencyFields: ['freq', 'unit', 'call'],
};
export const runway = (le: string, he: string) => [le, he, 3000, 60, 'ASPH', 1, null, null, null, null, null, null, null, null];
/** An airports-dataset row; `ta` is the AIXM overlays' published transition
 *  altitude (index 16, absent from the OurAirports baseline). */
export const airport = (ident: string, lat: number, lon: number, runways: unknown[], radios: unknown[] = [], ta?: number) =>
	[ident, 'small_airport', ident, lat, lon, 300, '', '', '', runways, null, false, true, false, false, radios, ...(ta === undefined ? [] : [ta])];

const SITE: Record<string, unknown> = {
	// The worldwide baseline: OurAirports' LFPL (no radios) and LIAF with the
	// one runway it lists.
	'/data/airports.json': {
		...AIRPORT_HEADER,
		rows: [airport('LFPL', 48.7233, 2.6589, [runway('06', '24')]), airport('LIAF', 42.9322, 12.7101, [runway('03', '21')])],
	},
	// The SIA's LFPL, with its tower.
	'/data/fr-airports.json': {
		...AIRPORT_HEADER,
		rows: [airport('LFPL', 48.7233, 2.6589, [runway('06', '24')], [['118.605', 'TWR', 'LOGNES TOUR']])],
	},
	// The Italian AIP's LIAF, with both of its runways.
	'/data/it-airports.json': {
		...AIRPORT_HEADER,
		rows: [airport('LIAF', 42.9322, 12.7101, [runway('03', '21'), runway('03G', '21G')])],
	},
};

/** The paths the fetch stub was asked for, in order. */
export const asked: string[] = [];

/** Every request with the clock it was made at (a fake clock makes the
 *  gaps between a path's requests exact) and the cache mode it asked for. */
export const log: { path: string; at: number; cache: RequestCache | undefined }[] = [];

/** When each request for a path was made. */
export function times(path: string): number[] {
	return log.filter((e) => e.path === path).map((e) => e.at);
}

const holds = new Map<string, Promise<void>>();

/** How a request can fail: an HTTP status; 'network', a fetch that rejects;
 *  'stall', one that never answers; 'stall-body', headers then one chunk
 *  and nothing more; 'truncate', a body that breaks off; 'bad-json', a
 *  document cut short that closes cleanly; 'html', a 200 page, which the
 *  read takes for the dev server's fallback (an absent file) under vitest,
 *  a dev build, and for a portal's page in a production one (a spec takes
 *  that road with vi.stubEnv('DEV', false) before the read is imported). */
export type Fault = number | 'network' | 'stall' | 'stall-body' | 'truncate' | 'bad-json' | 'html';

const faults = new Map<string, { queue: Fault[]; always: Fault | null }>();
const served = new Map<string, unknown>();

/** Fail the next requests for a path, one outcome each, then serve it
 *  again. The returned recover serves it at once. */
export function fail(path: string, ...outcomes: Fault[]): () => void {
	faults.set(path, { queue: [...outcomes], always: null });
	return () => {
		faults.delete(path);
	};
}

/** Fail the next n requests for a path the same way. */
export function failTimes(path: string, n: number, how: Fault): () => void {
	return fail(path, ...Array<Fault>(n).fill(how));
}

/** Fail every request for a path until the returned recover is called. */
export function failAlways(path: string, how: Fault): () => void {
	faults.set(path, { queue: [], always: how });
	return () => {
		faults.delete(path);
	};
}

/** Serve a document at a path for this case (cleared by serveCoverageSite). */
export function serve(path: string, doc: unknown): void {
	served.set(path, doc);
}

/** A body served as it is, not as JSON (an aircraft sheet's YAML). */
class RawBody {
	constructor(
		readonly text: string,
		readonly type: string,
	) {}
}

/** Serve a text file at a path for this case, typed as given. */
export function serveText(path: string, text: string, type = 'text/yaml'): void {
	served.set(path, new RawBody(text, type));
}

function nextFault(path: string): Fault | null {
	const f = faults.get(path);
	if (!f) {
		return null;
	}
	const next = f.queue.shift();
	if (next !== undefined) {
		return next;
	}
	if (f.always !== null) {
		return f.always;
	}
	faults.delete(path);
	return null;
}

/** A promise that rejects as a real fetch does when its signal aborts, and
 *  never settles otherwise. */
function abortOf(signal: AbortSignal | null | undefined): Promise<never> {
	return new Promise<never>((_, reject) => {
		if (!signal) {
			return;
		}
		if (signal.aborted) {
			reject(signal.reason as Error);
			return;
		}
		signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
	});
}

const JSON_TYPE = { 'content-type': 'application/json' };

async function faulty(how: Fault, signal: AbortSignal | null | undefined): Promise<Response> {
	if (typeof how === 'number') {
		// A status that carries no body takes none: the constructor throws
		// otherwise, and the stub would read as a network error.
		const empty = how === 204 || how === 205 || how === 304;
		return new Response(empty ? null : 'unavailable', { status: how, headers: { 'content-type': 'text/plain' } });
	}
	switch (how) {
		case 'network':
			throw new TypeError('Failed to fetch');
		case 'stall':
			return abortOf(signal);
		case 'stall-body': {
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new TextEncoder().encode('{"rows":'));
					signal?.addEventListener('abort', () => c.error(signal.reason), { once: true });
				},
			});
			return new Response(stream, { status: 200, headers: JSON_TYPE });
		}
		case 'truncate': {
			let sent = false;
			const stream = new ReadableStream<Uint8Array>({
				pull(c) {
					if (!sent) {
						sent = true;
						c.enqueue(new TextEncoder().encode('{"rows":['));
					} else {
						c.error(new TypeError('terminated'));
					}
				},
			});
			return new Response(stream, { status: 200, headers: JSON_TYPE });
		}
		case 'bad-json':
			return new Response('{"rows":', { status: 200, headers: JSON_TYPE });
		case 'html':
			return new Response('<!doctype html><title>portal</title>', {
				status: 200,
				headers: { 'content-type': 'text/html' },
			});
	}
}

/** Hold every fetch of a path until the returned release is called. */
export function hold(path: string): () => void {
	let release!: () => void;
	holds.set(
		path,
		new Promise<void>((r) => {
			release = r;
		}),
	);
	return () => {
		holds.delete(path);
		release();
	};
}

/** How many times a path was fetched. */
export function fetched(path: string): number {
	return asked.filter((p) => p === path).length;
}

function body(path: string): unknown {
	if (served.has(path)) {
		return served.get(path);
	}
	if (path.endsWith('.next.meta.json')) {
		return undefined;
	}
	const meta = /^\/data\/([a-z]+)-[a-z-]+\.meta\.json$/.exec(path);
	if (meta) {
		return { effective: '2026-01-01T00:00:00Z', bbox: BOX[meta[1]] ?? ELSEWHERE };
	}
	if (path in SITE) {
		return SITE[path];
	}
	return path.endsWith('.json') ? { fields: [], rows: [] } : undefined;
}

/** Serve the site through a fetch stub, emptying the request log and
 *  forgetting every hold, fault and per-case document. */
export function serveCoverageSite(): void {
	asked.length = 0;
	log.length = 0;
	holds.clear();
	faults.clear();
	served.clear();
	vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit): Promise<Response> => {
		const path = typeof input === 'string' ? input : input.pathname;
		const signal = init?.signal;
		asked.push(path);
		log.push({ path, at: Date.now(), cache: init?.cache });
		const held = holds.get(path);
		if (held) {
			await Promise.race([held, abortOf(signal)]);
		}
		if (signal?.aborted) {
			throw signal.reason as Error;
		}
		const how = nextFault(path);
		if (how !== null) {
			return faulty(how, signal);
		}
		const b = body(path);
		if (b instanceof RawBody) {
			return new Response(b.text, { status: 200, headers: { 'content-type': b.type } });
		}
		return b === undefined
			? new Response('not found', { status: 404 })
			: new Response(JSON.stringify(b), { status: 200, headers: JSON_TYPE });
	});
}

/** Let fire-and-forget work run to its end. */
export async function drain(): Promise<void> {
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
}

/** Resolve once a condition holds, draining between checks. */
export async function until(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !cond(); i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
	if (!cond()) {
		throw new Error('condition never held');
	}
}

/** Let pending work run for a number of event-loop turns. setImmediate, not
 *  setTimeout: a spec that fakes the timers can still settle this way. */
export async function settle(turns = 50): Promise<void> {
	for (let i = 0; i < turns; i++) {
		await new Promise<void>((r) => setImmediate(r));
	}
}

/** Resolve once a condition holds, turning the event loop on setImmediate,
 *  so it works under fake timers; gives up after ms of real time. */
export async function untilReal(cond: () => boolean, ms = 5_000): Promise<void> {
	const end = performance.now() + ms;
	while (!cond()) {
		if (performance.now() > end) {
			throw new Error('condition never held');
		}
		await new Promise<void>((r) => setImmediate(r));
	}
}
