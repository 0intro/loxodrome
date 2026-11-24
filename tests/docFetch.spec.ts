/* Reading ONE document out of a pack over the wire.
 *
 * The pack's index sits at its head with payload-relative offsets, so three
 * ranged requests fetch one plate out of a 195 MB archive without
 * downloading it. That arithmetic is the whole mechanism, and getting it
 * wrong hands the reader a PDF that starts a few hundred bytes into the
 * previous one, so it is pinned against the same Go-written fixture the
 * local reader is: the two paths must slice the same bytes. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { docBlob, readDocPack, DOC_PACK_MAGIC } from '../src/lib/offline/docPack';
import {
	docByteRange,
	fetchDocBytes,
	parsePackHeader,
	remotePackIndex,
	resetDocFetchCache,
	type RemoteIndex,
} from '../src/lib/offline/docFetch';

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/mini-docs.pack', import.meta.url)));

function packFile(): File {
	return new File([fixture], 'mini-docs.pack');
}

/** A server that honours Range the way the worker's /archive route does. */
function rangeServer(body: Uint8Array): { fetch: typeof fetch; calls: string[] } {
	const calls: string[] = [];
	const f = ((_url: string, init?: RequestInit) => {
		const header = new Headers(init?.headers).get('Range') ?? '';
		calls.push(header);
		const m = /^bytes=(\d+)-(\d*)$/.exec(header);
		if (!m) {
			return Promise.resolve(new Response(body as unknown as BodyInit, { status: 200 }));
		}
		const start = Number(m[1]);
		const end = m[2] === '' ? body.length - 1 : Math.min(Number(m[2]), body.length - 1);
		if (start >= body.length || start > end) {
			return Promise.resolve(new Response(null, { status: 416 }));
		}
		return Promise.resolve(
			new Response(body.slice(start, end + 1) as unknown as BodyInit, {
				status: 206,
				headers: { 'Content-Range': `bytes ${start}-${end}/${body.length}` },
			}),
		);
	}) as unknown as typeof fetch;
	return { fetch: f, calls };
}

async function withFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
	const original = globalThis.fetch;
	globalThis.fetch = f;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
		resetDocFetchCache();
	}
}

describe('parsePackHeader', () => {
	it('reads the index length a Go-written pack declares', () => {
		expect(parsePackHeader(fixture.subarray(0, 12))).toBeGreaterThan(0);
	});

	it('refuses anything that is not a pack head', () => {
		// A worker answering an unknown id with an error page is a 200 with
		// a body; read as a length it would be a wild allocation.
		expect(parsePackHeader(new TextEncoder().encode('<!doctype html>'))).toBeNull();
		expect(parsePackHeader(new Uint8Array(4))).toBeNull();
		const zeroLen = new Uint8Array(12);
		zeroLen.set(new TextEncoder().encode(DOC_PACK_MAGIC), 0);
		expect(parsePackHeader(zeroLen)).toBeNull();
	});
});

describe('docByteRange', () => {
	it('turns a payload-relative entry into an absolute inclusive range', () => {
		const idx: RemoteIndex = {
			base: 100,
			index: { set: 'fr-vac', entries: { 'a.pdf': [0, 10], 'b.pdf': [10, 5] } },
		};
		// Inclusive at both ends, which is what an HTTP Range means.
		expect(docByteRange(idx, 'a.pdf')).toEqual({ start: 100, end: 109 });
		expect(docByteRange(idx, 'b.pdf')).toEqual({ start: 110, end: 114 });
		expect(docByteRange(idx, 'missing.pdf')).toBeNull();
	});

	it('refuses an entry a corrupt index could have invented', () => {
		const bad = (entry: unknown): RemoteIndex => ({
			base: 0,
			index: { set: 'x', entries: { 'a.pdf': entry as never } },
		});
		expect(docByteRange(bad([1]), 'a.pdf')).toBeNull();
		expect(docByteRange(bad([-1, 5]), 'a.pdf')).toBeNull();
		expect(docByteRange(bad([0, 0]), 'a.pdf')).toBeNull();
		expect(docByteRange(bad(['0', '5']), 'a.pdf')).toBeNull();
	});
});

