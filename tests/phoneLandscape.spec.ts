/* The landscape phone (docs/workspace-surfaces.md "Phones"): one watcher
 * in App stamps the flag and the root class and reflows the surfaces; the
 * bar becomes a rail down the left edge, and the pages, the full surfaces
 * and their backdrop start after it. The geometry itself is the D6 drive's
 * (local/redesign-verify/landscape.mjs); these pin the wiring. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHONE_LANDSCAPE_MEDIA, MOBILE_UI_MEDIA } from '$lib/state/ui.svelte';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

describe('the landscape phone', () => {
	it('is the second clause of the phone layout media, named once', () => {
		expect(MOBILE_UI_MEDIA).toContain(PHONE_LANDSCAPE_MEDIA);
	});

	it('is watched in App beside the phone flag and reflows the surfaces on a turn', () => {
		const app = read('src/App.svelte');
		expect(app).toContain('window.matchMedia(PHONE_LANDSCAPE_MEDIA)');
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
		for (const f of ['src/lib/components/ConfirmDialog.svelte', 'src/lib/components/ResetDialog.svelte']) {
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
