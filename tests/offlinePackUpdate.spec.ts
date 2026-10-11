/* A HELD pack through an update (docs/offline-maps.md, "Updates"). The
 * archive on disk and the transfer are two facts: an update that runs, is
 * paused or fails leaves the pack held, still served, still counted, and
 * the only thing a pilot can throw away mid-update is the new edition's
 * part. Before this was pinned, pausing an update of the 1.6 GB SIA
 * 1:500 000 turned its row into "Paused" with a Discard button that
 * deleted the held archive along with the part.
 *
 * Both families carry the rule, so both are driven here over a mocked
 * packStore (the queue is the real one). */
import { describe, expect, it, vi } from 'vitest';

interface Store {
	archive: boolean;
	part: number;
	deleted: string[];
	discarded: string[];
	/** How the next download ends: held open until aborted, failing, or
	 *  completing with the new edition. */
	mode: 'hang' | 'fail' | 'complete';
}

const OLD = new File([new Uint8Array(1000)], 'old');
const NEW = new File([new Uint8Array(2000)], 'new');

function mockStore(store: Store, id: string): void {
	vi.doMock('$lib/ui/wakeLock', () => ({
		acquireWakeLock: () => undefined,
		releaseWakeLock: () => undefined,
	}));
	vi.doMock('$lib/offline/quota', () => ({ quotaAllows: vi.fn(() => Promise.resolve(true)) }));
	vi.doMock('$lib/offline/packStore', async (orig) => {
		const real = await orig<typeof import('../src/lib/offline/packStore')>();
		let current: File | null = store.archive ? OLD : null;
		return {
			...real,
			opfsSupported: () => true,
			listPacks: () =>
				Promise.resolve(
					current
						? { [id]: { etag: '"old"', bytes: current.size, downloadedAt: '2026-09-01T00:00:00.000Z' } }
						: {},
				),
			openPack: () => Promise.resolve(current),
			partBytes: () => Promise.resolve(store.part),
			deletePack: (ref: { id: string }) => {
				store.deleted.push(ref.id);
				current = null;
				store.archive = false;
				store.part = 0;
				return Promise.resolve();
			},
			discardPart: (ref: { id: string }) => {
				store.discarded.push(ref.id);
				store.part = 0;
				return Promise.resolve();
			},
			downloadPack: async (
				_ref: unknown,
				_url: string,
				o: { signal?: AbortSignal; onProgress?: (p: { received: number; total: number | null }) => void },
			) => {
				store.part = 400;
				o.onProgress?.({ received: 400, total: 2000 });
				if (store.mode === 'fail') {
					throw new Error('connection reset');
				}
				if (store.mode === 'complete') {
					current = NEW;
					store.archive = true;
					store.part = 0;
					return { bytes: 2000, etag: '"new"' };
				}
				await new Promise((_resolve, reject) => {
					o.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
				});
				return { bytes: 0, etag: null };
			},
		};
	});
}

async function charts(store: Store) {
	vi.resetModules();
	mockStore(store, 'fr500');
	// The registry, without the Leaflet it builds layers with.
	vi.doMock('$lib/map/chartOverlays', () => ({
		CHART_LAYERS: [{ id: 'fr500', archive: 'https://charts.loxodrome.fr/fr500/archive' }],
	}));
	const m = await import('../src/lib/state/offlineCharts.svelte');
	const quota = await import('$lib/offline/quota');
	await m.ensureOfflineCharts();
	return { m, quota };
}

