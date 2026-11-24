/* The Android shell outlives its WebView's renderer (docs/android.md "The
 * renderer's death"): the activity's listener answers onRenderProcessGone,
 * marks the recorder's seam dead and rebuilds the activity, and leaves a
 * second death within a minute of a rebuild to Chromium. Wiring pins: the
 * behaviour itself is measured on the device. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');
const ACTIVITY = 'android/app/src/main/java/fr/loxodrome/app/MainActivity.java';

describe("the renderer's death", () => {
	const java = read(ACTIVITY);
	const rebuild = java.slice(java.indexOf('private boolean rebuildPage('));

	it('is answered by the activity, never left to Chromium', () => {
		expect(java).toMatch(/getBridge\(\)\.addWebViewListener\(\s*new WebViewListener\(\) \{\s*@Override\s*public boolean onRenderProcessGone\(WebView view, RenderProcessGoneDetail detail\) \{\s*return rebuildPage\(view, detail\.didCrash\(\)\);/);
	});

	it('marks the recorder seam dead before anything else, so the service records on', () => {
		expect(rebuild).toMatch(/^private boolean rebuildPage\(WebView view, boolean crashed\) \{\s*NavRecorderPlugin\.webDied\(\);/);
		expect(read('android/app/src/main/java/fr/loxodrome/app/NavRecorderPlugin.java')).toMatch(/static void webDied\(\) \{\s*instance = null;\s*NavRecorderService\.noteWebDied\(\);/);
	});

	it('destroys the dead WebView before the rebuild, so the next renderer counts one', () => {
		// recreate() alone leaves it alive, and one death then reaches the
		// listener twice (measured on the Redmi Note 12 5G, 2026-11-23).
		expect(rebuild).toMatch(/rebuiltAtMs = now;[\s\S]*parent\.removeView\(view\);\s*\}\s*view\.destroy\(\);[\s\S]*recreate\(\);/);
	});

	it('rebuilds the activity in the same process, and ends the app on a second death within a minute', () => {
		expect(java).toContain('private static final long REBUILD_GUARD_MS = 60_000L;');
		expect(rebuild).toMatch(/if \(rebuiltAtMs >= 0 && now - rebuiltAtMs < REBUILD_GUARD_MS\) \{[^}]*return false;\s*\}\s*rebuiltAtMs = now;/);
		expect(rebuild).toMatch(/recreate\(\);[\s\S]*return true;\s*\}/);
	});
});
