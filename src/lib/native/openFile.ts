/* Files handed to the app by Android (docs/android.md).
 *
 * The manifest claims ACTION_VIEW and ACTION_SEND for the types our files come
 * typed as, and OpenFilePlugin.java reads the granted content:// URI and hands
 * back the display name plus the text as one `open` event. Registering the
 * listener is all this side has to do, for either arrival: a file that STARTED
 * the app is notified before the web app boots and Capacitor retains it until
 * this listener exists.
 *
 * No-op on the web, where the browser has no such channel; the dynamic import
 * keeps @capacitor/* out of the web bundle (platform.ts). */

import { base64Bytes } from '$lib/files/kmz';
import { isNativeApp } from '$lib/native/platform';

export interface IncomingFile {
	/** The provider's display name; '' when it publishes none. */
	name: string;
	text: string;
	/** Base64 of the raw bytes, sent INSTEAD of usable text when the file is
	 *  binary (a KMZ is a ZIP): decoding those as UTF-8 destroys them, and
	 *  this channel is JSON, so they ride encoded (docs/android.md). Small
	 *  files only; anything bigger arrives as `path`. */
	bytes?: string;
	/** A file the plugin copied into the app cache instead of sending its
	 *  bytes, because the bridge is a JSON channel and a whole flight
	 *  library would cross it as one enormous base64 string. Read it with
	 *  `bytesOfIncoming`, which fetches it through the local bridge URL
	 *  (docs/android.md). */
	path?: string;
}

/** The bytes of an incoming file, however the plugin chose to send them:
 *  null when it sent usable text instead.
 *
 *  A `path` is fetched rather than decoded, through
 *  `Capacitor.convertFileSrc()`, which maps an app-private file onto the
 *  bridge's own https://localhost/_capacitor_file_/... URL. That is the same
 *  origin the app itself is served from, so it is an ordinary same-origin
 *  fetch, and the bytes never become a base64 string in a JSON message. It
 *  is what lets a bundle be as large as the flight library actually is. */
export async function bytesOfIncoming(f: IncomingFile): Promise<Uint8Array | null> {
	if (f.path) {
		const { Capacitor } = await import('@capacitor/core');
		const res = await fetch(Capacitor.convertFileSrc(f.path));
		if (!res.ok) {
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			throw new Error(`cannot read the picked file (${res.status})`);
		}
		return new Uint8Array(await res.arrayBuffer());
	}
	return f.bytes ? base64Bytes(f.bytes) : null;
}

interface NativeOpener {
	addListener(event: 'open', handler: (file: IncomingFile) => void): Promise<unknown>;
	pick(): Promise<void>;
	pickMany(): Promise<{ files?: IncomingFile[] }>;
}

let opener: NativeOpener | null = null;

/* Resolves to nothing on purpose: a plugin handle is a Proxy that answers
 * EVERY property, so returning one out of an async function makes the await
 * machinery ask it for `.then` and Capacitor turns that into a plugin call
 * ("OpenFile.then() is not implemented"), which rejects before the caller ever
 * sees the handle. Park it in the module instead. */
async function ensurePlugin(): Promise<void> {
	if (!opener) {
		const { registerPlugin } = await import('@capacitor/core');
		opener = registerPlugin<NativeOpener>('OpenFile');
	}
}

export async function watchIncomingFiles(handle: (file: IncomingFile) => void): Promise<void> {
	if (!isNativeApp()) {
		return;
	}
	try {
		await ensurePlugin();
		await opener?.addListener('open', handle);
	} catch {
		/* An older shell without the plugin: the app simply opens empty. */
	}
}

/**
 * Ask for a file natively, instead of through the WebView's own file chooser.
 * The picked file comes back down the SAME `open` event an incoming intent
 * uses, so the caller only has to launch this; the dispatcher does the rest.
 * Throws when the file could not be read; a dismissed picker resolves.
 */
export async function pickIncomingFile(): Promise<void> {
	await ensurePlugin();
	await opener?.pick();
}

/**
 * Ask for SEVERAL files natively (the flights library's batch importer). They
 * come back as this call's own result rather than down the `open` event: the
 * importer is their destination, and a route file means a remembered plan
 * there where the dispatcher would load it into the workspace. Empty when the
 * picker was dismissed, or on a shell too old to carry the method.
 */
export async function pickIncomingFiles(): Promise<IncomingFile[]> {
	if (!isNativeApp()) {
		return [];
	}
	try {
		await ensurePlugin();
		return (await opener?.pickMany())?.files ?? [];
	} catch {
		return [];
	}
}
