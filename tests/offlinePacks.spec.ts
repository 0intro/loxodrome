// Offline chart packs (docs/offline-maps.md): the pure decisions of
// offline/packStore.ts, the passive cache's prune arithmetic, and the local
// PMTiles read path over tests/fixtures/mini.pmtiles (a 2-tile archive built
// with go-pmtiles; z0 0/0 red 8x8 PNG, z1 1/0 green).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	CHART_PACK_FAMILY,
	DOC_PACK_FAMILY,
	formatPackBytes,
	reconcileManifest,
	resumePlan,
} from '../src/lib/offline/packStore';
import { pruneCount } from '../src/lib/offline/passiveStore';
import { pmtilesFromFile } from '../src/lib/offline/filePmtiles';

describe('resumePlan', () => {
	it('starts fresh with no part', () => {
		expect(resumePlan(0, null, '"abc"')).toEqual({ offset: 0, restart: false });
	});
	it('resumes when the part matches the server etag', () => {
		expect(resumePlan(1234, '"abc"', '"abc"')).toEqual({ offset: 1234, restart: false });
	});
	it('restarts on an etag mismatch', () => {
		expect(resumePlan(1234, '"abc"', '"def"')).toEqual({ offset: 0, restart: true });
	});
	it('restarts when either etag is unknown (no proof of a matching part)', () => {
		expect(resumePlan(1234, null, '"abc"')).toEqual({ offset: 0, restart: true });
		expect(resumePlan(1234, '"abc"', null)).toEqual({ offset: 0, restart: true });
	});
});

describe('reconcileManifest', () => {
	it('drops entries whose archive is gone and adopts orphan archives', () => {
		const out = reconcileManifest(
			{
				fr500: { etag: '"a"', bytes: 10, downloadedAt: '2026-08-04T00:00:00Z' },
				es500: { etag: '"b"', bytes: 20, downloadedAt: '2026-08-04T00:00:00Z' },
			},
			[
				{ name: 'fr500.pmtiles', size: 10 },
				{ name: 'us250.pmtiles', size: 30 },
				{ name: 'fr250.pmtiles.part', size: 5 },
				{ name: 'manifest.json', size: 1 },
			],
			CHART_PACK_FAMILY,
		);
		// es500's archive is gone; us250 exists without an entry (adopted with
		// an unknown etag, so the update check will flag it); part files and
		// the manifest itself are not packs.
		expect(Object.keys(out).sort()).toEqual(['fr500', 'us250']);
		expect(out.fr500.etag).toBe('"a"');
		expect(out.us250).toEqual({ etag: null, bytes: 30, downloadedAt: '' });
	});

	it('reads the extension from the family, not a hardcoded .pmtiles', () => {
		const out = reconcileManifest(
			{ 'fr-vac': { etag: '"a"', bytes: 10, downloadedAt: '2026-08-16T00:00:00Z' } },
			[
				{ name: 'fr-vac.pack', size: 10 },
				{ name: 'fr-sup-fr.pack', size: 40 },
				{ name: 'fr-vac.next.pack.part', size: 5 },
				{ name: 'manifest.json', size: 1 },
			],
			DOC_PACK_FAMILY,
		);
		expect(Object.keys(out).sort()).toEqual(['fr-sup-fr', 'fr-vac']);
		expect(out['fr-vac'].etag).toBe('"a"');
		expect(out['fr-sup-fr']).toEqual({ etag: null, bytes: 40, downloadedAt: '' });
	});
});

describe('formatPackBytes', () => {
	it('formats the real archive scale', () => {
		expect(formatPackBytes(1585859010)).toBe('1.6 GB');
		expect(formatPackBytes(825710171)).toBe('826 MB');
		expect(formatPackBytes(24948015241)).toBe('25 GB');
		expect(formatPackBytes(120_000)).toBe('1 MB');
	});
});

describe('pruneCount', () => {
	it('leaves the cache alone within the slack and prunes back to the cap', () => {
		expect(pruneCount(2900)).toBe(0);
		expect(pruneCount(3050)).toBe(0);
		expect(pruneCount(3200)).toBe(200);
	});
});

describe('pmtilesFromFile over the fixture archive', () => {
	const buf = readFileSync(fileURLToPath(new URL('./fixtures/mini.pmtiles', import.meta.url)));
	const file = new File([buf], 'mini.pmtiles');

	it('reads the header from slices', async () => {
		const p = pmtilesFromFile(file, 'mini');
		const h = await p.getHeader();
		expect(h.minZoom).toBe(0);
		expect(h.maxZoom).toBe(1);
	});

	it('serves present tiles and misses absent ones', async () => {
		const p = pmtilesFromFile(file, 'mini');
		const t0 = await p.getZxy(0, 0, 0);
		expect(t0).toBeDefined();
		// A PNG payload (the 8x8 red tile).
		const sig = new Uint8Array(t0!.data.slice(0, 4));
		expect([...sig]).toEqual([0x89, 0x50, 0x4e, 0x47]);
		const t1 = await p.getZxy(1, 1, 0);
		expect(t1).toBeDefined();
		expect(t1!.data.byteLength).not.toBe(t0!.data.byteLength);
		const miss = await p.getZxy(1, 0, 1);
		expect(miss).toBeUndefined();
	});
});
