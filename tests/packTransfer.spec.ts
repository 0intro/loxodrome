/* The pack transfer's HTTP half (offline/packTransfer.ts): what one HEAD and
 * the GET it calls for decide, over a fake archive route answering as the
 * chart worker does (tests/helpers/archiveServer.ts). The cases that matter
 * most are the two a kill used to break: a part already complete (asking
 * for a range past the end got a 416 on every retry) and an archive
 * republished between the HEAD and the GET (a 206 of another edition spliced
 * onto the part). */
import { describe, expect, it } from 'vitest';

import {
	FLUSH_BYTES,
	PackHttpError,
	SIDECAR_DIGITS,
	formatSidecar,
	openTransfer,
	parseContentRange,
	parseSidecar,
	trustedLength,
	type TransferStart,
} from '$lib/offline/packTransfer';
import { archiveServer, patternArchive } from './helpers/archiveServer';

const URL_ = 'https://charts.example/x/archive';
const ARCHIVE = patternArchive(1000);
const E1 = '"edition-1"';

async function drain(t: TransferStart): Promise<Uint8Array> {
	if (t.kind !== 'body') {
		return new Uint8Array(0);
	}
	return new Uint8Array(await new Response(t.body).arrayBuffer());
}

describe('parseContentRange', () => {
	it('reads a range, a 416 and an unknown total', () => {
		expect(parseContentRange('bytes 400-999/1000')).toEqual({ start: 400, end: 999, total: 1000 });
		expect(parseContentRange('bytes */1000')).toEqual({ start: null, end: null, total: 1000 });
		expect(parseContentRange('bytes 0-9/*')).toEqual({ start: 0, end: 9, total: null });
		expect(parseContentRange('items 0-9/10')).toBeNull();
		expect(parseContentRange(null)).toBeNull();
	});
});

describe('the sidecar', () => {
	it('stamps a fixed-width flushed length before the etag, and reads it back', () => {
		const s = formatSidecar(16_777_216, E1);
		expect(s).toBe(`${'16777216'.padStart(SIDECAR_DIGITS, '0')} ${E1}`);
		expect(parseSidecar(s)).toEqual({ flushed: 16_777_216, etag: E1 });
		expect(formatSidecar(0, E1).length).toBe(formatSidecar(25e9, E1).length);
		expect(parseSidecar(formatSidecar(5, null))).toEqual({ flushed: 5, etag: null });
	});

	it('reads the page path legacy one line as an etag to trust by size', () => {
		expect(parseSidecar(`${E1}\n`)).toEqual({ flushed: null, etag: E1 });
		expect(parseSidecar('W/"weak"')).toEqual({ flushed: null, etag: 'W/"weak"' });
		expect(parseSidecar('')).toEqual({ flushed: null, etag: null });
	});

	it('trusts a part to its last stamp, never past its size', () => {
		expect(trustedLength(600, { etag: E1, flushed: 400 })).toBe(400);
		expect(trustedLength(300, { etag: E1, flushed: 400 })).toBe(300);
		expect(trustedLength(600, { etag: E1, flushed: null })).toBe(600);
	});

	it('flushes every 16 MiB', () => {
		expect(FLUSH_BYTES).toBe(16 * 1024 * 1024);
	});
});

