/* The two Cloudflare Workers the app talks to, named once.
 *
 * Both relay upstreams a browser cannot read directly (none of them sends a
 * CORS header) and both gate on an Origin allow-list carrying the site, the
 * Vite dev server and the Android WebView's https://localhost. They are
 * served from the site's own zone, so a Worker response is edge-cacheable and
 * the zone's cache can be purged; see notam-proxy/ and, for the chart worker,
 * the private oaci repository.
 *
 * The bases live here rather than in the modules that use them because the
 * chart worker serves BOTH the chart tiles (map/chartOverlays.ts) and the AIP
 * document packs (offline/docPacks.ts), and those two must not import each
 * other: chartOverlays pulls Leaflet in, docPacks is a pure registry. Leaflet-
 * free and locale-free, so any layer may import it. */

/** Chart tiles, whole-chart PMTiles archives, the elevation mosaic and the
 *  AIP document packs (docs/offline-maps.md). The per-layer VITE_OACI_* overrides in
 *  map/chartOverlays.ts sit above this for the two layers that have one. */
export const CHART_WORKER = 'https://charts.loxodrome.fr';

const ENV_PROXY_URL = import.meta.env.VITE_NOTAM_PROXY_URL as string | undefined;

/** The /notam, /wx, /sofia and /sia/vac relay. This is what
 *  the BUILD ships: VITE_NOTAM_PROXY_URL lets a downstream deploy point at its
 *  own Worker without patching the source, and autorouter/state.svelte.ts
 *  layers the localStorage override over it. */
export const PROXY_DEFAULT =
	(ENV_PROXY_URL && ENV_PROXY_URL.trim()) || 'https://proxy.loxodrome.fr';

const ENV_ACCOUNT_URL = import.meta.env.VITE_ACCOUNT_API_URL as string | undefined;

/** The account + sync API (account-api/, docs/accounts-sync.md). The env
 *  tier doubles as the debug-APK hook for on-device e2e against a local
 *  `wrangler dev` (VITE_ACCOUNT_API_URL=http://localhost:8787 plus
 *  `adb reverse`); sync/protocol.ts layers the localStorage override
 *  over it, the autorouter idiom. */
export const ACCOUNT_API_DEFAULT =
	(ENV_ACCOUNT_URL && ENV_ACCOUNT_URL.trim()) ||
	// A DEV build talks to the local worker through the vite proxy
	// (vite.config.ts server.proxy), same-origin: `npm run dev` +
	// `wrangler dev` in account-api/ and sign-in just works, codes fixed
	// to 000000 by DEV_CODE. Production builds keep the real service.
	(import.meta.env.DEV ? '/__account' : 'https://api.loxodrome.fr');

/** `npm run dev:live`: the dev proxy targets the PRODUCTION account
 *  service (vite.config.ts). Real accounts and real mails behind a dev
 *  tab; the login dialog keys its dev-service hint off this. */
export const ACCOUNT_LIVE = /^(1|true)$/i.test(String(import.meta.env.VITE_ACCOUNT_LIVE ?? ''));

/** The production widget's sitekey: PUBLIC and domain-locked
 *  (loxodrome.fr + localhost, which is also the Android WebView's
 *  origin). The DEFAULT for every production build, web and Android
 *  alike, debug APKs included: any production artifact talks to the
 *  production API by default, so it needs the real widget. */
const PROD_TURNSTILE_SITEKEY = '0x4AAAAAAEd1VOtpMNL14pac';

const ENV_TURNSTILE = import.meta.env.VITE_TURNSTILE_SITEKEY as string | undefined;

/** The Turnstile sitekey the sign-in widget renders with. EMPTY means
 *  no widget (the dev/e2e posture, paired with the worker's DEV_CODE
 *  bypass). Resolution: an explicit VITE_TURNSTILE_SITEKEY wins ('none'
 *  forces the widget OFF, the automation escape hatch); otherwise
 *  production builds get the real sitekey by default and dev builds none,
 *  except live dev mode, which needs the real one. The sitekey's hostname
 *  allow-list carries loxodrome.fr AND localhost (the Android shell's
 *  WebView origin; account-api/README.md). */
export const TURNSTILE_SITEKEY =
	ENV_TURNSTILE?.trim() === 'none'
		? ''
		: (ENV_TURNSTILE && ENV_TURNSTILE.trim()) ||
			(import.meta.env.DEV ? (ACCOUNT_LIVE ? PROD_TURNSTILE_SITEKEY : '') : PROD_TURNSTILE_SITEKEY);
