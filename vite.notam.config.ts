/* The NOTAM Viewer's build, beside Loxodrome's own.
 *
 * It is published INSIDE Loxodrome's site, at loxodrome.fr/notam/, and rides
 * the one Pages artifact deploy.yml already uploads. That is why there is no
 * CNAME here, no .nojekyll, no icon copy and no dataset copy: the site around
 * it already has all four.
 *
 * A separate config rather than a second entry in vite.config.ts, for two
 * reasons that are each disqualifying on their own: VitePWA is one plugin
 * instance with one `workbox` block and one `navigateFallback`, so two apps
 * cannot describe two service workers through it; and `publicDir` is one
 * directory, so two apps cannot each have their own through it. This build
 * must NOT receive the SITE's, or dist/notam/ would gain a second CNAME, a
 * second manifest and a duplicate 67 MB of public/data. It has its own
 * instead, holding its own icons and nothing else.
 *
 * No service worker of its OWN, by decision. An installed copy serving an
 * expired AIRAC cycle out of its own precache is a failure this app has
 * already had once: notam-viewer.net/v2/sw.js is the kill switch written for
 * it. Sharing an origin with Loxodrome does not undo that decision but it does
 * qualify it, and docs/notam-viewer.md states the qualification: no precached
 * shell, while the /data/ reads pass through the origin's runtime caching for
 * a visitor who has also used Loxodrome.
 *
 * The entry is notam.html because Vite takes its entries from the root;
 * scripts/build-notam.js renames the output to index.html. The base is
 * /notam/ in DEV as well as in the build, so a drive of the dev server and a
 * drive of the published site ask for the same URL.
 */

import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { appDefine, libDir } from './vite.shared.ts';

const DATA_DIR = fileURLToPath(new URL('./public/data', import.meta.url));

/** Where this app is mounted inside Loxodrome's site. Not a BASE_PATH escape
 *  hatch like the main config's: the path is fixed by where the app is
 *  published, and a second spelling of it is how the asset URLs and the
 *  service worker's denylist would come to disagree. */
const BASE = '/notam/';

export default defineConfig(() => ({
	base: BASE,
	/* The viewer's OWN, not the site's: three icons, no CNAME, no manifest and
	   no datasets (see the header). It carries its own mark again rather than
	   sharing Loxodrome's, which is what it did until 980f4569; two apps, two
	   marks. Being a publicDir under the base, the files ship at /notam/ and
	   notam-viewer.net reaches them by the mask's ordinary prefix rule, which
	   is why the worker no longer has to share the site's icons. */
	publicDir: 'src/notam/public',
	plugins: [
		svelte(),
		{
			name: 'notam-viewer-dev-site',
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					const path = (req.url ?? '').split('?')[0];
					// This hook runs BEFORE Vite's own middlewares, base
					// stripping included, so req.url is still base-prefixed
					// here. The entry has to be rewritten to a path UNDER the
					// base or the strip leaves it outside and Vite 404s it:
					// /notam/ -> /notam/notam.html -> (stripped) /notam.html.
					if (path === BASE || path === BASE + 'index.html') {
						req.url = BASE + 'notam.html';
						next();
						return;
					}
					if (path === '/' || path === '/index.html') {
						// The bare root is not this app's address any more.
						res.statusCode = 302;
						res.setHeader('location', BASE);
						res.end();
						return;
					}
					// publicDir is false, so nothing serves /data/. Serve the
					// WHOLE of public/data, because that is what production
					// does: these paths are root-absolute, so at /notam/ they
					// read the surrounding site's datasets rather than a copy
					// of their own.
					if (!path.startsWith('/data/')) {
						next();
						return;
					}
					const file = join(DATA_DIR, path.slice('/data/'.length));
					if (!file.startsWith(DATA_DIR) || !existsSync(file)) {
						res.statusCode = 404;
						res.end('no such dataset');
						return;
					}
					res.setHeader('content-type', 'application/json');
					createReadStream(file).pipe(res);
				});
			},
		},
	],
	optimizeDeps: {
		// The dependency scan crawls every HTML file in the project by
		// default, which reaches local/ - the gitignored per-user scratch.
		// It holds saved browser profiles from the Android passes, and
		// rolldown REFUSES some of the extension JS in them (an illegal
		// const re-assignment). The scan then fails whole: pre-bundling is
		// skipped, the deps are discovered one at a time instead, and the
		// page takes a reload and an unhandled "Failed to fetch dynamically
		// imported module" on the way. dist/ is in that crawl too.
		//
		// Naming this app's own entry is the fix and also the truth:
		// neither local/ nor a build output is part of either app, and the
		// entry reaches the whole graph through its own main anyway.
		entries: ['notam.html'],
	},
	resolve: {
		alias: { $lib: libDir },
	},
	build: {
		target: 'es2022',
		sourcemap: true,
		outDir: 'dist/notam',
		emptyOutDir: true,
		rollupOptions: { input: 'notam.html' },
	},
	define: appDefine,
}));