describe('openTransfer', () => {
	it('starts a fresh part from zero with the whole archive', async () => {
		const srv = archiveServer(ARCHIVE);
		const t = await openTransfer(URL_, { bytes: 0, etag: null }, null, srv.fetch);
		expect(t).toMatchObject({ kind: 'body', offset: 0, total: 1000, etag: E1 });
		expect(await drain(t)).toEqual(ARCHIVE);
		expect(srv.requests.map((r) => [r.method, r.range])).toEqual([
			['HEAD', null],
			['GET', null],
		]);
	});

	it('asks for neither answer to be cached', async () => {
		const srv = archiveServer(ARCHIVE);
		await drain(await openTransfer(URL_, { bytes: 400, etag: E1 }, null, srv.fetch));
		expect(srv.requests.map((r) => r.cache)).toEqual(['no-store', 'no-store']);
	});

	it('resumes a part of the same edition with a range', async () => {
		const srv = archiveServer(ARCHIVE);
		const t = await openTransfer(URL_, { bytes: 400, etag: E1 }, null, srv.fetch);
		expect(t).toMatchObject({ kind: 'body', offset: 400, total: 1000 });
		expect(await drain(t)).toEqual(ARCHIVE.slice(400));
		expect(srv.requests[1].range).toBe('bytes=400-');
	});

	it('restarts a part of another edition, of no known edition, or under no etag', async () => {
		for (const [part, server] of [
			['"edition-0"', E1],
			[null, E1],
			[E1, null],
		] as const) {
			const srv = archiveServer(ARCHIVE, { etag: server });
			const t = await openTransfer(URL_, { bytes: 400, etag: part }, null, srv.fetch);
			expect(t.kind === 'body' && t.offset).toBe(0);
			expect(srv.requests[1].range).toBeNull();
		}
	});

	it('takes a part as long as the archive for complete, with the HEAD alone', async () => {
		const srv = archiveServer(ARCHIVE);
		expect(await openTransfer(URL_, { bytes: 1000, etag: E1 }, null, srv.fetch)).toEqual({
			kind: 'complete',
			total: 1000,
			etag: E1,
		});
		expect(srv.requests.map((r) => r.method)).toEqual(['HEAD']);
	});

	it('takes a 416 naming the part own length as the end for complete', async () => {
		const srv = archiveServer(ARCHIVE, { headLength: false });
		expect(await openTransfer(URL_, { bytes: 1000, etag: E1 }, null, srv.fetch)).toMatchObject({
			kind: 'complete',
			total: 1000,
		});
		expect(srv.requests.map((r) => [r.method, r.range])).toEqual([
			['HEAD', null],
			['GET', 'bytes=1000-'],
		]);
	});

	it('restarts a part longer than the archive, whether the HEAD or a 416 says so', async () => {
		const known = archiveServer(ARCHIVE);
		const a = await openTransfer(URL_, { bytes: 1200, etag: E1 }, null, known.fetch);
		expect(a.kind === 'body' && a.offset).toBe(0);
		expect(await drain(a)).toEqual(ARCHIVE);

		const unknown = archiveServer(ARCHIVE, { headLength: false });
		const b = await openTransfer(URL_, { bytes: 1200, etag: E1 }, null, unknown.fetch);
		expect(b.kind === 'body' && b.offset).toBe(0);
		expect(await drain(b)).toEqual(ARCHIVE);
		expect(unknown.requests.map((r) => [r.method, r.range])).toEqual([
			['HEAD', null],
			['GET', 'bytes=1200-'],
			['HEAD', null],
			['GET', null],
		]);
	});

	it('takes a 200 answered to a range for a restart from zero', async () => {
		const srv = archiveServer(ARCHIVE, { ignoreRange: true });
		const t = await openTransfer(URL_, { bytes: 400, etag: E1 }, null, srv.fetch);
		expect(t).toMatchObject({ kind: 'body', offset: 0, total: 1000 });
		expect(await drain(t)).toEqual(ARCHIVE);
	});

	it('refuses a 206 that does not start where the part ends', async () => {
		const srv = archiveServer(ARCHIVE, { wrongStart: true });
		await expect(openTransfer(URL_, { bytes: 400, etag: E1 }, null, srv.fetch)).rejects.toThrow(
			/does not continue the part at 400/,
		);
	});

	it('refuses a 206 of an edition published between the HEAD and the GET', async () => {
		const srv = archiveServer(ARCHIVE, { getEtag: '"edition-2"' });
		await expect(openTransfer(URL_, { bytes: 400, etag: E1 }, null, srv.fetch)).rejects.toThrow(
			/does not continue the part/,
		);
	});

	it('names the status and the phase of a refused request', async () => {
		const head = await openTransfer(URL_, { bytes: 0, etag: null }, null, archiveServer(ARCHIVE, { headStatus: 404 }).fetch).catch(
			(e: unknown) => e,
		);
		expect(head).toBeInstanceOf(PackHttpError);
		expect(head).toMatchObject({ status: 404, phase: 'HEAD' });
		const get = await openTransfer(URL_, { bytes: 0, etag: null }, null, archiveServer(ARCHIVE, { getStatus: 503 }).fetch).catch(
			(e: unknown) => e,
		);
		expect(get).toMatchObject({ status: 503, phase: 'GET' });
	});

	it('rejects at once under a signal already aborted', async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(openTransfer(URL_, { bytes: 0, etag: null }, ac.signal, archiveServer(ARCHIVE).fetch)).rejects.toMatchObject({
			name: 'AbortError',
		});
	});
});
