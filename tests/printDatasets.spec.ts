/* The prints tell a dataset that did not load from one that did.
 *
 * FlightPrepModal and WxPrintHost settle each reference dataset they read
 * and record a non-blocking "Some reference data could not be loaded" issue
 * for every one that rejects. The aircraft library's ensure never rejects
 * (it records aircraftState.libraryError, since the module's own boot call
 * and four components fire it and forget it), so a failed library settled
 * as a success and the sheet went out without saying so. The prints now
 * read requireAircraftLibrary, which rejects exactly when the library did
 * not load, while every other caller keeps the ensure that never rejects. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let metaStatus = 503;

beforeEach(() => {
	vi.resetModules();
	metaStatus = 503;
	vi.stubGlobal('fetch', (input: string | URL): Promise<Response> => {
		const path = typeof input === 'string' ? input : input.pathname;
		if (path === '/data/aircraft.meta.json') {
			return Promise.resolve(
				metaStatus === 200
					? new Response(JSON.stringify({ generatedAt: 'x', aircraftCount: 0, files: [], counts: {} }), {
							status: 200,
							headers: { 'content-type': 'application/json' },
						})
					: new Response('unavailable', { status: metaStatus }),
			);
		}
		return Promise.resolve(new Response('not found', { status: 404 }));
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('requireAircraftLibrary', () => {
	it('rejects when the library did not load, while the ensure still resolves', async () => {
		const a = await import('$lib/state/aircraft.svelte');
		await expect(a.ensureAircraftLibrary()).resolves.toBeUndefined();
		expect(a.aircraftState.libraryError).toMatch(/aircraft\.meta\.json/);
		await expect(a.requireAircraftLibrary()).rejects.toThrow(/aircraft\.meta\.json/);
	});

	it('resolves once the library loads', async () => {
		metaStatus = 200;
		const a = await import('$lib/state/aircraft.svelte');
		await expect(a.requireAircraftLibrary()).resolves.toBeUndefined();
		expect(a.aircraftState.libraryLoaded).toBe(true);
	});
});

describe('the prints', () => {
	it('ask the dataset reads waiting for a retry, await them and the coverage, then report what is still missing', async () => {
		// A published dataset's ensure answers at once, whatever of it is
		// still being read: asked without awaiting its retry, the print read
		// the set without the country its own gesture had asked for, and
		// judged "incomplete" while the read was still running.
		const { readFileSync } = await import('node:fs');
		for (const f of ['src/lib/components/FlightPrepModal.svelte', 'src/lib/components/WxPrintHost.svelte']) {
			const src = readFileSync(f, 'utf8');
			const asked = src.indexOf('const retried = retryDataNow(');
			// Awaited with the ensures (inside the race against Cancel).
			const awaited = src.search(/Promise\.all\(\[[^\]]*\bretried,\s*\]\)/);
			const coverage = src.indexOf('extendCoverage()', awaited);
			const judged = src.search(/\.some\(retryingGroup\)\) \{\s*addPrintIssue\(gen, \{ code: 'datasets' \}\)/);
			expect(asked, f).toBeGreaterThan(-1);
			expect(awaited, f).toBeGreaterThan(asked);
			expect(coverage, f).toBeGreaterThan(awaited);
			expect(judged, f).toBeGreaterThan(coverage);
		}
		// The nav log's print computes the MSA from what it reads.
		const nav = readFileSync('src/lib/components/NavLogModal.svelte', 'utf8');
		const asked = nav.indexOf('const retried = retryDataNow(');
		const awaited = nav.indexOf('await retried;', asked);
		expect(asked).toBeGreaterThan(-1);
		expect(awaited).toBeGreaterThan(asked);
		expect(nav.indexOf('await extendCoverage();', awaited)).toBeGreaterThan(awaited);
	});

	it('each ask the groups its paper reads, only the parts known to matter', async () => {
		// A print asks what its paper reads and waits for it, so the groups
		// ARE the contract: the nav log's sheets fall back to the selected
		// plane's cruise for their ETE speed and did not ask the aircraft
		// library, and "every group" held a print behind a far country's
		// stalled read for 30 s.
		const { readFileSync } = await import('node:fs');
		const groups = (src: string, expr: RegExp): string[] => {
			const m = expr.exec(src);
			expect(m, String(expr)).not.toBeNull();
			return [...(m?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((g) => g[1]).sort();
		};
		const nav = readFileSync('src/lib/components/NavLogModal.svelte', 'utf8');
		expect(groups(nav, /retryDataNow\(\{\s*groups: \[([^\]]*)\],\s*wantedOnly: true,?\s*\}\)/)).toEqual(
			['aircraft', 'airports', 'airspaces', 'navaids', 'obstacles'],
		);
		const wx = readFileSync('src/lib/components/WxPrintHost.svelte', 'utf8');
		expect(wx).toContain('retryDataNow({ groups: WX_PRINT_READS, wantedOnly: true })');
		expect(groups(wx, /const WX_PRINT_READS: readonly RetryGroup\[\] = \[([^\]]*)\]/)).toEqual([
			'aircraft',
			'airports',
			'airspaces',
		]);
		const prep = readFileSync('src/lib/components/FlightPrepModal.svelte', 'utf8');
		expect(prep).toContain('retryDataNow({ groups: read, wantedOnly: true })');
		expect(groups(prep, /const read: RetryGroup\[\] = \[([^\]]*)\]/)).toEqual(['aircraft', 'airports', 'fuel']);
		expect(groups(prep, /read\.push\(([^)]*)\)/)).toEqual(['airspaces', 'navaids', 'obstacles']);
		// The importer asks what its plans resolve against, wherever it is.
		const imp = readFileSync('src/lib/state/flightImport.svelte.ts', 'utf8');
		expect(imp).toContain("retryDataNow({ groups: ['airports', 'navaids'] })");
	});

	it('settle the library through requireAircraftLibrary, never the ensure that cannot fail', async () => {
		const { readFileSync } = await import('node:fs');
		for (const f of ['src/lib/components/FlightPrepModal.svelte', 'src/lib/components/WxPrintHost.svelte']) {
			const src = readFileSync(f, 'utf8');
			expect(src, f).toContain('dsSettled(requireAircraftLibrary())');
			expect(src, f).not.toContain('dsSettled(ensureAircraftLibrary())');
		}
	});
});
