/* Two rules of the shared popup shells (PopupMenu, HeadOverlay's sheet), both
 * measured in the real app over CDP and pinned here, the suite mounting no
 * components (environment: 'node').
 *
 * 1. A backdrop dismissed on the DOWN owes the page beneath nothing a touch
 *    or a pen goes on to do: the press is cancelled (its compatibility
 *    mousedown focused a field under it and moved a slider), and the click
 *    its RELEASE synthesises is swallowed (it pressed the head button that
 *    opened the popover, which then could not close it, or the map, or the
 *    control under a dialog). A mouse's click already reaches nothing, the
 *    down's target being gone. One helper (ui/dismissOnDown.ts), and every
 *    backdrop takes it.
 *
 * 2. Focus goes into the box on open and back where it came from on close,
 *    the box and never its first control. */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'svelte/compiler';

const popup = readFileSync('src/lib/components/PopupMenu.svelte', 'utf8');
const overlay = readFileSync('src/lib/components/HeadOverlay.svelte', 'utf8');

/* A window and a document standing in for the browser's, each a bare
 * EventTarget. An event is dispatched to the window then the document, the
 * order its capture phase reaches them in; the helper listens on the one and
 * ui/sheet.ts's click swallow on the other. Both modules are loaded fresh per
 * test, sheet.ts keeping a module-level deadline. */
interface Dom {
	/** A press on the backdrop: the dismissal, then the event it handled. */
	press: (pointerType: string, pointerId?: number) => Event;
	/** A pointer event at the page (a release, a cancel, a new press). */
	pointer: (type: string, pointerId?: number, isPrimary?: boolean) => void;
	/** A click at the page: was it swallowed? */
	click: () => boolean;
	closed: () => number;
}

async function stubDom(): Promise<Dom> {
	const win = new EventTarget();
	const doc = new EventTarget();
	vi.stubGlobal('window', win);
	vi.stubGlobal('document', doc);
	vi.resetModules();
	const { dismissOnDown } = await import('$lib/ui/dismissOnDown');
	let closed = 0;
	const dismiss = dismissOnDown(() => closed++);
	const fire = (e: Event): void => {
		win.dispatchEvent(e);
		doc.dispatchEvent(e);
	};
	const pointerEvent = (type: string, pointerType: string, pointerId: number, isPrimary: boolean): Event =>
		Object.assign(new Event(type, { cancelable: true }), { pointerType, pointerId, isPrimary });
	return {
		press: (pointerType, pointerId = 1) => {
			const e = pointerEvent('pointerdown', pointerType, pointerId, true);
			dismiss(e as PointerEvent);
			return e;
		},
		pointer: (type, pointerId = 1, isPrimary = true) => fire(pointerEvent(type, 'touch', pointerId, isPrimary)),
		click: () => {
			const e = new Event('click', { cancelable: true });
			fire(e);
			return e.defaultPrevented;
		},
		closed: () => closed,
	};
}

