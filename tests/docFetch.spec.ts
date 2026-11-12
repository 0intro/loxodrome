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
