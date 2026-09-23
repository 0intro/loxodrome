/* The NOTAM Viewer publishes INSIDE Loxodrome's site, at /notam/.
 *
 * Source-side cases always run. The build-gated ones read dist/notam/, which
 * npm run verify produces before the tests; without it they are skipped, and
 * the last case says so rather than letting a green run look complete. CI does
 * not build the viewer, so verify is the only gate that exercises them.
 *
 * The dangerous one here is the service worker. Loxodrome's own worker is
 * served from / and so scopes the whole origin, and its navigateFallback
 * answers any unmatched navigation with Loxodrome's shell. Without /notam in
 * the denylist, loxodrome.fr/notam serves the WRONG APP to every visitor who
 * has the worker installed, and nothing else in the build would say so. That
 * is why the denylist is asserted against the BUILT sw.js and not against the
 * config that generates it.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const SITE = join(ROOT, 'dist');
const DIST = join(SITE, 'notam');
const built = existsSync(join(DIST, 'assets'));

describe('the build config', () => {
	const cfg = read('vite.notam.config.ts');

	it('writes into the site it is published in, and takes its own entry', () => {
		expect(cfg).toContain("outDir: 'dist/notam'");
		expect(cfg).toContain("input: 'notam.html'");
	});

	it('is mounted at /notam/, in dev as well as in the build', () => {
		// One spelling of the mount point. A second is how the asset URLs and
		// the service worker's denylist would come to disagree.
		expect(cfg).toContain("const BASE = '/notam/'");
		expect(cfg).toContain('base: BASE');
	});

	it('registers no service worker of its own', () => {
		// Not a preference. A precached shell serving an AIRAC cycle that has
		// expired is worse than serving nothing; notam-viewer.net/v2/sw.js is
		// the kill switch written the last time it happened.
		// Matched on the import and the CALL, not the word: the config's own
		// header explains why VitePWA is absent, and a substring test would
		// read that explanation as the thing it forbids.
		expect(cfg).not.toMatch(/from\s+'vite-plugin-pwa'/);
		expect(cfg).not.toMatch(/\bVitePWA\s*\(/);
		expect(read('src/notam/main.ts')).not.toMatch(/from\s+'[^']*pwa\.svelte'/);
	});

	it('refuses the SHARED public directory, and takes its own', () => {
		// The site's would give dist/notam a second CNAME, a second manifest
		// and a duplicate of public/data. Its own holds three icons, which is
		// what lets the app carry its own mark again.
		expect(cfg).not.toMatch(/publicDir:\s*'public'/);
		expect(cfg).toContain("publicDir: 'src/notam/public'");
	});

	it('keeps its own mark, and only the icons, in that directory', () => {
		// A stray file here ships at /notam/ and is served forever. The three
		// icons and the social card are the whole brief; anything else wants a
		// reason. The card's SOURCE is not here, being nothing the app serves:
		// assets/notam-og.svg, beside the brand masters it is the exception to.
		// The one reasoned exception is v2/, below.
		const dir = join(ROOT, 'src/notam/public');
		expect(readdirSync(dir).sort()).toEqual([
			'apple-touch-icon.png',
			'favicon.ico',
			'favicon.svg',
			'og.png',
			'v2',
		]);
		// Its own mark, not a copy of the site's: two apps, two marks.
		expect(readFileSync(join(dir, 'favicon.svg'), 'utf8')).not.toEqual(
			readFileSync(join(ROOT, 'public/favicon.svg'), 'utf8'),
		);
	});

	it('keeps the old /v2/ kill switch reachable through the mask', () => {
		// notam-viewer.net/v2/sw.js was the kill switch for the service worker
		// the old /v2/ beta installed, which otherwise serves an expired AIRAC
		// cycle out of its own precache. The mask's prefix rule maps it to
		// /notam/v2/sw.js, so it has to BE there: without it the update fetch
		// answered 404, and a 404 never unregisters a worker. It must stay a
		// kill switch, and nothing may register it afresh.
		const dir = join(ROOT, 'src/notam/public/v2');
		expect(readdirSync(dir).sort()).toEqual(['index.html', 'sw.js']);
		const sw = readFileSync(join(dir, 'sw.js'), 'utf8');
		expect(sw).toContain('self.registration.unregister()');
		expect(sw).toContain('caches.delete(');
		// Caches nothing and imports nothing: the calls, not the words, which
		// the file's own comment uses to explain what it undoes.
		expect(sw).not.toMatch(/\bcaches\.open\(|\bimportScripts\(|\bcache\.(?:put|add|addAll)\(/);
		for (const f of ['src/notam/main.ts', 'src/notam/App.svelte', 'notam.html']) {
			expect(read(f), f).not.toMatch(/serviceWorker\.register/);
		}
	});

	it('is a web page, not a shell', () => {
		const main = read('src/notam/main.ts');
		expect(main).not.toContain('@capacitor/');
		expect(main).not.toContain('native/init');
	});
});

describe("Loxodrome's service worker", () => {
	const cfg = read('vite.config.ts');

	it('hands /notam back to the network in the config', () => {
		expect(cfg).toMatch(/navigateFallbackDenylist:[\s\S]*\/\^\\\/notam/);
	});

	it('keeps the viewer out of the precache glob', () => {
		expect(cfg).toContain("'notam/**'");
	});
});

describe('the shared NOTAMs tab', () => {
	// The viewer's phone bar carries Load as a destination, so the fetch view
	// stopped being the tab's private state and became a bindable prop. Both
	// halves of that are load-bearing and neither is visible from the viewer.
	it('keeps the fetch view bindable, with the no-plan default', () => {
		const tab = read('src/lib/components/tabs/NotamsTab.svelte');
		expect(tab).toContain('showLoader = $bindable(false)');
	});

	it('mounts the print host its shared Print button needs', () => {
		// NotamsTab renders that button for BOTH apps and requestNotamPrint only
		// bumps a counter; without the host listening the control is live,
		// labelled and inert, which is what it was here (window.print called
		// zero times). Printing a briefing is this app's own business.
		expect(read('src/notam/App.svelte')).toContain('<NotamPrintHost />');
		expect(read('src/lib/components/tabs/NotamsTab.svelte')).toContain('requestNotamPrint');
	});

	it('leaves Loxodrome unbound, so its head button still owns the view', () => {
		// Loxodrome has no second door to bind to. If either of its mounts ever
		// binds this, the two apps share one fetch view through a module the
		// viewer is not even loaded in.
		for (const f of [
			'src/lib/components/Sidebar.svelte',
			'src/lib/components/phone/PhonePages.svelte',
		]) {
			expect(read(f)).not.toContain('showLoader');
		}
	});
});

describe('the docks', () => {
	// The shared workspace docks the detail pane on the RIGHT on a phone held
	// sideways, and the panel chart can dock there on a desktop; the right
	// dock's box is as wide as the --dock-r the app publishes. The viewer
	// published 0 and reserved no spacer, so every such surface was 0 px wide:
	// a tap opened an invisible detail, its close with it.
	it('publishes the right dock and reserves it beside the map', () => {
		const app = read('src/notam/App.svelte');
		expect(app).toContain('const dockR = $derived(workspace.dockPx.right)');
		expect(app).not.toMatch(/dockR: 0\b/);
		expect(app).toContain('style:inline-size="{dockR}px"');
		expect(read('src/app.css')).toMatch(/\.modal-box\.at-dock-right \{[^}]*width: var\(--dock-r, 0\);/);
	});
});

describe("Leaflet's own chrome", () => {
	// It belongs to the STYLESHEET both apps read, not to one map component's
	// scoped block behind :global() — which is a global rule with extra steps,
	// whose only effect was to hide it from the duplicate. The viewer had no
	// container background and no night theme for the map at all.
	it('states the container and the night rules once, in the shared sheet', () => {
		const css = read('src/app.css');
		expect(css).toContain('.leaflet-container');
		expect(css).toMatch(/\[data-theme=.night.\] \.leaflet-tile-pane/);
		expect(css).toMatch(/\[data-theme=.night.\] \.leaflet-bar a/);
	});

	it('out-specifies the vendor sheet on the two rules that collide', () => {
		// leaflet.css states `.leaflet-container` and
		// `.leaflet-container .leaflet-control-attribution` at the specificity a
		// bare selector here would match, and the map component imports it, so
		// it lands AFTER this file and wins on order. Inside the component's own
		// block these rules came last and needed no help; moved here they do,
		// and the `:root` prefix is the whole of it. Dropping it as noise brings
		// back Leaflet's grey container and a white attribution on a dark page,
		// which is what the move first shipped (measured, rgb(221,221,221)).
		const css = read('src/app.css');
		expect(css).toMatch(/:root \.leaflet-container/);
		expect(css).toMatch(/:root\[data-theme="night"\] \.leaflet-control-attribution/);
	});

	it('keeps no copy in either map component', () => {
		for (const f of [
			'src/lib/components/MapView.svelte',
			'src/lib/components/NotamMapView.svelte',
		]) {
			expect(read(f), f).not.toMatch(/:global\(\[data-theme=.night.\] \.leaflet/);
			expect(read(f), f).not.toMatch(/:global\(\.leaflet-container\)/);
		}
	});
});

describe('the duplicated map view', () => {
	// MapView is duplicated by decision, which means every piece of invisible
	// infrastructure has to be asserted rather than imported: nothing
	// type-checks these, and the failure is silent in the worst way, a feature
	// that draws nothing and reports nothing. Both of these had already drifted.
	const MAPS = [
		'src/lib/components/MapView.svelte',
		'src/lib/components/NotamMapView.svelte',
	];

	it('gives both maps the activation hatch patterns', () => {
		// activationLayer / supaipActivationLayer fill with `url(#hatch-…)`,
		// which resolves by id across the document. A map without the defs
		// paints an unresolvable fill, which is to say nothing at all, and the
		// viewer did exactly that for every activated zone and airspace.
		for (const f of MAPS) {
			expect(read(f), f).toContain('<HatchDefs />');
		}
	});

	it('loads the SUP AIP dataset on an activation NOTAM in both', () => {
		// The hatch effect deliberately ignores the SUP AIP layer toggle. The
		// toggle-gated LOADER is therefore not enough on its own: with the
		// toggle off, which is its default, the dataset never arrives and the
		// effect returns empty-handed forever. isActiveTrigger is the gate that
		// loads it off the briefing instead.
		for (const f of MAPS) {
			expect(read(f), f).toContain('isActiveTrigger');
		}
	});
});

describe('the entry document', () => {
	const html = read('notam.html');

	it('names the canonical address in its absolute URLs', () => {
		// og:url / canonical cannot ride the Vite base, so they name a location
		// outright, and the one they name is the OLD domain. The app is served
		// at both, notam-viewer.net masked onto loxodrome.fr/notam/ by
		// notam-viewer-net/worker.js, and the old domain carries the name and
		// the links; one static tag is self-canonical there and a cross-domain
		// canonical from here.
		expect(html).toContain('rel="canonical" href="https://notam-viewer.net/"');
		expect(html).toContain('property="og:url" content="https://notam-viewer.net/"');
	});

	it('points its social image at its OWN card', () => {
		// Its own, since it has its own mark: the site's card carries
		// Loxodrome's lockup, which is the wrong app on a notam-viewer.net
		// share. Addressed at loxodrome.fr rather than the masked domain on
		// purpose, and it is the one place that choice is right: the file is
		// served straight off Pages there, so a share of EITHER address
		// resolves the image without the mask having to be up, and the URL is
		// never shown to a reader.
		expect(html).toContain('content="https://loxodrome.fr/notam/og.png"');
	});

	it('links no PWA manifest', () => {
		expect(html).not.toContain('manifest.webmanifest');
	});

	it('keeps the keyboard-resize viewport', () => {
		// The paste box is the app's main input and the Display button sits
		// under it; without this the soft keyboard covers the button.
		expect(html).toContain('interactive-widget=resizes-content');
	});

	it('reads the same theme and locale keys as Loxodrome', () => {
		// Now genuinely shared rather than a cross-site coincidence: one
		// origin, one pair of keys, so a reader who sets a language in either
		// app finds it in the other.
		expect(html).toContain("localStorage.getItem('loxodrome:theme')");
		expect(html).toContain("localStorage.getItem('loxodrome:locale')");
	});
});

describe.runIf(built)('the composed subdirectory', () => {
	it('serves at /notam/', () => {
		expect(existsSync(join(DIST, 'index.html'))).toBe(true);
		expect(existsSync(join(DIST, 'notam.html'))).toBe(false);
	});

	it('loads its assets from under its own base', () => {
		const html = readFileSync(join(DIST, 'index.html'), 'utf8');
		expect(html).toMatch(/src="\/notam\/assets\//);
		expect(html).not.toMatch(/src="\/assets\//);
	});

	it('has not disturbed the site it lives in', () => {
		// A CNAME file in a Pages artifact SETS the custom domain, and there is
		// exactly one artifact now. Two things must hold: the site still names
		// itself, and this subdirectory names nothing.
		expect(readFileSync(join(SITE, 'CNAME'), 'utf8').trim()).toBe('loxodrome.fr');
		expect(existsSync(join(DIST, 'CNAME'))).toBe(false);
	});

	it('ships its own icons, and the document points at them under the base', () => {
		// The mask depends on this: notam-viewer.net/favicon.ico resolves by the
		// prefix rule to /notam/favicon.ico, so the icons have to BE there.
		for (const f of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) {
			expect(existsSync(join(DIST, f)), f).toBe(true);
		}
		const html = readFileSync(join(DIST, 'index.html'), 'utf8');
		expect(html).toContain('href="/notam/favicon.svg"');
		expect(html).toContain('href="/notam/favicon.ico"');
		expect(html).toContain('href="/notam/apple-touch-icon.png"');
	});

	it('ships no service worker and no datasets of its own', () => {
		// Scanned in this directory ONLY: dist/ legitimately has both a sw.js
		// and a data/, which is exactly what this app now reads instead of
		// carrying a copy.
		expect(existsSync(join(DIST, 'sw.js'))).toBe(false);
		expect(readdirSync(DIST).filter((f) => f.startsWith('workbox-'))).toEqual([]);
		expect(existsSync(join(DIST, 'data'))).toBe(false);
		// The one worker script it does ship is the old /v2/ beta's KILL
		// switch, which the mask serves at notam-viewer.net/v2/sw.js.
		expect(existsSync(join(DIST, 'v2', 'sw.js'))).toBe(true);
		expect(existsSync(join(DIST, 'v2', 'index.html'))).toBe(true);
	});

	it('is not precached by the site around it', () => {
		// The viewer keeps no precached shell. It holds because build-notam.js
		// composes this directory AFTER the main build, so Workbox never sees
		// it; assert the outcome rather than the ordering, since the ordering
		// is what a future change would get wrong.
		const sw = readFileSync(join(SITE, 'sw.js'), 'utf8');
		expect(sw).not.toMatch(/"\/?notam\/assets\//);
		expect(sw).not.toMatch(/url:"notam\//);
	});

	it('reads the datasets the surrounding site ships', async () => {
		// The manifest stopped being a copy list and stayed the statement of
		// what this app reads. Roughly fifteen of those loaders THROW on a 404
		// rather than degrading, so a name the site does not ship is a blank
		// panel in production.
		const { NOTAM_VIEWER_DATASETS } = await import('../src/notam/datasets');
		const missing = NOTAM_VIEWER_DATASETS.filter(
			(p) => !existsSync(join(SITE, p.replace(/^\//, ''))),
		);
		expect(missing).toEqual([]);
	});
});

it.runIf(!built)('could not check the composed subdirectory (no dist/notam)', () => {
	// Mirrors tests/thirdPartyLicenses.spec.ts: a green run on an unbuilt tree
	// must not read as a complete one.
	expect(built).toBe(false);
});
