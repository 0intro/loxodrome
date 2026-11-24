/* The "?" map on a phone, where the palette's Shortcuts and gestures row
 * opens it. It registered nothing on the back-close stack, so the Android
 * Back key closed the pane registered beneath it (the nav log, a profile,
 * the detail) or minimised the app with the overlay still up. Its Back
 * effect is pinned from the source by its whole normalised body, the
 * radarCaution.spec.ts way: a client spec has no DOM to mount the
 * component in, and a substring would survive an inverted guard. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'src/lib/components/ShortcutsOverlay.svelte'), 'utf8');

/** The `$effect(() => { ... })` containing `marker`, whitespace-normalised. */
function effectAround(marker: string): string {
	const at = src.indexOf(marker);
	expect(at, marker).toBeGreaterThan(0);
	const open = src.lastIndexOf('$effect(() => {', at);
	const close = src.indexOf('});', at);
	expect(open).toBeGreaterThan(0);
	return src.slice(open, close + 3).replace(/\s+/g, ' ');
}

describe('the shortcuts overlay on a phone', () => {
	it('takes a Back entry while it is open, on the phone only', () => {
		expect(effectAround('registerBackClose(')).toBe(
			'$effect(() => { if (!shortcutsOverlay.open || !ui.isMobile) { return; } return registerBackClose(closeShortcuts); });',
		);
	});
});
