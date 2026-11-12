/* The landscape phone (docs/workspace-surfaces.md "Phones"): one watcher
 * in App stamps the flag and the root class and reflows the surfaces; the
 * bar becomes a rail down the left edge, and the pages, the full surfaces
 * and their backdrop start after it. The geometry itself is the D6 drive's
 * (local/redesign-verify/landscape.mjs). These pin the criterion and the
 * wiring. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { layoutFacts, phoneLayout, watchLayout } from '$lib/state/ui.svelte';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

interface Window {
	coarse: boolean;
	screen: [number, number];
	viewport: [number, number];
}

/* A media query answered for one window, as a browser would: every feature
 * the layout code could ask, so a criterion that reads the viewport's
 * height is answered with the height the keyboard left. */
function matches(query: string, w: Window): boolean {
	const [vw, vh] = w.viewport;
	const feature = (f: string): boolean => {
		const [name, value] = f.split(':').map((x) => x.trim());
		const px = parseFloat(value);
		switch (name) {
			case 'pointer':
				return (value === 'coarse') === w.coarse;
			case 'max-width':
				return vw <= px;
			case 'min-width':
				return vw >= px;
			case 'max-height':
				return vh <= px;
			case 'min-height':
				return vh >= px;
			case 'orientation':
				return (vw > vh ? 'landscape' : 'portrait') === value;
			default:
				throw new Error(`media feature ${f} is not answered here`);
		}
	};
	return query.split(',').some((part) => part.replace(/[()]/g, ' ').split(/\band\b/).every((f) => feature(f)));
}

function at(w: Window): { mobile: boolean; landscape: boolean } {
	const [vw, vh] = w.viewport;
	vi.stubGlobal('window', { matchMedia: (q: string) => ({ matches: matches(q, w) }), innerWidth: vw, innerHeight: vh });
	vi.stubGlobal('screen', { width: w.screen[0], height: w.screen[1] });
	vi.stubGlobal('document', { documentElement: { clientWidth: vw, clientHeight: vh } });
	return phoneLayout(layoutFacts());
}

const UPRIGHT = { mobile: true, landscape: false };
const SIDEWAYS = { mobile: true, landscape: true };
const DESKTOP = { mobile: false, landscape: false };

/* The first fourteen rows were measured on the Redmi Note 12 (Android 14)
 * on 2026-11-09 in Chrome 156, Firefox 159 and the APK's WebView 156: the
 * screen and the viewport in CSS px, the soft keyboard down, then up. The
 * keyboard takes the viewport's height, down to 95 px. Firefox fires a
 * turn's orientation event before its resize, the screen turned and the
 * viewport not yet. The rest are the other screens the rule separates. */
const WINDOWS: [string, Window, { mobile: boolean; landscape: boolean }][] = [
	['Chrome upright', { coarse: true, screen: [393, 873], viewport: [392, 735] }, UPRIGHT],
	['Chrome upright, keyboard up', { coarse: true, screen: [393, 873], viewport: [392, 416] }, UPRIGHT],
	['Chrome sideways', { coarse: true, screen: [873, 393], viewport: [791, 302] }, SIDEWAYS],
	['Chrome sideways, keyboard up', { coarse: true, screen: [873, 393], viewport: [791, 102] }, SIDEWAYS],
	['Firefox upright', { coarse: true, screen: [396, 880], viewport: [396, 733] }, UPRIGHT],
	['Firefox upright, keyboard up', { coarse: true, screen: [396, 880], viewport: [396, 476] }, UPRIGHT],
	['Firefox sideways', { coarse: true, screen: [880, 396], viewport: [798, 297] }, SIDEWAYS],
	['Firefox sideways, keyboard up', { coarse: true, screen: [880, 396], viewport: [798, 95] }, SIDEWAYS],
	['Firefox turning sideways, the viewport still upright', { coarse: true, screen: [880, 396], viewport: [396, 733] }, UPRIGHT],
	['Firefox turning upright, the viewport still sideways', { coarse: true, screen: [396, 880], viewport: [798, 297] }, SIDEWAYS],
	['WebView upright', { coarse: true, screen: [393, 873], viewport: [392, 791] }, UPRIGHT],
	['WebView upright, keyboard up', { coarse: true, screen: [393, 873], viewport: [392, 489] }, UPRIGHT],
	['WebView sideways', { coarse: true, screen: [873, 393], viewport: [791, 358] }, SIDEWAYS],
	['WebView sideways, keyboard up', { coarse: true, screen: [873, 393], viewport: [791, 158] }, SIDEWAYS],
	['a tablet sideways, keyboard up', { coarse: true, screen: [1280, 800], viewport: [1280, 350] }, DESKTOP],
	['a tablet upright', { coarse: true, screen: [800, 1280], viewport: [800, 1180] }, DESKTOP],
	['a small tablet upright', { coarse: true, screen: [600, 960], viewport: [600, 900] }, UPRIGHT],
	['a small tablet sideways', { coarse: true, screen: [960, 600], viewport: [960, 540] }, DESKTOP],
	['a narrow desktop window', { coarse: false, screen: [1920, 1080], viewport: [700, 900] }, UPRIGHT],
	['a short desktop window', { coarse: false, screen: [1920, 1080], viewport: [1400, 450] }, DESKTOP],
	['a phone emulated sideways, its screen the viewport', { coarse: true, screen: [791, 302], viewport: [791, 302] }, SIDEWAYS],
];

