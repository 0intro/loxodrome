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
		expect(css).toMatch(/:root\.mobile-landscape \.modal-box\.at-full,\n:root\.mobile-landscape \.modal-backdrop \{[^}]*left: calc\(var\(--phone-rail-w\) \+ var\(--sal\)\);/s);
		expect(read('src/App.svelte')).toMatch(/:global\(:root\.mobile-landscape\) \.app \{[^}]*padding-left: calc\(var\(--phone-rail-w\) \+ var\(--sal\)\);/s);
	});
});
