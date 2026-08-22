/* The committed-aircraft loader (src/lib/data/aircraft.ts): meta-driven
 * fetch of every sheet, the fail-fast file-prefixed rejection (a broken
 * sheet names itself; the loader deliberately does NOT skip it, so the
 * Aircraft tab can surface which file broke), the duplicate-key guard,
 * and the retry-after-failure cache clearing. Test order matters: the
 * failing scenarios run first because a SUCCESS is cached for good. */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { loadCommittedAircraft, AIRCRAFT_DIR_URL } from '$lib/data/aircraft';

const META = {
	generatedAt: '2026-01-01T00:00:00Z',
	source: 'test',
	aircraftCount: 2,
	files: ['a.yaml', 'b.yaml'],
	counts: { T1: 1, T2: 1 },
};

const sheet = (reg: string, type: string): string =>
	`version: 1\naircraft: { registration: ${reg}, type: ${type} }\n`;

/** Per-path sheet responses; tests mutate this between loader calls. */
const sheets = new Map<string, { status: number; body: string }>();

const fetchMock = vi.fn((path: string) => {
	if (path === '/data/aircraft.meta.json') {
		return Promise.resolve({
			ok: true,
			status: 200,
			headers: { get: () => 'application/json' },
			json: () => Promise.resolve(META),
		});
	}
	const r = sheets.get(path) ?? { status: 404, body: '' };
	return Promise.resolve({
		ok: r.status === 200,
		status: r.status,
		headers: { get: () => 'text/yaml' },
		text: () => Promise.resolve(r.body),
	});
});
vi.stubGlobal('fetch', fetchMock);

afterAll(() => {
	vi.unstubAllGlobals();
});

describe('loadCommittedAircraft', () => {
	it('rejects with the path when a sheet 404s, clearing the cache', async () => {
		sheets.set(`${AIRCRAFT_DIR_URL}a.yaml`, { status: 200, body: sheet('F-AAAA', 'T1') });
		// b.yaml missing -> HTTP 404
		await expect(loadCommittedAircraft()).rejects.toThrow(
			`${AIRCRAFT_DIR_URL}b.yaml: HTTP 404`,
		);
	});

	it('rejects with the FILE-prefixed parse error on a malformed sheet (fail-fast, never skipped)', async () => {
		sheets.set(`${AIRCRAFT_DIR_URL}b.yaml`, { status: 200, body: 'version: 99\n' });
		await expect(loadCommittedAircraft()).rejects.toThrow(/^b\.yaml: /);
	});

	it('rejects on a duplicate aircraft key across sheets', async () => {
		sheets.set(`${AIRCRAFT_DIR_URL}b.yaml`, { status: 200, body: sheet('F-AAAA', 'T2') });
		await expect(loadCommittedAircraft()).rejects.toThrow('duplicate aircraft key F-AAAA');
	});

	it('loads every meta-indexed sheet after the failures (retry works), then caches', async () => {
		sheets.set(`${AIRCRAFT_DIR_URL}b.yaml`, { status: 200, body: sheet('F-BBBB', 'T2') });
		const list = await loadCommittedAircraft();
		expect(list.map((c) => c.file)).toEqual(META.files);
		expect(list).toHaveLength(META.files.length);
		expect(list[0].aircraft.identity.registration).toBe('F-AAAA');
		expect(list[1].aircraft.identity.type).toBe('T2');
		// Cached: a second call resolves the same list with no new fetches.
		const calls = fetchMock.mock.calls.length;
		await expect(loadCommittedAircraft()).resolves.toBe(list);
		expect(fetchMock.mock.calls.length).toBe(calls);
	});
});
