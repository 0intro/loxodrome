import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
// Shared with vite.notam.config.ts, the second app's build: the $lib alias and
// the version stamp must not acquire a second spelling.
import { appDefine, libDir } from './vite.shared.ts';

// The app is published at the root of loxodrome.fr, so the base is `/`
// and BASE_PATH is only an escape hatch for serving it from a
// subdirectory. Large generated datasets live in public/data and are
// copied verbatim into dist/; they must never be imported as modules,
// and the app reads them from the absolute /data/ path.
//
// `base` is applied only for production builds: in dev `vite serve`
// stays at `/` so the absolute /data/* fetches resolve against the
// public/data/ directory locally.
export default defineConfig(({ command }) => ({
	base: command === 'build' ? (process.env.BASE_PATH ?? '/') : '/',
	server: {
		proxy: {
			// The NOTAM Viewer, which is published at /notam/ INSIDE this site
			// (docs/notam-viewer.md) but builds from its own config, so in dev
			// it is its own server. Proxying it here is what makes the dev URL
			// shape match the published one: localhost:5173/notam/ is the
			// viewer and localhost:5173/ is this app, exactly as on
			// loxodrome.fr. Needs `npm run dev:notam` running beside this one;
			// without it the path simply fails to connect, which is honest.
			// ws for its HMR socket, and NO rewrite: 5174 serves at that base.
			'/notam': {
				target: 'http://localhost:5174',
				ws: true,
			},
			// The dev app's account-API base (endpoints.ts resolves to this
			// path in dev builds): forwarded to a local `wrangler dev` of
			// account-api, SAME-ORIGIN from the browser's side, so signing
			// in from `npm run dev` needs no CORS entry and no override.
			// The browser's Origin header is preserved, which is what the
			// worker's own allow-list gates on (.dev.vars carries the dev
			// origins). With no worker running the requests fail as
			// 'network', which the dialog words.
			// `npm run dev:live` (VITE_ACCOUNT_LIVE=1) points this SAME proxy
			// at the PRODUCTION service: real accounts, real Turnstile, real
			// e-mailed codes, from a dev tab. The Origin strip below is what
			// makes both targets work without any CORS entry.
			'/__account': {
				target: process.env.VITE_ACCOUNT_LIVE
					? 'https://api.loxodrome.fr'
					: 'http://localhost:8788',
				changeOrigin: Boolean(process.env.VITE_ACCOUNT_LIVE),
				rewrite: (path) => path.replace(/^\/__account/, ''),
				// The proxy hop rewrites Origin to its own; the worker would
				// refuse that foreign value. Strip it instead: a MISSING
				// Origin is the worker's documented non-browser-caller case
				// (curl, a monitor), allowed through because the bearer is
				// the real gate.
				configure: (proxy) => {
					proxy.on('proxyReq', (proxyReq) => {
						proxyReq.removeHeader('origin');
					});
				},
			},
		},
	},
	plugins: [
		svelte(),
		// Offline-capable PWA. Precache the app shell; runtime-cache the map
		// tiles, terrain and static /data/ datasets so a previously-visited
		// area works offline; prompt on a new deploy (registerType 'prompt').
		// The manifest + icons already live in public/ (manifest: false).
		// Live weather / NOTAM / SIGMET / winds are intentionally NOT cached:
		// unmatched requests fall straight through to the network, so the app
		// never serves stale aviation data offline.
		VitePWA({
			registerType: 'prompt',
			injectRegister: null, // registered manually in $lib/state/pwa.svelte
			manifest: false, // keep the existing public/manifest.webmanifest
			workbox: {
				globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
				globIgnores: [
					'**/og.png', // social preview, not needed offline
					// The NOTAM Viewer, published at /notam/ inside this site,
					// keeps NO precached shell of its own (docs/notam-viewer.md).
					// Inert as written, because build-notam.js composes dist/notam
					// AFTER this build has run, so Workbox never sees those files;
					// it is here so a reordering cannot silently fold a second copy
					// of Leaflet and the NOTAM parser into every Loxodrome install.
					'notam/**',
				],
				maximumFileSizeToCacheInBytes: 4 * 1024 * 1024, // covers pdfjs/html2canvas chunks
				navigateFallback: 'index.html', // base-prefixed, so /index.html
				// The privacy policy is a page of its own, not a route of the
				// app. Precache matches it first, so the ordinary case is
				// already right; this covers the one that is not, a link
				// carrying a query string, which the precache match ignores
				// and which would otherwise fall through to the app shell.
				// That URL is the one the Play listing hands out. The terms
				// and the account-deletion page are pages of the same kind,
				// and the second is the URL Play's Data safety form hands out.
				// The /notam entry is the one that is not cosmetic: this worker's
				// scope is the whole origin, so without it a navigation to
				// /notam (no trailing slash, or any precache miss) is answered
				// with THIS app's shell and loxodrome.fr/notam serves Loxodrome
				// instead of the NOTAM Viewer. Pinned by
				// tests/notamViewerSite.spec.ts against the BUILT sw.js.
				navigateFallbackDenylist: [
					/^\/data\//,
					/^\/privacy\.html/,
					/^\/terms\.html/,
					/^\/account-deletion\.html/,
					/^\/notam(\/|$)/,
				],
				cleanupOutdatedCaches: true,
				runtimeCaching: [
					{
						// AIRAC meta sidecars: fresh online (keeps the reload
						// prompt timely), fall back to cache offline. The
						// same-origin guard keeps Open-Meteo's own
						// /data/.../static/meta.json out of the cache.
						urlPattern: ({ url }) =>
							url.origin === self.location.origin &&
							url.pathname.startsWith('/data/') &&
							url.pathname.endsWith('.meta.json'),
						handler: 'NetworkFirst',
						options: {
							cacheName: 'dataset-meta',
							networkTimeoutSeconds: 3,
							// Sized off the real file count with headroom for the
							// publishers still to come: a cap below it silently
							// evicts sidecars an offline session then cannot read,
							// and these are a few hundred bytes each.
							expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 },
						},
					},
					{
						// Static datasets (.json / .next.json / .yaml): instant
						// from cache, refreshed in the background; pairs with the
						// AiracBanner reload prompt on a cycle rollover.
						urlPattern: ({ url }) =>
							url.origin === self.location.origin &&
							url.pathname.startsWith('/data/') &&
							!url.pathname.endsWith('.meta.json'),
						handler: 'StaleWhileRevalidate',
						options: {
							cacheName: 'datasets',
							// Same reasoning as dataset-meta: the cap has to clear
							// the shipped file count (both AIRAC slots included) or
							// the LRU evicts reference data mid-flight. The browser's
							// own storage pressure remains the real ceiling.
							expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
						},
					},
					{
						// Terrain tiles at /terrain/{z}/{x}/{y} on the chart worker.
						// Matched by PATH and origin-agnostic, so a local
						// VITE_TERRAIN_TILES_URL build still hits it. The cache NAME
						// is deliberately unchanged from when this also matched the
						// mosaic we replaced: cleanupOutdatedCaches sweeps only the
						// precache, so a renamed runtime cache would sit orphaned on
						// the device for good. Entries average 38.8 KB across the
						// levels a session actually fetches (20.5 KB at z12, about
						// 55 KB at the pooled levels a corridor reads) against the
						// ~100 KB of the terrain-RGB PNGs they replace, so the
						// budget below buys roughly two and a half times the ground.
						// A 204 is the worker's answer for a tile it does not hold
						// (the open sea, or a level no tier reaches there), as
						// immutable as a tile: uncached, every sea tile read
						// offline FAILED and drew as "no terrain data".
						urlPattern: ({ url }) => url.pathname.startsWith('/terrain/'),
						handler: 'CacheFirst',
						options: {
							cacheName: 'terrain-tiles',
							expiration: { maxEntries: 4000, maxAgeSeconds: 60 * 60 * 24 * 30 },
							cacheableResponse: { statuses: [0, 200, 204] },
						},
					},
					{
						// Base-map tiles (cross-origin; opaque responses via 0).
						urlPattern: ({ url }) => {
							const h = url.hostname;
							const p = url.pathname;
							return (
								h.endsWith('.tile.openstreetmap.org') ||
								h.endsWith('.tile.opentopomap.org') ||
								(h === 'data.geopf.fr' && p.startsWith('/wmts')) ||
								(h.endsWith('.google.com') && p.startsWith('/vt')) ||
								h.endsWith('.tiles.virtualearth.net')
							);
						},
						handler: 'CacheFirst',
						options: {
							cacheName: 'map-tiles',
							expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 30 },
							cacheableResponse: { statuses: [0, 200] },
						},
					},
				],
			},
		}),
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
		entries: ['index.html'],
	},
	resolve: {
		// `$lib` matches the SvelteKit / Vite-Svelte convention and the
		// tsconfig.json compilerOptions.paths entry, so dev / build /
		// svelte-check / vitest all resolve identically.
		alias: { $lib: libDir },
	},
	build: {
		target: 'es2022',
		sourcemap: true,
	},
	define: appDefine,
	test: {
		environment: 'node',
		include: ['tests/**/*.spec.ts'],
	},
}));