describe('reading a document over the wire', () => {
	it('slices the same bytes the local reader does', async () => {
		const local = await readDocPack(packFile());
		expect(local).not.toBeNull();
		const want = new Uint8Array(await docBlob(local!, 'AD-2.LFPN.pdf')!.arrayBuffer());

		const srv = rangeServer(fixture);
		const got = await withFetch(srv.fetch, async () => {
			const bytes = await fetchDocBytes('AD-2.LFPN.pdf', [
				{ local: null, archive: 'https://example.test/fr-vac/archive' },
			]);
			return bytes ? new Uint8Array(bytes) : null;
		});
		expect(got).not.toBeNull();
		expect(Array.from(got!)).toEqual(Array.from(want));
		// The header, the index, then the payload: three small requests,
		// never the archive.
		expect(srv.calls).toHaveLength(3);
		expect(srv.calls[0]).toBe('bytes=0-11');
	});

	it('prefers a downloaded pack and asks the network for nothing', async () => {
		const local = await readDocPack(packFile());
		const srv = rangeServer(fixture);
		const got = await withFetch(srv.fetch, () =>
			fetchDocBytes('AD-2.LFPN.pdf', [
				{ local, archive: 'https://example.test/fr-vac/archive' },
			]),
		);
		expect(got).not.toBeNull();
		expect(srv.calls).toEqual([]);
	});

	it('answers null for a document no source carries', async () => {
		const srv = rangeServer(fixture);
		const got = await withFetch(srv.fetch, () =>
			fetchDocBytes('AD-2.LFZZ.pdf', [
				{ local: null, archive: 'https://example.test/fr-vac/archive' },
			]),
		);
		expect(got).toBeNull();
	});

	it('treats a server that ignores Range as no pack, rather than buffering it', async () => {
		const ignoring = (() =>
			Promise.resolve(
				new Response(fixture as unknown as BodyInit, { status: 200 }),
			)) as unknown as typeof fetch;
		const idx = await withFetch(ignoring, () =>
			remotePackIndex('https://example.test/fr-vac/archive'),
		);
		expect(idx).toBeNull();
	});

	it('reads the index once per archive', async () => {
		const srv = rangeServer(fixture);
		await withFetch(srv.fetch, async () => {
			const src = [{ local: null, archive: 'https://example.test/fr-vac/archive' }];
			await fetchDocBytes('AD-2.LFPN.pdf', src);
			await fetchDocBytes('AD-2.LFPN.pdf', src);
		});
		// Two header reads would mean the index cache is not working, and a
		// map pan asks for a plate a second.
		expect(srv.calls.filter((c) => c === 'bytes=0-11')).toHaveLength(1);
	});

	it('reads one document once, however many panels ask for it', async () => {
		const srv = rangeServer(fixture);
		await withFetch(srv.fetch, async () => {
			const src = [{ local: null, archive: 'https://example.test/fr-vac/archive' }];
			// The approach sheet and the landing sheet are two rectangles of
			// ONE plate, and the render queue asks for them a panel at a
			// time: concurrently while both are in flight, and again when a
			// pan brings the aerodrome back.
			await Promise.all([
				fetchDocBytes('AD-2.LFPN.pdf', src),
				fetchDocBytes('AD-2.LFPN.pdf', src),
			]);
			await fetchDocBytes('AD-2.LFPN.pdf', src);
		});
		const slices = srv.calls.filter((c) => c !== 'bytes=0-11' && !c.startsWith('bytes=12-'));
		expect(slices).toHaveLength(1);
	});

	it('hands every caller its own buffer', async () => {
		const srv = rangeServer(fixture);
		const [a, b] = await withFetch(srv.fetch, () => {
			const src = [{ local: null, archive: 'https://example.test/fr-vac/archive' }];
			return Promise.all([
				fetchDocBytes('AD-2.LFPN.pdf', src),
				fetchDocBytes('AD-2.LFPN.pdf', src),
			]);
		});
		// pdf.js may transfer the buffer it is handed to its worker, which
		// detaches it. A shared master would be readable exactly once and
		// the second panel would draw nothing.
		expect(a).not.toBeNull();
		expect(a).not.toBe(b);
		expect(new Uint8Array(a!)).toEqual(new Uint8Array(b!));
	});

	it('keys on the sources, so a pre-release edition is a different document', async () => {
		const srv = rangeServer(fixture);
		await withFetch(srv.fetch, async () => {
			// The same file name in both packs, and it is NOT the same
			// document: the pre-release carries next cycle's edition.
			await fetchDocBytes('AD-2.LFPN.pdf', [
				{ local: null, archive: 'https://example.test/fr-vac/archive' },
			]);
			await fetchDocBytes('AD-2.LFPN.pdf', [
				{ local: null, archive: 'https://example.test/fr-vac-next/archive' },
			]);
		});
		const slices = srv.calls.filter((c) => c !== 'bytes=0-11' && !c.startsWith('bytes=12-'));
		expect(slices).toHaveLength(2);
	});

	it('remembers a plate no source carries, and asks nothing again', async () => {
		const srv = rangeServer(fixture);
		let relayed = 0;
		const f = ((url: string, init?: RequestInit) => {
			if (url.includes('/sia/vac/')) {
				relayed++;
				return Promise.resolve(new Response(null, { status: 404 }));
			}
			return srv.fetch(url, init);
		}) as unknown as typeof fetch;
		const src = [{ local: null, archive: 'https://example.test/fr-vac/archive', relay: 'https://proxy.test/sia/vac/26_NOV_2026/AD-2.LFZZ.pdf' }];
		await withFetch(f, async () => {
			expect(await fetchDocBytes('AD-2.LFZZ.pdf', src)).toBeNull();
			expect(await fetchDocBytes('AD-2.LFZZ.pdf', src)).toBeNull();
		});
		// The head and the index once, the relay once: a pan back to the
		// aerodrome asks nobody.
		expect(srv.calls).toHaveLength(2);
		expect(relayed).toBe(1);
	});

	it('forgets its documents when a pack lands, goes or is promoted', async () => {
		const srv = rangeServer(fixture);
		const src = [{ local: null, archive: 'https://example.test/fr-vac/archive' }];
		await withFetch(srv.fetch, () => fetchDocBytes('AD-2.LFPN.pdf', src));
		// withFetch resets on the way out, which is the same call the map
		// effect makes on an offlineDocs.gen change.
		await withFetch(srv.fetch, () => fetchDocBytes('AD-2.LFPN.pdf', src));
		const slices = srv.calls.filter((c) => c !== 'bytes=0-11' && !c.startsWith('bytes=12-'));
		expect(slices).toHaveLength(2);
	});
});

