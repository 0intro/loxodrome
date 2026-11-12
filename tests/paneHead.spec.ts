/* The phone pane's head (docs/workspace-surfaces.md "Phones"): which press
 * changes the detent. Only the handle's tap does. The geometry and the
 * browser's touch adjustment are the stepper drive's (a press on the NOTAM
 * stepper's counter went to the page detent). These pin the wiring. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEAD_SLOP, SWIPE_SLOP, TAP_SLOP } from '$lib/ui/sheet';

const shell = readFileSync(join(process.cwd(), 'src/lib/components/SurfaceShell.svelte'), 'utf8');

/** The markup of the dock's edge grip, from its tag to its close. */
function gripTag(): string {
	const at = shell.indexOf('class="dock-grip no-print"');
	expect(at).toBeGreaterThan(0);
	return shell.slice(shell.lastIndexOf('<button', at), shell.indexOf('></button>', at));
}

describe('the phone pane head', () => {
	it('cycles the detent from the handle alone, the edge grip only dragging', () => {
		expect(gripTag()).toContain('onpointerdown={(e) => onGripDown(e, false)}');
		expect(shell).toMatch(/class="pane-handle no-print"[^>]*onpointerdown=\{onGripDown\}/s);
	});

	it('lets every press over a portrait pane head through the grip to the head', () => {
		// The grip straddles the box's top edge, and a pane's head starts
		// there: over it, the grip covered the top of the head's controls,
		// and touch adjustment handed it the presses on the head's text.
		expect(shell).toContain("const headDrags = $derived(pane && gripEdge === 'bottom');");
		expect(gripTag()).toContain('class:on-head={headDrags}');
		expect(shell).toMatch(/\.dock-grip\.on-head \{\s*pointer-events: none;\s*\}/);
	});

	it('claims every touch on a head that drags, the X and the actions button included', () => {
		// Left to the browser, a drag begun on the X or the actions button
		// was taken for a pan of its own and the pointer cancelled.
		expect(shell).toMatch(/header\.drags \{\s*touch-action: none;\s*\}/);
	});

	it('keeps a press on the head\'s bare text in the head, a target of its own', () => {
		// Chromium's touch adjustment hands a press on text that answers
		// nothing to the nearest element that does, measured: the map above
		// the pane once the grip let the presses through. A :hover style is
		// one of the marks it reads (a native pointerdown listener is not).
		expect(shell).toMatch(/<header\s+class="modal-header"\s+class:pane-head=\{pane\}\s+class:drags=\{headDrags\}/);
		expect(shell).toMatch(/header\.drags:hover \{\s*cursor: grab;\s*\}/);
	});

	it('arms a head press into a drag past the roll a browser still clicks', () => {
		const fn = shell.slice(shell.indexOf('function headerDragDown('), shell.indexOf('/** Set while a header press is armed'));
		expect(fn).toContain('if (Math.abs(ev.clientY - startY) < HEAD_SLOP) {');
		// Headless Chromium made a click of a tap that rolled 12 px and
		// dropped the one of a 16 px roll: a drag taking the press
		// swallows that click.
		expect(HEAD_SLOP).toBeGreaterThanOrEqual(16);
		expect(HEAD_SLOP).toBeGreaterThan(TAP_SLOP);
		// A head drag can be a flick: it has to leave the slop behind first.
		expect(SWIPE_SLOP).toBeGreaterThan(HEAD_SLOP);
	});
});
