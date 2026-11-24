/* The pre-release Atlas VAC pack before its cycle (state/offlineDocs.svelte.ts,
 * state/aipDocOpen.ts, state/vacPanels.svelte.ts), over a mocked pack store.
 *
 * fr-vac-next holds NEXT cycle's edition of every plate under the same file
 * names. A plate is taken from it only once that cycle is in force, the
 * promotion's own test, which a session left open across the date needs:
 * before it, the panel's VAC link would open next cycle's plate marked
 * "superseded", and the map would draw it under this cycle's georeference. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VacPanel } from '$lib/data/vacgeo';
import type { DocSource } from '$lib/offline/docFetch';

const BEFORE = Date.parse('2026-11-18T12:00:00Z');
const AFTER = Date.parse('2026-11-27T12:00:00Z');
const PLATE = 'AD-2.LFPN.pdf';
const CURRENT = { cycle: '29_OCT_2026', effective: '2026-10-29' };
const NEXT = { cycle: '26_NOV_2026', effective: '2026-11-26' };

type VacPackId = 'fr-vac' | 'fr-vac-next';
interface Held {
	cycle: string;
	effective: string;
	plates: string[];
}

afterEach(() => {
	vi.useRealTimers();
	vi.doUnmock('$lib/offline/packStore');
	vi.doUnmock('$lib/offline/docPack');
	vi.doUnmock('$lib/offline/docFetch');
	vi.doUnmock('$lib/native/platform');
});

/** Boot the document packs at `now` with these packs on disk. The store
 *  refuses the rename, so a pre-release whose date has passed stays where
 *  it is, as in a session that was open across the date. */
async function boot(packs: Partial<Record<VacPackId, Held>>, now = BEFORE) {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(now);
	const ids = Object.keys(packs) as VacPackId[];
	vi.doMock('$lib/offline/packStore', async (orig) => ({
		...(await orig<typeof import('../src/lib/offline/packStore')>()),
		opfsSupported: () => true,
		listPacks: () =>
			Promise.resolve(
				Object.fromEntries(ids.map((id) => [id, { etag: null, bytes: 64, downloadedAt: '2026-11-01T00:00:00.000Z' }])),
			),
		openPack: (ref: { id: string }) =>
			Promise.resolve(ids.includes(ref.id as VacPackId) ? new File([new Uint8Array(64)], ref.id) : null),
		partBytes: () => Promise.resolve(0),
		renamePack: () => Promise.resolve(false),
	}));
	vi.doMock('$lib/offline/docPack', async (orig) => ({
		...(await orig<typeof import('../src/lib/offline/docPack')>()),
		readDocPack: (f: File) => {
			const held = packs[f.name as VacPackId];
			return Promise.resolve(
				held
					? {
							file: f,
							base: 0,
							index: {
								set: 'fr-vac',
								cycle: held.cycle,
								effective: held.effective,
								entries: Object.fromEntries(held.plates.map((p) => [p, [0, 64]])),
							},
						}
					: null,
			);
		},
	}));
	const docs = await import('$lib/state/offlineDocs.svelte');
	await docs.ensureOfflineDocs();
	return { docs, open: await import('$lib/state/aipDocOpen') };
}

describe('the VAC link', () => {
	// A stored copy opens in the Android shell alone (storedDoc).
	beforeEach(() => {
		vi.doMock('$lib/native/platform', () => ({ isNativeApp: () => true }));
	});

	it('opens nothing from a pre-release before its cycle, and opens it once in force', async () => {
		const { open } = await boot({ 'fr-vac-next': { ...NEXT, plates: [PLATE] } });
		expect(open.storedDoc(PLATE, false, 'fr')).toBeNull();
		vi.setSystemTime(AFTER);
		expect(open.storedDoc(PLATE, false, 'fr')).toBe('fr-vac-next');
	});

	it('takes no plate the current pack lacks from a pre-release before its cycle', async () => {
		const { open } = await boot({
			'fr-vac': { ...CURRENT, plates: ['AD-2.LFPL.pdf'] },
			'fr-vac-next': { ...NEXT, plates: ['AD-2.LFPL.pdf', PLATE] },
		});
		expect(open.storedDoc('AD-2.LFPL.pdf', false, 'fr')).toBe('fr-vac');
		expect(open.storedDoc(PLATE, false, 'fr')).toBeNull();
	});
});

describe('the offline manager', () => {
	it('calls a pre-release no superseded edition, and an older pack one', async () => {
		const { docs } = await boot({
			'fr-vac': { cycle: '01_OCT_2026', effective: '2026-10-01', plates: [PLATE] },
			'fr-vac-next': { ...NEXT, plates: [PLATE] },
		});
		expect(docs.offlineDocs.packs['fr-vac-next']?.stale).toBe(false);
		expect(docs.offlineDocs.packs['fr-vac']?.stale).toBe(true);
	});
});

describe('the VAC overlay', () => {
	const panel: VacPanel = {
		ident: 'LFPN',
		section: 2,
		page: 1,
		kind: 'APP',
		clip: [0, 0, 100, 100],
		aff: [0.001, 0, 0, 0.001, 2.0, 48.0],
		south: 48,
		west: 2,
		north: 48.1,
		east: 2.1,
	};

	/** The sources the overlay reads the panel's plate from, by pack id. */
	async function sourcesAt(now: number): Promise<string[]> {
		const asked: DocSource[][] = [];
		vi.doMock('$lib/offline/docFetch', () => ({
			fetchDocBytes: (_name: string, sources: DocSource[]) => {
				asked.push(sources);
				return Promise.resolve(null);
			},
			resetDocFetchCache: () => {},
		}));
		await boot({ 'fr-vac-next': { ...NEXT, plates: [PLATE] } }, now);
		const vac = await import('$lib/state/vacPanels.svelte');
		vac.renderedPanel(panel, 1);
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		return asked[0].map((s) => `${s.archive.split('/').at(-2)}${s.local ? ' (held)' : ''}`);
	}

	it('reads no plate of a pre-release before its cycle, and reads it once in force', async () => {
		expect(await sourcesAt(BEFORE)).toEqual(['fr-vac']);
		expect(await sourcesAt(AFTER)).toEqual(['fr-vac', 'fr-vac-next (held)']);
	});
});
