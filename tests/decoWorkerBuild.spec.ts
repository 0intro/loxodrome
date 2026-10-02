/* The decoration worker as the build ships it (map/decoPaint.worker.ts,
 * docs/pwa.md). Build-gated like tests/notamViewerSite.spec.ts: it reads dist/
 * and dist/notam/, which npm run verify builds before the tests, and the last
 * case says so when they are absent rather than passing on nothing.
 *   - each app ships exactly one worker chunk, under its own assets/, and its
 *     bundle starts the worker from that path (the viewer's /notam/assets/,
 *     which the notam-viewer.net mask passes through unchanged);
 *   - the site's service worker precaches it, so an offline reload paints in
 *     the worker as it did online;
 *   - it is one self-contained script holding the paint's own modules and
 *     nothing else: no package, no import to resolve, nothing that reads the
 *     page;
 *   - it stays under a size budget: the glyph data is most of it, and a
 *     module pulled in by mistake shows here first. */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SITE = join(ROOT, 'dist');
const VIEWER = join(SITE, 'notam');
const built = existsSync(join(SITE, 'assets')) && existsSync(join(VIEWER, 'assets'));

/** About 60 KB today, three quarters of it the activity glyphs. */
const BUDGET_BYTES = 96 * 1024;

const WORKER = /^decoPaint\.worker-[\w-]+\.js$/;

function workerChunk(dir: string): string {
	const found = readdirSync(join(dir, 'assets')).filter((n) => WORKER.test(n));
	expect(found).toHaveLength(1);
	return found[0];
}

/** Every mention of a decoration worker chunk in the app's other scripts,
 *  with the text just before it. Found by the literal name first: a pattern
 *  opening on a character class tries every position of megabytes of
 *  bundled code, which ran past the test timeout under the full suite. */
function workerRefs(dir: string, chunk: string): { name: string; before: string }[] {
	const refs: { name: string; before: string }[] = [];
	for (const n of readdirSync(join(dir, 'assets'))) {
		if (!n.endsWith('.js') || n === chunk) {
			continue;
		}
		const js = readFileSync(join(dir, 'assets', n), 'utf8');
		for (const m of js.matchAll(/decoPaint\.worker-[\w-]+\.js/g)) {
			refs.push({ name: m[0], before: js.slice(Math.max(0, m.index - 32), m.index) });
		}
	}
	return refs;
}

describe.runIf(built)('the decoration worker, as built', () => {
	for (const [app, dir, base] of [
		['the site', SITE, '/assets/'],
		['the NOTAM Viewer', VIEWER, '/notam/assets/'],
	] as const) {
		it(`is one chunk that ${app} starts from its own assets`, () => {
			const chunk = workerChunk(dir);
			const refs = workerRefs(dir, chunk);
			expect(refs.length).toBeGreaterThan(0);
			for (const r of refs) {
				expect(r.name).toBe(chunk);
				expect(r.before.endsWith(base)).toBe(true);
				// The site's own path, never the viewer's copy.
				expect(base === '/assets/' && r.before.endsWith('/notam/assets/')).toBe(false);
			}
		});

		it(`holds only the paint's own modules in ${app}, and fits the budget`, () => {
			const chunk = workerChunk(dir);
			const text = readFileSync(join(dir, 'assets', chunk), 'utf8');
			expect(text.length).toBeLessThan(BUDGET_BYTES);
			// Nothing further to fetch, hence nothing further to precache.
			expect(text).not.toMatch(/\bimport(Scripts)?\b/);
			// Nothing that reads the page: tests/decoWorkerPurity.spec.ts holds
			// the sources to it, this the bundle the sources became.
			expect(text).not.toMatch(/\b(document|window|localStorage|sessionStorage)\b/);
			const map = JSON.parse(readFileSync(join(dir, 'assets', `${chunk}.map`), 'utf8')) as { sources: string[] };
			expect(map.sources.length).toBeGreaterThan(0);
			for (const source of map.sources) {
				expect(source).toMatch(/^(\.\.\/)+src\/lib\/map\/[\w.]+\.ts$/);
			}
			expect(map.sources.some((s) => s.endsWith('/decoPaint.worker.ts'))).toBe(true);
		});
	}

	it("is in the site's precache", () => {
		const chunk = workerChunk(SITE);
		expect(readFileSync(join(SITE, 'sw.js'), 'utf8')).toContain(`"assets/${chunk}"`);
	});
});

it.runIf(!built)('could not check the decoration worker as built (no dist/ or dist/notam/)', () => {
	// Mirrors tests/notamViewerSite.spec.ts: a green run on an unbuilt tree
	// must not read as a complete one.
	expect(built).toBe(false);
});
