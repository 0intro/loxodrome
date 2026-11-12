/* Full screen rides the recording (ui/flightScreen.ts): the gate, the two
 * web calls, the leave-only-after-enter rule and the shell exception to it,
 * and the wiring pins (the event paths call it, the shell registers the
 * immersive plugin). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enterFlightScreen, leaveFlightScreen, wantsFlightScreen } from '$lib/ui/flightScreen';
import { display, setFlightFullscreen } from '$lib/state/display.svelte';

const immersive = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$lib/native/immersive', () => ({ setImmersive: immersive }));

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

	it('leaves a screen the user took themselves alone', () => {
		// Already full screen when the flight starts: the request is skipped,
		// so the screen is not this module's to give back and the stop must
		// not drop the user out of the fullscreen they asked for.
		doc.fullscreenElement = doc.documentElement;
		enterFlightScreen(true);
		expect(doc.documentElement.requestFullscreen).not.toHaveBeenCalled();
		leaveFlightScreen();
		expect(doc.exitFullscreen).not.toHaveBeenCalled();
	});
});

describe('the shell calls', () => {
	beforeEach(() => {
		immersive.mockClear();
		vi.stubGlobal('document', { documentElement: {}, fullscreenElement: null });
		vi.stubGlobal('window', { Capacitor: {} }); // the native carrier
		setFlightFullscreen(true);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		setFlightFullscreen(true);
	});

	it('hides the system bars for the flight and shows them at the stop', () => {
		enterFlightScreen(true);
		expect(immersive).toHaveBeenLastCalledWith(true);
		leaveFlightScreen();
		expect(immersive).toHaveBeenLastCalledWith(false);
	});

	it('shows them at a stop even when this module never hid them', () => {
		// The immersive state lives on the Activity and outlives a WebView
		// reload (the AIRAC / update banner's, a renderer kill whose
		// recording the boot reconcile resumes), which takes the module flag
		// back to false. Honouring it would strand the pilot with no system
		// bars for the rest of the session.
		leaveFlightScreen();
		expect(immersive).toHaveBeenCalledWith(false);
	});

	it('does nothing on a desktop layout or with the preference off', () => {
		enterFlightScreen(false);
		setFlightFullscreen(false);
		enterFlightScreen(true);
		expect(immersive).not.toHaveBeenCalledWith(true);
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

	it('gives the screen back at a boot that lands out of flight', () => {
		/* Immersive lives on the Activity and outlives the WebView: a reload
		 * whose recording does not come back has no stop to ride, so the
		 * boot itself has to reconcile the screen with the recording.
		 * Measured on the device before the fix: 838 px of WebView, bars
		 * hidden, the Fly button reading Start. */
		const init = read('src/lib/native/init.ts');
		expect(init).toMatch(/reconcileNativeRecording\(\)\.then\(\(\) => \{[\s\S]*if \(!nav\.recording\) \{\s*leaveFlightScreen\(\);/);
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
