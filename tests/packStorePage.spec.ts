/* The page path of a pack download (offline/packStore.ts, transferOnPage)
 * and the commit after either path, over the in-memory OPFS
 * (tests/helpers/opfsFake.ts) and a fake archive route
 * (tests/helpers/archiveServer.ts). Node has no Worker, so downloadPack
 * takes the page path here. Pinned:
 *   - a restart empties the part BEFORE it records the new edition's etag
 *     (in the other order a kill left the old edition's bytes under the new
 *     etag, and the next attempt spliced two editions);
 *   - a part already complete commits on a HEAD alone (asking for a range
 *     past the end got a 416 on every retry);
 *   - a stamped sidecar is trusted to its stamp, never to the size, and the
 *     bytes past it are written over;
 *   - the commit replaces a held archive in one move;
 *   - what erases a pack waits for its transfer;
 *   - listPacks never reads a part;
 *   - partBytes answers what a resume will build on, and 0 only for no part. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	BASEMAP_PACK_FAMILY,
	deletePack,
	downloadPack,
	listPacks,
	partBytes,
	type PackRef,
} from '$lib/offline/packStore';
import { formatSidecar } from '$lib/offline/packTransfer';
import { archiveServer, patternArchive } from './helpers/archiveServer';
import { FakeDir, FakeRoot, fakeStorage } from './helpers/opfsFake';

const REF: PackRef = { family: BASEMAP_PACK_FAMILY, id: 'planign' };
const URL_ = 'https://charts.example/planign/archive';
const E0 = '"edition-0"';
const E1 = '"edition-1"';
const ARCHIVE = patternArchive(1000);
const OLD = patternArchive(1000, 97);

let root: FakeRoot;
let packs: FakeDir;
let server: ReturnType<typeof archiveServer>;

beforeEach(async () => {
	root = new FakeRoot();
	packs = await root.getDirectoryHandle(BASEMAP_PACK_FAMILY.dir, { create: true });
	server = archiveServer(ARCHIVE, { etag: E1 });
	vi.stubGlobal('navigator', fakeStorage(root));
	vi.stubGlobal('fetch', server.fetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const archiveBytes = (): Uint8Array | undefined => packs.file('planign.pmtiles')?.data;

describe('a restart', () => {
	it('empties the part before it records the new edition', async () => {
		packs.put('planign.pmtiles.part', OLD.slice(0, 600));
		packs.put('planign.pmtiles.etag', E0);
		await downloadPack(REF, URL_);
		const emptied = root.log.indexOf('commit planign.pmtiles.part 0');
		const recorded = root.log.findIndex((l) => l.startsWith('commit planign.pmtiles.etag'));
		expect(emptied).toBeGreaterThanOrEqual(0);
		expect(recorded).toBeGreaterThan(emptied);
		expect(archiveBytes()).toEqual(ARCHIVE);
	});

	it('leaves an empty part under the new etag when it dies before any byte, never the old bytes', async () => {
		packs.put('planign.pmtiles.part', OLD.slice(0, 600));
		packs.put('planign.pmtiles.etag', E0);
		server.set({ etag: E1, failAfter: 0 });
		await expect(downloadPack(REF, URL_)).rejects.toThrow();
		expect(packs.file('planign.pmtiles.part')?.data.length).toBe(0);
		expect(packs.text('planign.pmtiles.etag')).toBe(E1);
		// The next attempt starts from zero: nothing of the old edition is left
		// to resume.
		server.set({ etag: E1 });
		await downloadPack(REF, URL_);
		expect(archiveBytes()).toEqual(ARCHIVE);
	});
});

describe('a resume', () => {
	it('commits a complete part on a HEAD alone', async () => {
		packs.put('planign.pmtiles.part', ARCHIVE);
		packs.put('planign.pmtiles.etag', E1);
		const r = await downloadPack(REF, URL_);
		expect(r).toEqual({ bytes: 1000, etag: E1 });
		expect(server.requests.map((q) => q.method)).toEqual(['HEAD']);
		expect(archiveBytes()).toEqual(ARCHIVE);
		expect(packs.names()).toEqual(['manifest.json', 'planign.pmtiles']);
	});

	it('trusts a stamped sidecar to its stamp and writes over the bytes past it', async () => {
		// 400 bytes known flushed, then 200 the stamp does not vouch for.
		const part = new Uint8Array(600);
		part.set(ARCHIVE.slice(0, 400));
		part.fill(0, 400);
		packs.put('planign.pmtiles.part', part);
		packs.put('planign.pmtiles.etag', formatSidecar(400, E1));
		await downloadPack(REF, URL_);
		expect(server.requests[1].range).toBe('bytes=400-');
		expect(archiveBytes()).toEqual(ARCHIVE);
	});

	it('drops the bytes past the stamp at once, so a pause cannot keep them', async () => {
		const part = new Uint8Array(600);
		part.set(ARCHIVE.slice(0, 400));
		part.fill(0, 400);
		packs.put('planign.pmtiles.part', part);
		packs.put('planign.pmtiles.etag', formatSidecar(400, E1));
		let release!: () => void;
		const hold = new Promise<void>((r) => (release = r));
		server.set({ etag: E1, holdAfter: 50, hold });
		const ac = new AbortController();
		const running = downloadPack(REF, URL_, { signal: ac.signal });
		await vi.waitFor(() => expect(packs.file('planign.pmtiles.part.crswap')?.data.length).toBe(450));
		ac.abort();
		release();
		await expect(running).rejects.toMatchObject({ name: 'AbortError' });
		// What the pause kept is a true prefix of the archive, and what a
		// resume will build on.
		expect(packs.file('planign.pmtiles.part')?.data).toEqual(ARCHIVE.slice(0, 450));
		expect(await partBytes(REF)).toBe(450);
	});

	it('resumes a legacy part from its size', async () => {
		packs.put('planign.pmtiles.part', ARCHIVE.slice(0, 600));
		packs.put('planign.pmtiles.etag', E1);
		await downloadPack(REF, URL_);
		expect(server.requests[1].range).toBe('bytes=600-');
		expect(archiveBytes()).toEqual(ARCHIVE);
	});
});

describe('the commit', () => {
	it('replaces a held archive in one move, never removing it first', async () => {
		packs.put('planign.pmtiles', OLD);
		await downloadPack(REF, URL_);
		expect(root.log).not.toContain('remove planign.pmtiles');
		expect(root.log).toContain('move planign.pmtiles.part planign.pmtiles');
		expect(archiveBytes()).toEqual(ARCHIVE);
	});

	it('refuses a body that ends short and keeps the part', async () => {
		server.set({ etag: E1, shortBy: 100 });
		await expect(downloadPack(REF, URL_)).rejects.toThrow(/archive truncated: 900 of 1000/);
		expect(packs.file('planign.pmtiles.part')?.data.length).toBe(900);
		expect(archiveBytes()).toBeUndefined();
	});
});

describe('around a transfer', () => {
	it('makes a Delete wait for the transfer it would erase', async () => {
		let release!: () => void;
		const hold = new Promise<void>((r) => (release = r));
		server.set({ etag: E1, holdAfter: 500, hold });
		const ac = new AbortController();
		const running = downloadPack(REF, URL_, { signal: ac.signal });
		await vi.waitFor(() => expect(packs.file('planign.pmtiles.part.crswap')?.data.length).toBe(500));
		let deleted = false;
		const del = deletePack(REF).then(() => (deleted = true));
		await new Promise((r) => setTimeout(r, 20));
		expect(deleted).toBe(false);
		ac.abort();
		release();
		await expect(running).rejects.toMatchObject({ name: 'AbortError' });
		await del;
		expect(packs.names().filter((n) => n !== 'manifest.json')).toEqual([]);
	});

	it('lists packs without reading a part a transfer holds', async () => {
		packs.put('planign.pmtiles', ARCHIVE);
		const part = packs.put('planign.pmtiles.part', 300);
		root.getFileThrowsWhenLocked = true;
		await part.createSyncAccessHandle();
		const m = await listPacks(BASEMAP_PACK_FAMILY);
		expect(Object.keys(m)).toEqual(['planign']);
	});

	it('reports what a resume will build on, 0 for no part, and an error for anything else', async () => {
		expect(await partBytes(REF)).toBe(0);
		packs.put('planign.pmtiles.part', 600);
		packs.put('planign.pmtiles.etag', formatSidecar(400, E1));
		expect(await partBytes(REF)).toBe(400);
		packs.put('planign.pmtiles.etag', E1);
		expect(await partBytes(REF)).toBe(600);
		root.getFileThrowsWhenLocked = true;
		await packs.file('planign.pmtiles.part')?.createSyncAccessHandle();
		await expect(partBytes(REF)).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
	});
});
