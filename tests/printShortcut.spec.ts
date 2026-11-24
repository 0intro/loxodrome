/* What Ctrl/Cmd+P does (state/printShortcut.ts): it presses the printer of
 * the window in front, or the app's own; it leaves the key to the browser
 * where there is nothing to press and for the chords the browser owns; and
 * it holds a key held down, a standing question and a print already running.
 * Then the registry the listener reads (ui/surfacePrint.svelte.ts), and the
 * wiring both apps and every printing surface owe it, read from the sources. */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { KeyLike } from '$lib/state/planShortcut';
import { isPrintKey, printKey, type PrintKeyState } from '$lib/state/printShortcut';
import { printerFor, registerAppPrinter, registerPrinter } from '$lib/ui/surfacePrint.svelte';

const key = (k: Partial<KeyLike>): KeyLike => ({
	key: 'p',
	ctrlKey: false,
	metaKey: false,
	altKey: false,
	shiftKey: false,
	repeat: false,
	...k,
});

const free: PrintKeyState = { blocked: false, busy: false, printer: true };

describe('Ctrl/Cmd+P', () => {
	it('presses the printer on Ctrl+P and on Cmd+P, caps lock or not', () => {
		expect(printKey(key({ ctrlKey: true }), free)).toBe('press');
		expect(printKey(key({ metaKey: true }), free)).toBe('press');
		expect(printKey(key({ ctrlKey: true, key: 'P' }), free)).toBe('press');
	});

	it('leaves every other key, the chords the browser owns, and nothing to press, to the browser', () => {
		expect(printKey(key({}), free)).toBe('pass');
		expect(printKey(key({ ctrlKey: true, key: 'o' }), free)).toBe('pass');
		// Chromium's system dialog, Firefox's private window.
		expect(printKey(key({ ctrlKey: true, shiftKey: true, key: 'P' }), free)).toBe('pass');
		// AltGr arrives as Ctrl+Alt on Windows layouts.
		expect(printKey(key({ ctrlKey: true, altKey: true }), free)).toBe('pass');
		expect(printKey(key({ ctrlKey: true }), { ...free, printer: false })).toBe('pass');
		expect(isPrintKey(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
	});

	it('holds a key held down, a standing question and a print already running, printer or not', () => {
		for (const printer of [true, false]) {
			expect(printKey(key({ ctrlKey: true, repeat: true }), { ...free, printer })).toBe('hold');
			expect(printKey(key({ ctrlKey: true }), { ...free, printer, blocked: true })).toBe('hold');
			expect(printKey(key({ ctrlKey: true }), { ...free, printer, busy: true })).toBe('hold');
		}
	});
});

describe('the printer the key presses', () => {
	it('is the window\'s, or with none open the app\'s, a window without one never falling through', () => {
		const app = vi.fn();
		const profile = vi.fn();
		const offApp = registerAppPrinter(() => app);
		const offProfile = registerPrinter('routeProfile', () => profile);
		const offAbout = registerPrinter('about', () => null);
		try {
			expect(printerFor(null)).toBe(app);
			expect(printerFor('routeProfile')).toBe(profile);
			expect(printerFor('about')).toBeNull();
			expect(printerFor('flights')).toBeNull();
		} finally {
			offAbout();
			offProfile();
			offApp();
		}
		expect(printerFor(null)).toBeNull();
		expect(printerFor('routeProfile')).toBeNull();
	});

	it('is read when the key is pressed, so a printer the surface withdraws is gone', () => {
		let plottable = true;
		const press = vi.fn();
		const off = registerPrinter('routeProfile', () => (plottable ? press : null));
		try {
			expect(printerFor('routeProfile')).toBe(press);
			plottable = false;
			expect(printerFor('routeProfile')).toBeNull();
		} finally {
			off();
		}
	});
});

describe('the wiring', () => {
	const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

	it('is installed by both apps, each with the printer it presses with no window open', () => {
		expect(read('src/App.svelte')).toContain('onMount(() => listenForPrintKey());');
		const viewer = read('src/notam/App.svelte');
		expect(viewer).toContain('onMount(() => listenForPrintKey());');
		expect(viewer).toContain('registerAppPrinter(() => (orderedNotamOwnerSections().length > 0 ? requestNotamPrint : null))');
		expect(read('src/lib/components/Toolbar.svelte')).toContain('registerAppPrinter(() => {');
	});

	it('gives every surface with a printer of its own a printer to press', () => {
		const shell = read('src/lib/components/SurfaceShell.svelte');
		expect(shell).toContain("registerPrinter(id, () => onPrint ?? (actions && actionsIcon === 'printer' ? openActions : null))");
		expect(read('src/lib/components/RouteProfileModal.svelte')).toContain("onPrint={plottable ? () => requestPackPrint('profiles') : undefined}");
		expect(read('src/lib/components/NavProfileModal.svelte')).toContain("onPrint={enough ? () => void printSurface('navProfile') : undefined}");
		expect(read('src/lib/components/FlightsModal.svelte')).toContain("onPrint={flightsModal.view === 'flights' ? () => void printSurface('flights') : undefined}");
		expect(read('src/lib/components/FlightPrepModal.svelte')).toContain("onPrint={() => requestPackPrint('prep')}");
		for (const p of ['src/lib/components/FlightPrepModal.svelte', 'src/lib/components/NavLogModal.svelte']) {
			expect(read(p), p).toContain('actionsIcon="printer"');
		}
	});
});