describe('the phone layout', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each(WINDOWS)('%s', (_, w, want) => {
		expect(at(w)).toEqual(want);
	});

	it('is read again on every resize, which a turn and the keyboard both fire', () => {
		const on = vi.fn();
		const off = vi.fn();
		const mq = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
		vi.stubGlobal('window', { matchMedia: () => mq, addEventListener: on, removeEventListener: off });
		const fn = (): void => {};
		const unwatch = watchLayout(fn);
		expect(on).toHaveBeenCalledWith('resize', fn);
		expect(mq.addEventListener).toHaveBeenCalledWith('change', fn);
		unwatch();
		expect(off).toHaveBeenCalledWith('resize', fn);
		expect(mq.removeEventListener).toHaveBeenCalledWith('change', fn);
	});
});

describe('the landscape phone', () => {
	it('is watched in App beside the phone flag and reflows the surfaces on a turn', () => {
		const app = read('src/App.svelte');
		expect(app).toContain('phoneLayout(layoutFacts())');
		expect(app).toContain('return watchLayout(sync);');
		expect(app).toContain('ui.isLandscapePhone = landscape;');
		expect(app).toContain("classList.toggle('mobile-landscape', landscape)");
		expect(app).toMatch(/if \(flipped \|\| turned\) \{[\s\S]*?setStageSize\(r\.width, r\.height\);[\s\S]*?reflowSurfaces\(\);/);
	});

	it('moves the bar to a left rail and offsets the pages and the full surfaces by it', () => {
		expect(read('src/lib/components/phone/PhoneNavBar.svelte')).toMatch(/:global\(:root\.mobile-landscape\) \.phone-bar \{[^}]*position: fixed;[^}]*flex-direction: column;/s);
		expect(read('src/lib/components/phone/PhonePages.svelte')).toMatch(/:global\(:root\.mobile-landscape\) \.phone-page \{[^}]*left: calc\(var\(--phone-rail-w\) \+ var\(--sal\)\);/s);
		const css = read('src/app.css');
		expect(css).toMatch(/:root\.mobile-landscape \{\n(?:\t--[a-z-]+: [^\n]+\n)*\t--phone-rail-w: 64px;/);
		// The desktop rail's own token keeps its width: two rails, two names.
		expect(read('src/styles/theme.css')).toContain('--rail-w: 60px;');
		expect(css).toMatch(/:root\.mobile-landscape \.modal-box\.at-full,\n:root\.mobile-landscape \.modal-backdrop\.above-bar \{[^}]*left: calc\(var\(--phone-rail-w\) \+ var\(--sal\)\);/s);
		/* Only a FULL SURFACE's backdrop stops at the bar (or the rail): the
		 * bar staying reachable is what makes a bar tap a way out of the
		 * flights library or a workbook. A BLOCKING dialog's backdrop must
		 * cover it, or a tap opens a page behind a confirm nobody answered. */
		expect(css).not.toMatch(/mobile-(ui|landscape) \.modal-backdrop \{/);
		const shell = read('src/lib/components/SurfaceShell.svelte');
		expect(shell).toContain("class={['modal-backdrop', placement === 'full' && 'above-bar']}");
		for (const f of [
			'src/lib/components/ConfirmDialog.svelte',
			'src/lib/components/ResetDialog.svelte',
			'src/lib/components/SearchPalette.svelte',
		]) {
			expect(read(f)).toContain('class="modal-backdrop"');
		}
		expect(read('src/App.svelte')).toMatch(/:global\(:root\.mobile-landscape\) \.app \{[^}]*padding-left: calc\(var\(--phone-rail-w\) \+ var\(--sal\)\);/s);
	});

	it('keeps the width a drag is let go at, which its own click must not undo', () => {
		// Held sideways the pane resizes by a HORIZONTAL drag on the same
		// handle whose tap cycles the two widths, and a touch release
		// synthesises a click on it: cycling there threw the width the
		// pilot had just chosen away. The tap now rides the release's own
		// commit, like the bottom edge's onTap, and the click answers the
		// keyboard alone (`detail` 0).
		const shell = read('src/lib/components/SurfaceShell.svelte');
		expect(shell).toContain('onclick={handleKeyClick}');
		expect(shell).toMatch(/function handleKeyClick\(e: MouseEvent\): void \{\s*if \(e\.detail === 0\) \{\s*cycleDetent\(\);/);
		expect(shell).toMatch(/if \(!moved\) \{\s*if \(pane && tappable\) \{\s*settle\(\);\s*cycleDetent\(\);/);
	});

	it('leaves the head strip its own sideways scroll, the pane being a right dock', () => {
		// The whole head drags the window only where the head IS the edge a
		// sheet is dragged by. Held sideways the head's axis is the one its
		// strip scrolls along, so arming a width drag on a vertical wiggle
		// would be a gesture nobody aimed at.
		const shell = read('src/lib/components/SurfaceShell.svelte');
		const fn = shell.slice(shell.indexOf('function headerDragDown('));
		expect(fn.slice(0, fn.indexOf('\n\t}'))).toContain("gripEdge !== 'bottom'");
	});

	it('arms the head drag on the window, so a finger that leaves it still disarms', () => {
		const shell = read('src/lib/components/SurfaceShell.svelte');
		const fn = shell.slice(shell.indexOf('function headerDragDown('), shell.indexOf('/** True once a grip press'));
		expect(fn).toContain("window.addEventListener('pointerup', disarm)");
		expect(fn).toContain("window.addEventListener('pointercancel', disarm)");
		expect(fn).not.toContain('hdr.addEventListener');
	});
});