describe('a backdrop dismissed on the down', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('is wired to the one helper in the popup shell', () => {
		expect(popup).toMatch(/onpointerdown=\{dismiss\}/);
		expect(popup).toContain('const dismiss = dismissOnDown(');
	});

	it('leaves a mouse press and its click alone', async () => {
		const d = await stubDom();
		expect(d.press('mouse').defaultPrevented).toBe(false);
		expect(d.closed()).toBe(1);
		d.pointer('pointerup');
		expect(d.click()).toBe(false);
	});

	it('cancels a touch or a pen press, whose mousedown would reach what lay beneath', async () => {
		// Measured with genuine touch input: a tap dismissing a menu over a
		// text field focused it (a phone's keyboard), over a slider moved it.
		for (const kind of ['touch', 'pen']) {
			const d = await stubDom();
			expect(d.press(kind).defaultPrevented, kind).toBe(true);
			expect(d.closed()).toBe(1);
		}
	});

	it('swallows the click its release synthesises, and only that one', async () => {
		const d = await stubDom();
		d.press('touch', 7);
		d.pointer('pointerup', 7);
		expect(d.click()).toBe(true);
		expect(d.click()).toBe(false);
	});

	it('swallows it however long the press was held', async () => {
		// Armed at the press, the window lapsed under a slow press and its
		// click went through.
		vi.useFakeTimers();
		const d = await stubDom();
		d.press('touch', 3);
		vi.advanceTimersByTime(1500);
		d.pointer('pointerup', 3);
		expect(d.click()).toBe(true);
	});

	it('owes nothing for a pointer cancelled or released elsewhere', async () => {
		const d = await stubDom();
		d.press('touch', 4);
		d.pointer('pointerup', 9); // another finger
		expect(d.click(), 'another finger').toBe(false);
		d.pointer('pointercancel', 4); // the browser took the gesture: no click
		d.pointer('pointerup', 4);
		expect(d.click(), 'cancelled').toBe(false);
	});

	it('never eats the next deliberate tap after a gesture that clicked nothing', async () => {
		// A swipe that dismissed, or a pen, synthesises no click: the window
		// it arms stands down at the next press, so the tap after it counts.
		const d = await stubDom();
		d.press('touch', 5);
		d.pointer('pointerup', 5);
		d.pointer('pointerdown', 6, true);
		d.pointer('pointerup', 6);
		expect(d.click()).toBe(false);
	});

	it('lets its release listeners go after a press nobody releases', async () => {
		vi.useFakeTimers();
		const d = await stubDom();
		d.press('touch', 8);
		vi.advanceTimersByTime(60_000);
		d.pointer('pointerup', 8);
		expect(d.click()).toBe(false);
	});
});

/** AST keys that are positions or back-references, never children. */
const NOT_CHILDREN = new Set(['start', 'end', 'loc', 'metadata', 'parent']);

interface Positioned {
	start: number;
	end: number;
}

/** The handler source of every element whose class names a backdrop and which
 *  listens for the pointer's down, read through the compiler's own parser: a
 *  tag cut at its first ">" loses a handler written as an arrow, the most
 *  ordinary way to write one, and the rule was never applied to it. */
function downBackdrops(file: string, source: string): string[] {
	const out: string[] = [];
	const walk = (node: unknown): void => {
		if (!node || typeof node !== 'object') {
			return;
		}
		if (Array.isArray(node)) {
			for (const child of node) {
				walk(child);
			}
			return;
		}
		const n = node as Record<string, unknown> & { type?: string };
		if (n.type === 'RegularElement' || n.type === 'SvelteElement') {
			const attrs = (n.attributes ?? []) as (Positioned & { type: string; name?: string; value?: unknown })[];
			const cls = attrs.find((a) => a.type === 'Attribute' && a.name === 'class');
			const down = attrs.find((a) => a.type === 'Attribute' && a.name === 'onpointerdown');
			if (cls && down && /backdrop/.test(source.slice(cls.start, cls.end))) {
				const v = down.value;
				const tag = (Array.isArray(v) ? v[0] : v) as { expression?: Positioned } | undefined;
				const expr = tag?.expression;
				out.push(expr ? source.slice(expr.start, expr.end) : source.slice(down.start, down.end));
			}
		}
		for (const [key, value] of Object.entries(n)) {
			if (!NOT_CHILDREN.has(key) && value && typeof value === 'object') {
				walk(value);
			}
		}
	};
	walk(parse(source, { filename: file, modern: true }).fragment);
	return out;
}

