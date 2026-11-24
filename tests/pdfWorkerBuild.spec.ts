/* The pdf.js worker as the build ships it (state/vacPanels.svelte.ts renders
 * the VAC panels with pdf.js, docs/pwa.md). Build-gated like
 * tests/decoWorkerBuild.spec.ts: it reads dist/, which npm run verify builds
 * before the tests, and the last case says so when it is absent rather than
 * passing on nothing.
 *
 * pdf.js is precached, and its worker is a .mjs, which the precache glob
 * left out. A web session holding a VAC pack that started offline could not
 * fetch it, pdf.js fell back to importing the same file, which failed too,
 * and kept that failed loader: every panel stayed blank for the session, the
 * network back or not. */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SITE = join(process.cwd(), 'dist');
const built = existsSync(join(SITE, 'assets'));

const WORKER = /^pdf\.worker\.min-[\w-]+\.mjs$/;

describe.runIf(built)('the pdf.js worker, as built', () => {
	it("is one module in the site's assets, and in its precache", () => {
		const found = readdirSync(join(SITE, 'assets')).filter((n) => WORKER.test(n));
		expect(found).toHaveLength(1);
		expect(readFileSync(join(SITE, 'sw.js'), 'utf8')).toContain(`"assets/${found[0]}"`);
	});
});

it.runIf(!built)('could not check the pdf.js worker as built (no dist/)', () => {
	expect(built).toBe(false);
});
