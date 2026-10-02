/* What the build keeps out of the chunks every visit loads. The pmtiles
 * reader (and fflate through it) serves only a held offline pack, chart or
 * base map, so MapView imports its layers on first use; a static import
 * anywhere on the boot path (an enum read in a state module, a shared module
 * a lazy one also uses) would quietly move it into the entry chunk. And the
 * NOTAM Viewer holds no pack at all: its bundle must not carry the reader
 * even as a lazy chunk (tests/thirdPartyLicenses.spec.ts flags it there by
 * credit; this reads the source maps directly).
 *
 * Runs only on a build (`npm run build && npm run build:notam`). */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dist = join(new URL('..', import.meta.url).pathname, 'dist');
const built = existsSync(join(dist, 'assets')) && existsSync(join(dist, 'sw.js'));
const viewerBuilt = existsSync(join(dist, 'notam', 'assets'));

/** The sources a chunk's map lists, by chunk file name prefix. */
function sources(dir: string, prefix: RegExp): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const f of readdirSync(dir)) {
		if (prefix.test(f) && f.endsWith('.js.map')) {
			const map = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { sources: string[] };
			out.set(f, map.sources);
		}
	}
	return out;
}

describe('the chunks every visit loads', () => {
	it.runIf(built)('carry no pmtiles: the pack readers load when a pack is held', () => {
		const boot = sources(join(dist, 'assets'), /^(index|App)-/);
		expect(boot.size).toBeGreaterThanOrEqual(2);
		for (const [chunk, list] of boot) {
			expect(
				list.filter((s) => s.includes('node_modules/pmtiles')),
				chunk,
			).toEqual([]);
		}
		// And it still ships, in a lazy chunk: the reader's own module, which
		// the bundler splits out once several lazy modules share it (the two
		// pack layers and the base-map edition read).
		const lazy = sources(join(dist, 'assets'), /^(pack(Chart|Base)Layer|filePmtiles)-/);
		expect([...lazy.values()].some((list) => list.some((s) => s.includes('node_modules/pmtiles')))).toBe(true);
	});

	it.runIf(viewerBuilt)("leave pmtiles out of the NOTAM Viewer's bundle entirely", () => {
		const all = sources(join(dist, 'notam', 'assets'), /./);
		for (const [chunk, list] of all) {
			expect(
				list.filter((s) => s.includes('node_modules/pmtiles') || s.includes('packBaseLayer')),
				chunk,
			).toEqual([]);
		}
	});
});
