import { isNativeApp } from '$lib/native/platform';

/** Typed accessors for form-event values, so the one-off
 *  `as HTMLInputElement` cast lives in a single place.
 *
 *  Use inside handlers that receive a bare `Event` (named handlers, and
 *  inline handlers that read `e.target`). Inline handlers that already
 *  have a typed `e.currentTarget` don't need these. */
export const inputValue = (e: Event): string =>
	(e.target as HTMLInputElement | HTMLTextAreaElement).value;

export const inputChecked = (e: Event): boolean =>
	(e.target as HTMLInputElement).checked;

/** Save `data` as `filename` with the given MIME type: every file export
 *  (route / aircraft YAML, GPX, the map PDF) goes through here. Callers build
 *  the name through files/fileName.ts, the one grammar (docs/file-names.md).
 *
 *  On the web, the shared Blob -> object-URL -> anchor-click dance. In the
 *  Android shell the WebView silently ignores blob: downloads, so the file is
 *  written to the app cache and handed to the system share sheet instead
 *  (Files "save to", Drive, mail, ...; docs/android.md). */
export function downloadBlob(data: string | Blob, filename: string, mime: string): void {
	const name = flatName(filename);
	if (isNativeApp()) {
		void nativeSave(data, name);
		return;
	}
	const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

/** The last line of defence on a file name, not a sanitiser: every caller
 *  already builds one through files/fileName.ts. What it is here for is the
 *  NATIVE path, where the name becomes a path under Directory.Cache, so a
 *  stray separator would quietly write into a subdirectory (or fail) rather
 *  than name the file. Control characters go for the same reason. */
function flatName(filename: string): string {
	// eslint-disable-next-line no-control-regex -- the point is to strip them
	return filename.replace(/[/\\\u0000-\u001f\u007f]+/g, '-');
}

/** How much of a binary export crosses the bridge in ONE message. Above it
 *  the file is written in pieces: the channel is JSON, so the bytes ride it
 *  as base64, and a whole flight library in a single message is how much
 *  memory on both sides of it. */
const WRITE_CHUNK_BYTES = 2 * 1024 * 1024;

async function nativeSave(data: string | Blob, filename: string): Promise<void> {
	const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
		import('@capacitor/filesystem'),
		import('@capacitor/share'),
	]);
	const written =
		typeof data === 'string'
			? await Filesystem.writeFile({
					path: filename,
					directory: Directory.Cache,
					data,
					encoding: Encoding.UTF8,
				})
			: await writeBlobChunked(Filesystem, Directory, data, filename);
	try {
		await Share.share({ title: filename, url: written.uri });
	} catch {
		/* share sheet dismissed */
	}
}

/** Write a binary file in bridge-sized pieces: one writeFile for the first,
 *  then appendFile for the rest. A single writeFile is simpler and is what
 *  this did while every export was a few hundred KB; a flights bundle is the
 *  whole library, and it is the reason this exists. */
async function writeBlobChunked(
	Filesystem: typeof import('@capacitor/filesystem').Filesystem,
	Directory: typeof import('@capacitor/filesystem').Directory,
	blob: Blob,
	filename: string,
): Promise<{ uri: string }> {
	if (blob.size <= WRITE_CHUNK_BYTES) {
		return Filesystem.writeFile({
			path: filename,
			directory: Directory.Cache,
			data: await blobToBase64(blob),
		});
	}
	let written: { uri: string } | null = null;
	for (let at = 0; at < blob.size; at += WRITE_CHUNK_BYTES) {
		const piece = await blobToBase64(blob.slice(at, at + WRITE_CHUNK_BYTES));
		// The first call TRUNCATES any file left by an earlier export of the
		// same name; every later one appends to it.
		written = at === 0
			? await Filesystem.writeFile({ path: filename, directory: Directory.Cache, data: piece })
			: ((await Filesystem.appendFile({
					path: filename,
					directory: Directory.Cache,
					data: piece,
				})) ?? written);
	}
	// The uri comes from the first write; appendFile returns nothing.
	return written as { uri: string };
}

/** A Blob as base64, the only shape the Capacitor Filesystem plugin takes
 *  for binary data. Exported for the offline AIP documents, which extract one
 *  PDF out of a downloaded pack into the app cache before handing it to a
 *  viewer (state/aipDocOpen.ts). */
export async function blobToBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const CHUNK = 0x8000;
	let s = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(s);
}
