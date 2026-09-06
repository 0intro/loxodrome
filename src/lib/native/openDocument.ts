/* Hand a file the app has written to whichever app on the phone opens that
 * kind of file (OpenDocumentPlugin.java): a stored AIP document to a PDF
 * viewer, an exported route to SDVFR.
 *
 * The Android shell only. On the web a document link is an ordinary anchor to
 * the SIA and an export is a download, both of which need nothing from us.
 * docs/android.md carries the contract. */

import { isNativeApp } from '$lib/native/platform';

interface NativeDocViewer {
	view(options: { uri: string; mime?: string }): Promise<void>;
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

/** Open a file:// URI inside the app's own storage in whichever app handles
 *  `mime`. False when the shell cannot (an older build without the plugin, a
 *  device with no such app), which is the caller's cue to do something else
 *  rather than leave the tap doing nothing: fall back to the online link, or
 *  to the share sheet.
 *
 *  An older shell ignores the mime and opens the file as a PDF, which is why
 *  the parameter is optional on the Java side too. */
export async function viewFile(uri: string, mime: string): Promise<boolean> {
	if (!isNativeApp()) {
		return false;
	}
	try {
		await ensurePlugin();
		await viewer!.view({ uri, mime });
		return true;
	} catch {
		return false;
	}
}

/** The AIP documents' own call: a stored plate in a PDF viewer. */
export async function viewPdf(uri: string): Promise<boolean> {
	return viewFile(uri, 'application/pdf');
}
