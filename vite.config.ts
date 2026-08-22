import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

const libDir = fileURLToPath(new URL('./src/lib', import.meta.url));

// Short git SHA of the working-tree commit, baked into the bundle via
// `define` so the About modal can show "v2.0.0 · abc1234". Falls back to
// 'unknown' if git is unavailable (e.g. a packaged tarball build).
const gitSha = (() => {
	try {
		return execSync('git rev-parse --short HEAD', {
			stdio: ['ignore', 'pipe', 'ignore'],
		})
			.toString()
			.trim();
	} catch {
		return 'unknown';
	}
})();

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
				globIgnores: ['**/og.png'], // social preview, not needed offline
				maximumFileSizeToCacheInBytes: 4 * 1024 * 1024, // covers pdfjs/html2canvas chunks
				navigateFallback: 'index.html', // base-prefixed, so /index.html
				// The privacy policy is a page of its own, not a route of the
				// app. Precache matches it first, so the ordinary case is
				// already right; this covers the one that is not, a link
				// carrying a query string, which the precache match ignores
				// and which would otherwise fall through to the app shell.
				// That URL is the one the Play listing hands out.
				navigateFallbackDenylist: [/^\/data\//, /^\/privacy\.html/],
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
						// Terrain tiles (matched by proxy path, origin-agnostic).
						urlPattern: ({ url }) => url.pathname.includes('/tiles/terrarium/'),
						handler: 'CacheFirst',
						options: {
							cacheName: 'terrain-tiles',
							expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
							cacheableResponse: { statuses: [0, 200] },
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
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__APP_SHA__: JSON.stringify(gitSha),
	},
	test: {
		environment: 'node',
		include: ['tests/**/*.spec.ts'],
	},
}));
