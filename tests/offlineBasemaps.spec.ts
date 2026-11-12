/* The base-map pack state (state/offlineBasemaps.svelte.ts) over a mocked
 * packStore and the real queue: a held pack adopted at boot and served, its
 * edition read off the archive, a first download, the update rule its chart
 * and document siblings follow, an unpublished archive, a delete that lets
 * the map go before the file does, and the manager's door opening on a held
 * base map on the web. */

import { describe, expect, it, vi } from 'vitest';

interface Store {
	archive: File | null;
	part: number;
	mode: 'hang' | 'complete' | 'missing';
	deleted: string[];
	releaseDelete?: () => void;
}

const OLD = new File([new Uint8Array(3000)], 'old');
const NEW = new File([new Uint8Array(4000)], 'new');

async function fresh(store: Store, opts: { deferDelete?: boolean } = {}) {
	vi.resetModules();
	vi.doMock('$lib/ui/wakeLock', () => ({ acquireWakeLock: () => undefined, releaseWakeLock: () => undefined }));
	vi.doMock('$lib/offline/quota', () => ({ quotaAllows: vi.fn(() => Promise.resolve(true)) }));
	vi.doMock('$lib/offline/filePmtiles', () => ({
		archiveInfo: (f: File) =>
			Promise.resolve({ minZoom: 0, maxZoom: 13, edition: f === NEW ? '2027-01-03' : '2026-10-01' }),
	}));
	vi.doMock('$lib/map/chartOverlays', () => ({ CHART_LAYERS: [], availableChartLayers: () => [] }));
	vi.doMock('$lib/native/platform', () => ({ isNativeApp: () => false }));
	vi.doMock('$lib/offline/packStore', async (orig) => {
		const real = await orig<typeof import('../src/lib/offline/packStore')>();
		return {
			...real,
			opfsSupported: () => true,
			listPacks: (family: { dir: string }) =>
				Promise.resolve(
					family.dir === 'basemap-packs' && store.archive
						? { planign: { etag: '"e1"', bytes: store.archive.size, downloadedAt: '2026-10-02T08:00:00.000Z' } }
						: {},
				),
			openPack: (ref: { family: { dir: string } }) =>
				Promise.resolve(ref.family.dir === 'basemap-packs' ? store.archive : null),
			partBytes: () => Promise.resolve(store.part),
			discardPart: () => {
				store.part = 0;
				return Promise.resolve();
			},
			deletePack: (ref: { id: string }) => {
				store.deleted.push(ref.id);
				const done = () => {
					store.archive = null;
					store.part = 0;
				};
				if (opts.deferDelete) {
					return new Promise<void>((res) => {
						store.releaseDelete = () => {
							done();
							res();
						};
					});
				}
				done();
				return Promise.resolve();
			},
			downloadPack: (
				_ref: unknown,
				url: string,
				o: { signal?: AbortSignal; onProgress?: (p: { received: number; total: number | null }) => void },
			) => {
				expect(url).toBe('https://charts.loxodrome.fr/planign/archive');
				if (store.mode === 'missing') {
					return Promise.reject(new real.PackHttpError(404, 'HEAD'));
				}
				store.part = 1000;
				o.onProgress?.({ received: 1000, total: 4000 });
				if (store.mode === 'complete') {
					store.archive = NEW;
					store.part = 0;
					return Promise.resolve({ bytes: 4000, etag: '"e2"' });
				}
				return new Promise((_res, rej) => {
					o.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
				});
			},
		};
	});
	const m = await import('../src/lib/state/offlineBasemaps.svelte');
	await m.ensureOfflineBasemaps();
	return m;
}

describe('a base-map pack', () => {
	it('is adopted at boot, served under its base layer, and read for its edition', async () => {
		const m = await fresh({ archive: OLD, part: 0, mode: 'hang', deleted: [] });
		const v = m.offlineBasemaps.packs.planign;
		expect(v?.status).toBe('ready');
		expect(v?.heldBytes).toBe(3000);
		expect(m.basemapPack('planign')).toBe(OLD);
		expect(m.basemapPack('osm')).toBeNull();
		expect(m.basemapHeld('planign')).toBe(true);
		expect(m.basemapHeld('ign')).toBe(false);
		await vi.waitFor(() => expect(m.offlineBasemaps.packs.planign?.edition).toBe('2026-10-01'));
	});

	it('downloads, swaps in at once and bumps gen', async () => {
		const m = await fresh({ archive: null, part: 0, mode: 'complete', deleted: [] });
		expect(m.basemapPack('planign')).toBeNull();
		const gen = m.offlineBasemaps.gen;
		m.downloadBasemapPack('planign');
		await vi.waitFor(() => expect(m.basemapPack('planign')).toBe(NEW));
		const v = m.offlineBasemaps.packs.planign;
		expect(v?.status).toBe('ready');
		expect(v?.heldBytes).toBe(4000);
		expect(v?.partBytes).toBe(0);
		expect(m.offlineBasemaps.gen).toBeGreaterThan(gen);
		await vi.waitFor(() => expect(m.offlineBasemaps.packs.planign?.edition).toBe('2027-01-03'));
	});

	it('stays held and served through a paused update, and Discard keeps the archive', async () => {
		const store: Store = { archive: OLD, part: 0, mode: 'hang', deleted: [] };
		const m = await fresh(store);
		m.downloadBasemapPack('planign');
		await vi.waitFor(() => expect(store.part).toBe(1000));
		expect(m.offlineBasemaps.packs.planign?.status).toBe('ready');
		m.cancelBasemapPack('planign');
		await vi.waitFor(() => expect(m.basemapPackRunning('planign')).toBe(false));
		expect(m.offlineBasemaps.packs.planign?.status).toBe('ready');
		expect(m.offlineBasemaps.packs.planign?.partBytes).toBe(1000);
		expect(m.basemapPack('planign')).toBe(OLD);
		await m.discardBasemapPackPart('planign');
		expect(store.deleted).toEqual([]);
		expect(m.basemapPack('planign')).toBe(OLD);
	});

	it('says the archive is not published when the worker answers 404', async () => {
		const m = await fresh({ archive: null, part: 0, mode: 'missing', deleted: [] });
		m.downloadBasemapPack('planign');
		await vi.waitFor(() => expect(m.offlineBasemaps.packs.planign?.error).toBe('unpublished'));
		expect(m.offlineBasemaps.packs.planign?.status).toBe('error');
	});

	it('lets the map go before the file is deleted', async () => {
		const store: Store = { archive: OLD, part: 0, mode: 'hang', deleted: [] };
		const m = await fresh(store, { deferDelete: true });
		const gen = m.offlineBasemaps.gen;
		const removing = m.removeBasemapPack('planign');
		// The delete has not finished, and the map has already let go.
		expect(store.deleted).toEqual(['planign']);
		expect(m.basemapPack('planign')).toBeNull();
		expect(m.offlineBasemaps.gen).toBeGreaterThan(gen);
		store.releaseDelete?.();
		await removing;
		expect(m.offlineBasemaps.packs.planign?.status).toBe('none');
		expect(m.basemapHeld('planign')).toBe(false);
	});

	it('opens the offline manager\'s door on the web when a base map is held', async () => {
		await fresh({ archive: OLD, part: 0, mode: 'hang', deleted: [] });
		const { offlineManagerAvailable } = await import('../src/lib/state/offlineModal.svelte');
		expect(offlineManagerAvailable()).toBe(true);
	});
});
