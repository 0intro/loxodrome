/* Dataset rows that repeat an id. The shipped data has them: 87 FAA navaid
 * ids (69 of them rows emitted twice, the rest two NDBs under one id, like
 * faa:NDB:AA for CEDAR and KENIE), an Italian reporting point, 216 ENAIRE
 * obstacles emitted twice and a French obstacle id on two obstacles. The
 * lists key their rows on the id (the right-click menu, the palette, the
 * route field's suggestions), where Svelte throws on a repeat in production
 * too, and the id index kept only the LAST row of an id, so a selection could
 * open the other feature. Published through uniqueRowIds, a row emitted twice
 * is kept once and a different row takes an occurrence id. The files here
 * are served in place of France's own, which always loads. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const files: Record<string, unknown> = {};

function serve(): void {
	vi.stubGlobal('fetch', (input: string | URL): Promise<Response> => {
		const path = typeof input === 'string' ? input : input.pathname;
		const body = files[path];
		if (body === undefined) {
			return Promise.resolve(new Response('not found', { status: 404 }));
		}
		return Promise.resolve(
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		);
	});
}

const META = { effective: '2026-01-01T00:00:00.000Z' };

beforeEach(() => {
	vi.resetModules();
	for (const k of Object.keys(files)) {
		delete files[k];
	}
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('navaids sharing an id', () => {
	it('publishes each distinct row under an id of its own, a row emitted twice once', async () => {
		const cedar = ['faa:NDB:AA', 'NDB', 'AA', 'CEDAR', 41.1, -90.1, '400', '', null];
		files['/data/fr-navaids.json'] = {
			fields: ['id', 'type', 'ident', 'name', 'lat', 'lon', 'freq', 'channel', 'elev'],
			rows: [
				cedar,
				['faa:NDB:AA', 'NDB', 'AA', 'KENIE', 42.2, -91.2, '401', '', null],
				[...cedar],
				['VOR:1', 'VOR', 'PGS', 'PONTOISE', 49.1, 2.0, '111.2', '', null],
			],
		};
		files['/data/fr-navaids.meta.json'] = META;
		serve();
		const data = await import('$lib/state/data.svelte');
		const list = await data.ensureNavaids();
		expect(list.map((n) => [n.id, n.name])).toEqual([
			['faa:NDB:AA', 'CEDAR'],
			['faa:NDB:AA#2', 'KENIE'],
			['VOR:1', 'PONTOISE'],
		]);
		expect(data.navaidById('faa:NDB:AA')?.name).toBe('CEDAR');
		expect(data.navaidById('faa:NDB:AA#2')?.name).toBe('KENIE');
	});
});

describe('obstacles sharing an id', () => {
	it('keeps a row emitted twice once and tells two obstacles under one id apart', async () => {
		const pylon = ['es:20fa55ab', 'pylon', '', 40.42841, -3.8087, 700, 30, false, false, ''];
		files['/data/fr-obstacles.json'] = {
			fields: ['id', 'type', 'name', 'lat', 'lon', 'elev', 'hgt', 'lit', 'group', 'rmk'],
			rows: [
				pylon,
				[...pylon],
				['18293531', 'antenna', '', 45.1, 1.1, 300, 60, true, false, ''],
				['18293531', 'windturbine', '', 46.2, 2.2, 400, 150, true, false, ''],
			],
		};
		files['/data/fr-obstacles.meta.json'] = META;
		serve();
		const data = await import('$lib/state/data.svelte');
		const list = await data.ensureObstacles();
		expect(list.map((o) => [o.id, o.type])).toEqual([
			['es:20fa55ab', 'pylon'],
			['18293531', 'antenna'],
			['18293531#2', 'windturbine'],
		]);
		expect(data.obstacleById('18293531#2')?.hgt).toBe(150);
	});
});
