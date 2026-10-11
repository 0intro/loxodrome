/* The committed-aircraft loader over an index holding generic sheets
 * (src/lib/data/aircraft.ts): `generic.files` loads beside `files`, each
 * generic sheet must state its own file name as aircraft.generic, a club
 * file must not be generic, and the two lists share one duplicate-key
 * guard. Test order matters: the failures run first, since a success is
 * cached for good (as in dataAircraft.spec.ts). */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { loadCommittedAircraft, AIRCRAFT_DIR_URL } from '$lib/data/aircraft';
import { aircraftKey } from '$lib/aircraft/schema';

const META = {
	generatedAt: '2026-10-09T00:00:00Z',
	source: 'test',
	aircraftCount: 1,
	files: ['f-club.yaml'],
	counts: { DR400: 1 },
	generic: { source: 'test manuals', files: ['generic/c172s.yaml'], counts: { C172S: 1 } },
};

const sheets = new Map<string, string>();

const fetchMock = vi.fn((path: string) => {
	if (path === '/data/aircraft.meta.json') {
		return Promise.resolve(
			new Response(JSON.stringify(META), { status: 200, headers: { 'content-type': 'application/json' } }),
		);
	}
	const body = sheets.get(path);
	return Promise.resolve(new Response(body ?? '', { status: body === undefined ? 404 : 200 }));
});
vi.stubGlobal('fetch', fetchMock);

afterAll(() => {
	vi.unstubAllGlobals();
});

const club = 'version: 1\naircraft: { registration: F-CLUB, type: DR400 }\n';
const set = (file: string, text: string) => sheets.set(`${AIRCRAFT_DIR_URL}${file}`, text);

describe('loadCommittedAircraft with generic sheets', () => {
	it('refuses a generic-listed sheet that does not state its file name', async () => {
		set('f-club.yaml', club);
		set('generic/c172s.yaml', 'version: 1\naircraft: { type: C172S }\n');
		await expect(loadCommittedAircraft()).rejects.toThrow(
			'generic/c172s.yaml: a generic sheet states aircraft.generic: c172s',
		);
		set('generic/c172s.yaml', 'version: 1\naircraft: { type: C172S, generic: c172 }\n');
		await expect(loadCommittedAircraft()).rejects.toThrow('aircraft.generic: c172s');
	});

	it('refuses a generic sheet listed among the club files', async () => {
		set('f-club.yaml', 'version: 1\naircraft: { type: DR400, generic: dr400 }\n');
		set('generic/c172s.yaml', 'version: 1\naircraft: { type: C172S, generic: c172s }\n');
		await expect(loadCommittedAircraft()).rejects.toThrow(
			'f-club.yaml: a generic sheet is listed under generic.files, not files',
		);
	});

	it('loads both lists, the generic sheet keyed apart', async () => {
		set('f-club.yaml', club);
		const list = await loadCommittedAircraft();
		expect(list.map((c) => c.file)).toEqual(['f-club.yaml', 'generic/c172s.yaml']);
		expect(list.map((c) => aircraftKey(c.aircraft))).toEqual(['F-CLUB', 'generic:c172s']);
	});
});