/* A read that FAILED is no answer: no network (the phone out of signal), or a
 * server's "not now". Kept as a miss, the plate stayed blank for the session
 * once the link came back, and a null index kept the ranged reads of its
 * whole archive off. The read rejects instead, which neither the index nor
 * the document cache keeps, so the next ask tries again. */
describe('a read that failed', () => {
	type Fault = 'network' | number;

	/** Fail the first request the way a fault says, then serve `then`. */
	function failOnce(fault: Fault, then: typeof fetch): { fetch: typeof fetch; faults: () => number } {
		let faults = 0;
		const f = ((url: string, init?: RequestInit) => {
			if (faults === 0) {
				faults++;
				return fault === 'network'
					? Promise.reject(new TypeError('Failed to fetch'))
					: Promise.resolve(new Response('unavailable', { status: fault }));
			}
			return then(url, init);
		}) as unknown as typeof fetch;
		return { fetch: f, faults: () => faults };
	}

	it.each<Fault>(['network', 503, 429])('reads the index again after a %s, and the plate with it', async (fault) => {
		const srv = rangeServer(fixture);
		const flaky = failOnce(fault, srv.fetch);
		const src = [{ local: null, archive: 'https://example.test/fr-vac/archive' }];
		const [first, second] = await withFetch(flaky.fetch, async () => [
			await fetchDocBytes('AD-2.LFPN.pdf', src).then(
				(b) => (b ? 'bytes' : 'miss'),
				() => 'failed',
			),
			await fetchDocBytes('AD-2.LFPN.pdf', src),
		]);
		expect(first).toBe('failed');
		expect(second).not.toBeNull();
		expect(srv.calls[0]).toBe('bytes=0-11');
	});

	it('asks a relay that failed by network again', async () => {
		const plate = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
		const relay = failOnce('network', () =>
			Promise.resolve(new Response(plate, { status: 200, headers: { 'content-type': 'application/pdf' } })),
		);
		const f = ((url: string, init?: RequestInit) =>
			url.endsWith('/archive')
				? Promise.resolve(new Response('Not found', { status: 404 }))
				: relay.fetch(url, init)) as unknown as typeof fetch;
		const src = [{ local: null, archive: 'https://example.test/fr-vac/archive', relay: 'https://proxy.test/sia/vac/26_NOV_2026/AD-2.LFPN.pdf' }];
		const [first, second] = await withFetch(f, async () => [
			await fetchDocBytes('AD-2.LFPN.pdf', src).then(
				(b) => (b ? 'bytes' : 'miss'),
				() => 'failed',
			),
			await fetchDocBytes('AD-2.LFPN.pdf', src),
		]);
		expect(first).toBe('failed');
		expect(second instanceof ArrayBuffer ? new Uint8Array(second) : second).toEqual(plate);
	});
});

/* The cache counts the bytes it HOLDS. A read still pending when the cache was
 * reset (a pack landing, going or promoted), or when its entry was evicted,
 * added its bytes on settling all the same, to entries no longer there: the
 * count drifted up for the session, and past the 8 MB budget the cache kept
 * one document, every other plate read again over the network. */
describe('the document cache', () => {
	const PDF = { 'content-type': 'application/pdf' };

	it('counts no bytes for a read that settles after a reset', async () => {
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		const relayed: string[] = [];
		const f = (async (url: string) => {
			if (url.endsWith('/archive')) {
				return new Response('Not found', { status: 404 });
			}
			relayed.push(url);
			if (url.endsWith('/BIG.pdf')) {
				await held;
				return new Response(new Uint8Array(9 << 20), { status: 200, headers: PDF });
			}
			return new Response(new Uint8Array(1 << 10), { status: 200, headers: PDF });
		}) as unknown as typeof fetch;
		const src = (name: string) => [
			{ local: null, archive: 'https://example.test/fr-sup-fr/archive', relay: `https://proxy.test/sia/sup/${name}` },
		];
		await withFetch(f, async () => {
			const big = fetchDocBytes('BIG.pdf', src('BIG.pdf'));
			resetDocFetchCache();
			release();
			await big;
			await fetchDocBytes('A.pdf', src('A.pdf'));
			await fetchDocBytes('B.pdf', src('B.pdf'));
			await fetchDocBytes('A.pdf', src('A.pdf'));
		});
		expect(relayed.filter((u) => u.endsWith('/A.pdf'))).toHaveLength(1);
	});
});
