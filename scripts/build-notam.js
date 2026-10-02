/* Finish the NOTAM Viewer's build, which lands inside Loxodrome's site.
 *
 * The viewer is published at loxodrome.fr/notam/ and rides the one Pages
 * artifact deploy.yml uploads, so almost everything this script used to do is
 * now done by the site around it: the datasets at /data/, the icons, the
 * CNAME, the .nojekyll. What is left is the one thing Vite cannot do, because
 * it takes its entries from the root and cannot rename an HTML output:
 *
 *   notam.html -> index.html
 *
 * ORDER IS LOAD-BEARING and the assertion below is what enforces it. `vite
 * build` empties dist/, so a viewer built first would be deleted by the main
 * build. `npm run verify` and the deploy workflow both run the main build
 * first; anything else gets an error naming the reason rather than a site
 * silently missing half of itself.
 *
 * Run: npm run build:notam
 */

import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SITE = join(ROOT, 'dist');
const DIST = join(SITE, 'notam');

function main() {
	if (!existsSync(join(SITE, 'index.html'))) {
		throw new Error(
			'build-notam: dist/index.html is missing, so the main build has not run.\n' +
				'  This app is published INSIDE that site and `vite build` empties dist/.\n' +
				'  Run `vite build` first (npm run verify does).',
		);
	}
	if (!statSync(join(DIST, 'notam.html'), { throwIfNoEntry: false })) {
		throw new Error('build-notam: run `vite build --config vite.notam.config.ts` first');
	}
	renameSync(join(DIST, 'notam.html'), join(DIST, 'index.html'));
	process.stdout.write('build-notam: dist/notam/ composed\n');
}

try {
	main();
} catch (err) {
	process.stderr.write(String(err instanceof Error ? err.message : err) + '\n');
	process.exitCode = 1;
	// Leave nothing half-composed: a dist/notam that looks built but has no
	// entry is worse than no dist/notam at all.
	rmSync(join(DIST, 'index.html'), { force: true });
}
