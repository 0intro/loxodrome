/* The swap files a killed download leaves in OPFS (docs/offline-maps.md,
 * "Downloads checkpoint"). Chromium stages every writable in a swap file
 * beside its target, `<name>.crswap`, or `<name>.1.crswap` and on while that
 * name is taken, and renames it over the target at close() (probed in
 * Chromium 2026-10-01). A process killed with the writable open, which is
 * exactly what the checkpoints are for, leaves the swap file behind. On the
 * emulator a force-stop at 65 % of Plan IGN left a 372 MB
 * `planign.pmtiles.part.crswap`, the whole of the app's storage after the
 * pack was resumed, completed and deleted: the manager lists no such file,
 * and every later writable steps around it to `.1.crswap`.
 *
 * Driven over an in-memory OPFS that follows Chromium's naming. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	BASEMAP_PACK_FAMILY,
	deletePack,
	discardPart,
	downloadPack,
	listPacks,
	type PackRef,
} from '$lib/offline/packStore';
import { archiveServer, patternArchive } from './helpers/archiveServer';
import { FakeDir, FakeRoot, fakeStorage } from './helpers/opfsFake';

const REF: PackRef = { family: BASEMAP_PACK_FAMILY, id: 'planign' };
const URL_ = 'https://charts.example/planign/archive';
const ETAG = '"edition-1"';
const ARCHIVE = patternArchive(1000);

let root: FakeRoot;
let packs: FakeDir;
let release: () => void;
let hold: Promise<void>;

beforeEach(async () => {
	root = new FakeRoot();
	packs = await root.getDirectoryHandle(BASEMAP_PACK_FAMILY.dir, { create: true });
	hold = new Promise((r) => (release = r));
	vi.stubGlobal('navigator', fakeStorage(root));
	vi.stubGlobal('fetch', archiveServer(ARCHIVE, { etag: ETAG }).fetch);
});

afterEach(() => {
	release();
	vi.unstubAllGlobals();
});

describe('a killed download\'s swap files', () => {
	it('are gone once the download is resumed and completed', async () => {
		// The kill: a part up to a checkpoint, its etag, and the swap file of
		// the writable that was open.
		packs.put('planign.pmtiles.part', 400);
		packs.put('planign.pmtiles.etag', ETAG);
		packs.put('planign.pmtiles.part.crswap', 600);
		const res = await downloadPack(REF, URL_);
		expect(res.bytes).toBe(ARCHIVE.length);
		expect(packs.names()).toEqual(['manifest.json', 'planign.pmtiles']);
	});

	it('are gone after Delete, the numbered ones too', async () => {
		packs.put('planign.pmtiles', 1000);
		packs.put('planign.pmtiles.part', 400);
		packs.put('planign.pmtiles.etag', ETAG);
		packs.put('planign.pmtiles.part.crswap', 600);
		packs.put('planign.pmtiles.part.1.crswap', 500);
		await deletePack(REF);
		expect(packs.names().filter((n) => n !== 'manifest.json')).toEqual([]);
	});

	it('are gone after Discard, which leaves the held archive alone', async () => {
		packs.put('planign.pmtiles', 1000);
		packs.put('planign.pmtiles.part', 400);
		packs.put('planign.pmtiles.etag', ETAG);
		packs.put('planign.pmtiles.part.crswap', 600);
		await discardPart(REF);
		expect(packs.names()).toEqual(['planign.pmtiles']);
	});

	it('are swept by the boot listing, a paused part kept for its resume', async () => {
		packs.put('planign.pmtiles.part', 400);
		packs.put('planign.pmtiles.etag', ETAG);
		packs.put('planign.pmtiles.part.crswap', 600);
		await listPacks(BASEMAP_PACK_FAMILY);
		expect(packs.names()).toEqual(['planign.pmtiles.etag', 'planign.pmtiles.part']);
	});

	it('never include the swap file of a download in progress', async () => {
		vi.stubGlobal('fetch', archiveServer(ARCHIVE, { etag: ETAG, holdAfter: 500, hold }).fetch);
		const running = downloadPack(REF, URL_);
		// Wait for the transfer to stand at the held chunk, its writable open.
		await vi.waitFor(() => expect(packs.names()).toContain('planign.pmtiles.part.crswap'));
		await listPacks(BASEMAP_PACK_FAMILY);
		expect(packs.names()).toContain('planign.pmtiles.part.crswap');
		release();
		await running;
		expect(packs.names()).toEqual(['manifest.json', 'planign.pmtiles']);
		const f = await (await packs.getFileHandle('planign.pmtiles')).getFile();
		expect(new Uint8Array(await f.arrayBuffer())).toEqual(ARCHIVE);
	});
});
