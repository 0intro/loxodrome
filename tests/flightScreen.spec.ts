/* Full screen rides the recording (ui/flightScreen.ts): the gate, the two
 * web calls, the leave-only-after-enter rule, and the wiring pins (the
 * event paths call it, the shell registers the immersive plugin). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enterFlightScreen, leaveFlightScreen, wantsFlightScreen } from '$lib/ui/flightScreen';
import { display, setFlightFullscreen } from '$lib/state/display.svelte';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

describe('wantsFlightScreen', () => {
	it('is the phone layout and the preference together', () => {
		expect(wantsFlightScreen(true, true)).toBe(true);
		expect(wantsFlightScreen(false, true)).toBe(false);
		expect(wantsFlightScreen(true, false)).toBe(false);
	});
});

describe('the browser calls', () => {
	let doc: { documentElement: { requestFullscreen: ReturnType<typeof vi.fn> }; fullscreenElement: unknown; exitFullscreen: ReturnType<typeof vi.fn> };
	beforeEach(() => {
		doc = {
			documentElement: { requestFullscreen: vi.fn(() => Promise.resolve()) },
			fullscreenElement: null,
			exitFullscreen: vi.fn(() => Promise.resolve()),
		};
		vi.stubGlobal('document', doc);
		vi.stubGlobal('window', {}); // no Capacitor: the browser carrier
		setFlightFullscreen(true);
	});
	afterEach(() => {
		leaveFlightScreen();
		vi.unstubAllGlobals();
		setFlightFullscreen(true);
	});

	it('asks for fullscreen on a phone and exits at the stop', () => {
		enterFlightScreen(true);
		expect(doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
		doc.fullscreenElement = doc.documentElement;
		leaveFlightScreen();
		expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
	});

	it('does nothing on desktop or with the preference off', () => {
		enterFlightScreen(false);
		setFlightFullscreen(false);
		expect(display.flightFullscreen).toBe(false);
		enterFlightScreen(true);
		expect(doc.documentElement.requestFullscreen).not.toHaveBeenCalled();
		doc.fullscreenElement = doc.documentElement;
		leaveFlightScreen();
		expect(doc.exitFullscreen).not.toHaveBeenCalled();
	});

	it('never exits a screen it did not take', () => {
		doc.fullscreenElement = doc.documentElement;
		leaveFlightScreen();
		expect(doc.exitFullscreen).not.toHaveBeenCalled();
	});

	it('skips the request when the document is already fullscreen', () => {
		doc.fullscreenElement = doc.documentElement;
		enterFlightScreen(true);
		expect(doc.documentElement.requestFullscreen).not.toHaveBeenCalled();
		leaveFlightScreen();
		expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
	});
});

describe('the wiring', () => {
	it('is called from the flight start and from every stop, never from an effect', () => {
		const start = read('src/lib/state/flightAction.svelte.ts');
		expect(start).toMatch(/continueRecording\(\);\n\t\}\n(?:\t\/\/[^\n]*\n)*\tif \(nav\.recording\) \{\n\t\tenterFlightScreen\(ui\.isMobile\);/);
		const rec = read('src/lib/state/navRecording.svelte.ts');
		const stop = rec.slice(rec.indexOf('export function stopRecording'));
		expect(stop.slice(0, stop.indexOf('\n}\n'))).toContain('leaveFlightScreen();');
		expect(rec).not.toMatch(/\$effect\([^)]*leaveFlightScreen/);
	});

	it('registers the immersive plugin in the shell', () => {
		expect(read('android/app/src/main/java/fr/loxodrome/app/MainActivity.java')).toContain('registerPlugin(ImmersivePlugin.class);');
		const java = read('android/app/src/main/java/fr/loxodrome/app/ImmersivePlugin.java');
		expect(java).toContain('@CapacitorPlugin(name = "Immersive")');
		expect(java).toContain('public void hide(PluginCall call)');
		expect(java).toContain('public void show(PluginCall call)');
		expect(read('src/lib/native/immersive.ts')).toContain("registerPlugin<ImmersivePlugin>('Immersive')");
	});
});