describe('every backdrop dismissed on the down', () => {
	it('is seen by the scan however its handler is written', () => {
		const fixture = `<script>let { onClose } = $props();</script>
<button class="modal-backdrop" onpointerdown={() => onClose()}></button>
<button class={['ctx-backdrop', 'x']} onpointerdown={dismiss}></button>
<button class="other" onpointerdown={() => onClose()}></button>`;
		expect(downBackdrops('F.svelte', fixture)).toEqual(['() => onClose()', 'dismiss']);
	});

	it('takes the one helper', () => {
		// TogglesPopover and ProfileStackMenu dismissed on the down with no
		// swallow: a tap closing the profile's filter reopened it through its
		// own button, and one dismissing the chart's menu opened the column
		// under the finger. The dialogs' backdrops pressed what lay beneath.
		const files = [
			...readdirSync('src/lib/components', { recursive: true, withFileTypes: true })
				.filter((d) => d.isFile() && d.name.endsWith('.svelte'))
				.map((d) => join(d.parentPath, d.name)),
			...readdirSync('src/notam')
				.filter((n) => n.endsWith('.svelte'))
				.map((n) => join('src/notam', n)),
		];
		let seen = 0;
		for (const f of files) {
			for (const handler of downBackdrops(f, readFileSync(f, 'utf8'))) {
				seen++;
				expect(handler, f).toMatch(/^dismissOnDown\(|^dismiss$/);
			}
		}
		expect(seen).toBeGreaterThanOrEqual(9);
	});
});

describe('the popup shells', () => {
	it('focus the box on open and hand focus back on close, in every rendition', () => {
		// And the toggles popover over a surface: at full screen the surface
		// traps Tab inside its own box, and the panel beside it was out of
		// the keyboard's reach until it took focus itself.
		const toggles = readFileSync('src/lib/components/TogglesPopover.svelte', 'utf8');
		for (const [src, el] of [
			[popup, 'menuEl'],
			[overlay, 'sheetEl'],
			[toggles, 'panelEl'],
		] as const) {
			expect(src).toMatch(new RegExp(`bind:this=\\{${el}\\}\\s+tabindex="-1"`));
			expect(src).toMatch(/if \(!box\.contains\(document\.activeElement\)\) \{\s*box\.focus\(\{ preventScroll: true \}\);/);
			expect(src).toMatch(
				/if \(from\?\.isConnected && \(now === null \|\| now === document\.body \|\| box\.contains\(now\)\)\) \{\s*from\.focus/,
			);
		}
	});
});

describe('the surfaces the popups sit over', () => {
	const shell = readFileSync('src/lib/components/SurfaceShell.svelte', 'utf8');

	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it('let a menu consume its own Escape before the surface sees it', () => {
		// Both the shell and the menu listen on the window; the menu's in the
		// CAPTURE phase with the key stopped, or one Escape closed the whole
		// full-screen surface under the menu it was meant for.
		expect(popup).toMatch(
			/onkeydowncapture=\{\(e: KeyboardEvent\) => \{\s*if \(e\.key === 'Escape' && open && escapeIsMine\(\)\) \{\s*e\.stopPropagation\(\);/,
		);
		expect(overlay).toMatch(
			/onkeydowncapture=\{\(e: KeyboardEvent\) => \{\s*if \(e\.key === 'Escape' && open && ui\.isMobile && escapeIsMine\(\)\) \{\s*e\.stopPropagation\(\);/,
		);
		expect(shell).toMatch(/<svelte:window\s+onkeydown=/);
	});

	it('leave the Escape to a dialog opened over the menu', () => {
		// The capture phase reaches the menu first: with a dialog opened over
		// it from the keyboard ("?", Ctrl+K), the first Escape closed the
		// hidden menu and left the dialog up. The key is the menu's only
		// while the keyboard is in it, or nowhere.
		for (const [src, el] of [
			[popup, 'menuEl'],
			[overlay, 'sheetEl'],
		] as const) {
			expect(src).toMatch(
				new RegExp(
					`function escapeIsMine\\(\\): boolean \\{\\s*const at = document\\.activeElement;\\s*return at === null \\|\\| at === document\\.body \\|\\| \\(${el}\\?\\.contains\\(at\\) \\?\\? false\\);`,
				),
			);
		}
	});

	it('close an actions menu with its surface, and with its rows', () => {
		expect(shell).toMatch(/if \(!open \|\| !actions\) \{\s*actionsOpen = false;\s*\}/);
	});

	it('leave a profile window alone while the chart is closed', () => {
		// Its columns empty then and the bounds shrink to the bare band: a held
		// window came back from a reopen moved.
		const modal = readFileSync('src/lib/components/VerticalProfileModal.svelte', 'utf8');
		expect(modal).toMatch(/if \(placementOf\(id\) === null\) \{\s*return;\s*\}\s*const lo = fitFloorFt;/);
	});
});
