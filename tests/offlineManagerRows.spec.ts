/* What the offline manager's rows say (OfflineModal.svelte), rendered on the
 * server in both languages: the words a pilot reads beside each download. */

import { render } from 'svelte/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The registries without the Leaflet they build layers with.
vi.mock('$lib/map/baseLayers', () => ({ baseLayerDef: () => ({ label: 'Plan IGN' }) }));
vi.mock('$lib/map/chartOverlays', () => ({ CHART_LAYERS: [], availableChartLayers: () => [] }));

const { openOffline } = await import('$lib/state/offlineModal.svelte');
const { offlineTerrain } = await import('$lib/state/offlineTerrain.svelte');
const { offlineDocs } = await import('$lib/state/offlineDocs.svelte');
const { offlineQueue } = await import('$lib/state/offlineQueue.svelte');
const { i18n } = await import('$lib/state/i18n.svelte');
const { default: OfflineModal } = await import('$lib/components/OfflineModal.svelte');

/** The rendered text, tags and comments out, ASCII whitespace folded (not
 *  \s, which would fold the French narrow no-break space too). The surface
 *  is opened first: a render tears its shell down, which lets the slot go a
 *  microtask later (releaseOrphanedSurface). */
function text(): string {
	openOffline();
	return render(OfflineModal)
		.body.replace(/<!--[^]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/[ \t\r\n]+/g, ' ')
		.trim();
}

afterEach(() => {
	i18n.locale = 'en';
	offlineTerrain.count = 0;
	offlineTerrain.bytes = 0;
	offlineTerrain.newestTs = 0;
	offlineDocs.packs = {};
	offlineQueue.running = null;
	offlineQueue.queue = [];
});

describe('the terrain section', () => {
	it('counts the pinned terrain in tiles, never documents', () => {
		offlineTerrain.count = 4210;
		offlineTerrain.bytes = 180_000_000;
		offlineTerrain.newestTs = Date.UTC(2026, 10, 17);
		expect(text()).toContain('Offline terrain: 4210 tiles, 180 MB, 2026-11-17');
		expect(text()).not.toContain('4210 documents');
		i18n.locale = 'fr';
		expect(text()).toContain('4210 tuiles');
		expect(text()).not.toContain('4210 documents');
	});
});

/* A held document pack stays 'ready' through its update, and the row used to
 * print its stored-documents line whatever it was doing: an update running
 * read "656 documents, 195 MB, 2026-11-01" for its percentage, a queued one
 * lost its place, and a paused one its figure beside Resume update. */
describe('a held document pack through an update', () => {
	function hold(partBytes: number, progress = 0): void {
		offlineDocs.packs['fr-sup-fr'] = {
			status: 'ready',
			progress,
			sizeBytes: 200_000_000,
			heldBytes: 195_000_000,
			partBytes,
			downloadedAt: '2026-11-01T08:00:00.000Z',
			updateAvailable: true,
			files: 656,
			missing: 0,
			cycle: null,
			stale: false,
			error: null,
		};
	}

	it('reads its documents at rest', () => {
		hold(0);
		expect(text()).toContain('656 documents, 195 MB, 2026-11-01');
	});

	it('says how far the running update is', () => {
		hold(40_000_000, 0.2);
		offlineQueue.running = { kind: 'doc', id: 'fr-sup-fr' };
		expect(text()).toContain('20 %, 40 MB of 200 MB');
		expect(text()).not.toContain('656 documents');
	});

	it('says its place in the queue', () => {
		hold(0);
		offlineQueue.running = { kind: 'chart', id: 'fr500' };
		offlineQueue.queue = [
			{ kind: 'chart', id: 'fr250', sizeBytes: 1_100_000_000, localBytes: 0 },
			{ kind: 'doc', id: 'fr-sup-fr', sizeBytes: 200_000_000, localBytes: 0 },
		];
		expect(text()).toContain('Waiting, 1 ahead');
	});

	it('says where its paused update stands, beside the documents it holds', () => {
		hold(40_000_000);
		expect(text()).toContain('656 documents, 195 MB, 2026-11-01, Update paused at 20 %, 40 MB of 200 MB kept');
		i18n.locale = 'fr';
		expect(text()).toContain('656 documents');
		expect(text()).toMatch(/Mise à jour suspendue à 20/);
	});
});
