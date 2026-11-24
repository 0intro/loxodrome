/* Opening a stored AIP document (state/aipDocOpen.ts) over a mocked pack
 * store, a mocked Capacitor Filesystem and a mocked PDF hand-off.
 *
 * A stored copy opens only in the Android shell, which extracts it to the app
 * cache and hands it to the phone's viewer. On the web a held pack marked the
 * link "Stored offline" and stopped the anchor, then openStoredDoc answered
 * false off the shell and the tap opened the SIA's URL anyway, which fails
 * offline. */

import { afterEach, describe, expect, it, vi } from 'vitest';

const PLATE = 'AD-2.LFPN.pdf';
const SIZE = 64;

const native = vi.hoisted(() => ({ app: false }));
vi.mock('$lib/native/platform', () => ({ isNativeApp: () => native.app }));

const viewed = vi.hoisted(() => [] as string[]);
vi.mock('$lib/native/openDocument', () => ({
	viewPdf: (uri: string) => {
		viewed.push(uri);
		return Promise.resolve(true);
	},
}));

/** The app cache as Capacitor's Filesystem shows it: the files extracted so
 *  far, by path, with their sizes, and the writes made. */
const cache = vi.hoisted(() => ({ files: new Map<string, number>(), writes: [] as string[] }));
vi.mock('@capacitor/filesystem', () => {
	const uri = (path: string) => `file:///cache/${path}`;
	const missing = () => Promise.reject(new Error('File does not exist'));
	return {
		Directory: { Cache: 'CACHE' },
		Filesystem: {
			stat: ({ path }: { path: string }) => {
				const size = cache.files.get(path);
				return size === undefined ? missing() : Promise.resolve({ type: 'file', size, uri: uri(path) });
			},
			getUri: ({ path }: { path: string }) => Promise.resolve({ uri: uri(path) }),
			writeFile: ({ path, data }: { path: string; data: string }) => {
				cache.writes.push(path);
				cache.files.set(path, atob(data).length);
				return Promise.resolve({ uri: uri(path) });
			},
		},
	};
});

afterEach(() => {
	native.app = false;
	viewed.length = 0;
	cache.files.clear();
	cache.writes.length = 0;
	vi.doUnmock('$lib/offline/packStore');
	vi.doUnmock('$lib/offline/docPack');
});

/** Boot the document packs with fr-vac held, carrying the plate. */
async function boot() {
	vi.resetModules();
	vi.doMock('$lib/offline/packStore', async (orig) => ({
		...(await orig<typeof import('../src/lib/offline/packStore')>()),
		opfsSupported: () => true,
		listPacks: () =>
			Promise.resolve({ 'fr-vac': { etag: '"e1"', bytes: SIZE, downloadedAt: '2026-11-01T00:00:00.000Z' } }),
		openPack: (ref: { id: string }) =>
			Promise.resolve(ref.id === 'fr-vac' ? new File([new Uint8Array(SIZE)], ref.id) : null),
		partBytes: () => Promise.resolve(0),
		renamePack: () => Promise.resolve(false),
	}));
	vi.doMock('$lib/offline/docPack', async (orig) => ({
		...(await orig<typeof import('../src/lib/offline/docPack')>()),
		readDocPack: (f: File) =>
			Promise.resolve({
				file: f,
				base: 0,
				index: { set: 'fr-vac', cycle: '29_OCT_2026', effective: '2026-10-29', entries: { [PLATE]: [0, SIZE] } },
			}),
	}));
	const docs = await import('$lib/state/offlineDocs.svelte');
	await docs.ensureOfflineDocs();
	return import('$lib/state/aipDocOpen');
}

/** A click on the plate's link, and whether its default was prevented. */
function click(open: typeof import('$lib/state/aipDocOpen')): boolean {
	let prevented = false;
	const e = { preventDefault: () => (prevented = true) } as unknown as MouseEvent;
	open.docLinkClick(e, `https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_29_OCT_2026/Atlas-VAC/PDF_AIPparSSection/VAC/AD/${PLATE}`, PLATE, false, 'fr');
	return prevented;
}

describe('a stored document on the web', () => {
	it('marks no link and leaves the anchor to open the SIA', async () => {
		const open = await boot();
		expect(open.storedDoc(PLATE, false, 'fr')).toBeNull();
		expect(click(open)).toBe(false);
	});
});

describe('a stored document in the Android shell', () => {
	const extract = `aip-docs/29_OCT_2026/${PLATE}`;

	it('marks the link, stops the anchor and opens the stored copy', async () => {
		native.app = true;
		const open = await boot();
		expect(open.storedDoc(PLATE, false, 'fr')).toBe('fr-vac');
		expect(click(open)).toBe(true);
		await vi.waitFor(() => expect(viewed).toEqual([`file:///cache/${extract}`]));
		expect(cache.writes).toEqual([extract]);
		expect(cache.files.get(extract)).toBe(SIZE);
	});
});

/* An extract is reused only whole. Capacitor's Android writeFile creates the
 * file, then decodes and writes it, so a write cut short (storage full, the
 * app killed) leaves the file it began, and every later tap found it and
 * handed the viewer a broken PDF until the cycle changed. */
describe('an extract the cache holds', () => {
	const extract = `aip-docs/29_OCT_2026/${PLATE}`;

	it('is written again when its size is not the document', async () => {
		native.app = true;
		cache.files.set(extract, 10);
		const open = await boot();
		expect(await open.openStoredDoc(PLATE, false, 'fr')).toBe(true);
		expect(cache.writes).toEqual([extract]);
		expect(cache.files.get(extract)).toBe(SIZE);
		expect(viewed).toEqual([`file:///cache/${extract}`]);
	});

	it('is reused whole, never written again', async () => {
		native.app = true;
		cache.files.set(extract, SIZE);
		const open = await boot();
		expect(await open.openStoredDoc(PLATE, false, 'fr')).toBe(true);
		expect(cache.writes).toEqual([]);
		expect(viewed).toEqual([`file:///cache/${extract}`]);
	});
});
