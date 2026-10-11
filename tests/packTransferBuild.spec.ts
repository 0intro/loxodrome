/* The pack transfer worker as the build ships it (offline/packTransfer.worker.ts,
 * docs/offline-maps.md "Downloads"). Build-gated like
 * tests/decoWorkerBuild.spec.ts: it reads dist/ and dist/notam/, which npm
 * run verify builds before the tests, and the last case says so when they
 * are absent rather than passing on nothing.
 *   - the site ships exactly one worker chunk under its own assets/, started
 *     from that path, and its service worker precaches it like every script;
 *   - it is one self-contained script holding the transfer's own modules
 *     and nothing else, under a size budget;
 *   - the NOTAM Viewer ships none: it reaches packStore through the
 *     aerodrome panel, and packStore loads the client lazily, from the one
 *     function the viewer never calls. */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SITE = join(ROOT, 'dist');
const VIEWER = join(SITE, 'notam');
const built = existsSync(join(SITE, 'assets')) && existsSync(join(VIEWER, 'assets'));

/** A few kilobytes today: the transfer, its HTTP half and the protocol. */
const BUDGET_BYTES = 24 * 1024;

const WORKER = /^packTransfer\.worker-[\w-]+\.js$/;

const chunks = (dir: string): string[] => readdirSync(join(dir, 'assets')).filter((n) => WORKER.test(n));

describe.runIf(built)('the pack transfer worker, as built', () => {
	it('is one chunk the site starts from its own assets', () => {
		const found = chunks(SITE);
		expect(found).toHaveLength(1);
		const chunk = found[0];
		const refs: string[] = [];
		for (const n of readdirSync(join(SITE, 'assets'))) {
			if (!n.endsWith('.js') || n === chunk) {
				continue;
			}
			const js = readFileSync(join(SITE, 'assets', n), 'utf8');
			if (!js.includes(chunk)) {
				continue;
			}
			for (const m of js.matchAll(/packTransfer\.worker-[\w-]+\.js/g)) {
				refs.push(js.slice(Math.max(0, m.index - 32), m.index));
			}
		}
		expect(refs.length).toBeGreaterThan(0);
		for (const before of refs) {
			expect(before.endsWith('/assets/')).toBe(true);
		}
	});

	it('holds only the transfer own modules, and fits the budget', () => {
		const chunk = chunks(SITE)[0];
		const text = readFileSync(join(SITE, 'assets', chunk), 'utf8');
		expect(text.length).toBeLessThan(BUDGET_BYTES);
		// Nothing further to fetch.
		expect(text).not.toMatch(/\bimport(Scripts)?\b/);
		// Nothing that reads the page: tests/packTransferPurity.spec.ts holds
		// the sources to it, this the bundle the sources became.
		expect(text).not.toMatch(/\b(document|window|localStorage|sessionStorage)\b/);
		const map = JSON.parse(readFileSync(join(SITE, 'assets', `${chunk}.map`), 'utf8')) as { sources: string[] };
		expect(map.sources.length).toBeGreaterThan(0);
		for (const source of map.sources) {
			expect(source).toMatch(/^(\.\.\/)+src\/lib\/offline\/packTransfer[\w.]*\.ts$/);
		}
	});

	it("is in the site's precache", () => {
		const chunk = chunks(SITE)[0];
		expect(readFileSync(join(SITE, 'sw.js'), 'utf8')).toContain(`"assets/${chunk}"`);
	});

	it('is not shipped by the NOTAM Viewer', () => {
		expect(chunks(VIEWER)).toEqual([]);
	});
});

it.runIf(!built)('could not check the pack transfer worker as built (no dist/ or dist/notam/)', () => {
	expect(built).toBe(false);
});
