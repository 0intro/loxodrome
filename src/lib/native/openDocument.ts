/* Hand a stored PDF to the phone's own viewer (OpenDocumentPlugin.java).
 *
 * The Android shell only: on the web a document link is an ordinary anchor
 * to the SIA, which needs nothing from us. docs/android.md carries the
 * contract. */

import { isNativeApp } from '$lib/native/platform';

interface NativeDocViewer {
	view(options: { uri: string }): Promise<void>;
}

let viewer: NativeDocViewer | null = null;

/* Resolves to nothing on purpose: a plugin handle is a Proxy that answers
 * EVERY property, so returning one out of an async function makes the await
 * machinery ask it for `.then` and Capacitor turns that into a plugin call
 * ("OpenDocument.then() is not implemented"), which rejects before the caller
 * ever sees the handle. Park it in the module instead. */
async function ensurePlugin(): Promise<void> {
	if (!viewer) {
		const { registerPlugin } = await import('@capacitor/core');
		viewer = registerPlugin<NativeDocViewer>('OpenDocument');
	}
}

/** Open a file:// URI inside the app's own storage in a PDF viewer. False
 *  when the shell cannot (an older build without the plugin, or a device
 *  with no PDF viewer at all), which is the caller's cue to fall back to the
 *  online link rather than leave the tap doing nothing. */
export async function viewPdf(uri: string): Promise<boolean> {
	if (!isNativeApp()) {
		return false;
	}
	try {
		await ensurePlugin();
		await viewer!.view({ uri });
		return true;
	} catch {
		return false;
	}
}