describe('a chart pack held through an update', () => {
	it('stays ready and served while the update runs and once it is paused, and Discard drops only the part', async () => {
		const store: Store = { archive: true, part: 0, deleted: [], discarded: [], mode: 'hang' };
		const { m, quota } = await charts(store);
		expect(m.offlineCharts.packs.fr500?.status).toBe('ready');
		expect(m.packFile('fr500')).toBe(OLD);

		m.downloadPack('fr500');
		await vi.waitFor(() => expect(store.part).toBe(400));
		// The free-space check counts what THIS transfer already holds, not
		// the archive it will replace, which stays on disk until the end.
		expect(quota.quotaAllows).toHaveBeenCalledWith(undefined, 0);
		expect(m.offlineCharts.packs.fr500?.status).toBe('ready');
		expect(m.packFile('fr500')).toBe(OLD);

		m.cancelPack('fr500');
		await vi.waitFor(() => expect(m.packRunning('fr500')).toBe(false));
		const v = m.offlineCharts.packs.fr500;
		expect(v?.status).toBe('ready');
		expect(v?.heldBytes).toBe(1000);
		expect(v?.partBytes).toBe(400);
		expect(m.packFile('fr500')).toBe(OLD);

		await m.discardPackPart('fr500');
		expect(store.discarded).toEqual(['fr500']);
		expect(store.deleted).toEqual([]);
		expect(m.offlineCharts.packs.fr500?.status).toBe('ready');
		expect(m.offlineCharts.packs.fr500?.partBytes).toBe(0);
		expect(m.packFile('fr500')).toBe(OLD);
	});

	it('keeps the pack ready with an error code when the update fails', async () => {
		const store: Store = { archive: true, part: 0, deleted: [], discarded: [], mode: 'fail' };
		const { m } = await charts(store);
		m.downloadPack('fr500');
		await vi.waitFor(() => expect(m.offlineCharts.packs.fr500?.error).toBe('download'));
		expect(m.offlineCharts.packs.fr500?.status).toBe('ready');
		expect(m.packFile('fr500')).toBe(OLD);
	});

	it('swaps the File and bumps gen when the update completes', async () => {
		const store: Store = { archive: true, part: 0, deleted: [], discarded: [], mode: 'complete' };
		const { m } = await charts(store);
		const gen = m.offlineCharts.gen;
		m.downloadPack('fr500');
		await vi.waitFor(() => expect(m.packFile('fr500')).toBe(NEW));
		const v = m.offlineCharts.packs.fr500;
		expect(v?.status).toBe('ready');
		expect(v?.heldBytes).toBe(2000);
		expect(v?.partBytes).toBe(0);
		expect(m.offlineCharts.gen).toBeGreaterThan(gen);
	});

	it('still reads a first download paused as paused, and Delete removes everything', async () => {
		const store: Store = { archive: false, part: 0, deleted: [], discarded: [], mode: 'hang' };
		const { m } = await charts(store);
		m.downloadPack('fr500');
		await vi.waitFor(() => expect(store.part).toBe(400));
		m.cancelPack('fr500');
		await vi.waitFor(() => expect(m.packRunning('fr500')).toBe(false));
		expect(m.offlineCharts.packs.fr500?.status).toBe('none');
		expect(m.offlineCharts.packs.fr500?.partBytes).toBe(400);
		expect(m.offlineCharts.packs.fr500?.heldBytes).toBe(0);
		await m.removePack('fr500');
		expect(store.deleted).toEqual(['fr500']);
		expect(m.offlineCharts.packs.fr500?.partBytes).toBe(0);
	});
});

async function docs(store: Store) {
	vi.resetModules();
	mockStore(store, 'fr-vac');
	vi.doMock('$lib/offline/docPack', () => ({
		readDocPack: (f: File) =>
			Promise.resolve({ file: f, index: { cycle: null, effective: null, missing: [] } }),
		docCount: () => 3,
	}));
	const m = await import('../src/lib/state/offlineDocs.svelte');
	await m.ensureOfflineDocs();
	return m;
}

describe('a document pack held through an update', () => {
	it('stays ready and open once its update is paused, and Discard drops only the part', async () => {
		const store: Store = { archive: true, part: 0, deleted: [], discarded: [], mode: 'hang' };
		const m = await docs(store);
		expect(m.offlineDocs.packs['fr-vac']?.status).toBe('ready');
		const held = m.docPackFor('fr-vac');
		expect(held).not.toBeNull();

		m.downloadDocPack('fr-vac');
		await vi.waitFor(() => expect(store.part).toBe(400));
		expect(m.offlineDocs.packs['fr-vac']?.status).toBe('ready');
		m.cancelDocPack('fr-vac');
		await vi.waitFor(() => expect(m.docPackRunning('fr-vac')).toBe(false));
		const v = m.offlineDocs.packs['fr-vac'];
		expect(v?.status).toBe('ready');
		expect(v?.heldBytes).toBe(1000);
		expect(v?.partBytes).toBe(400);
		expect(m.docPackFor('fr-vac')).toBe(held);

		await m.discardDocPackPart('fr-vac');
		expect(store.discarded).toEqual(['fr-vac']);
		expect(store.deleted).toEqual([]);
		expect(m.docPackFor('fr-vac')).toBe(held);
	});
});
