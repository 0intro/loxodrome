/* Opening an AIP document: the one chokepoint every VAC / SUP AIP link goes
 * through (docs/offline-maps.md).
 *
 * A document lives inside a downloaded pack in OPFS, which no FileProvider
 * root can reach, so opening one extracts it to the app cache and hands that
 * file to the phone's PDF viewer. The extract is namespaced by AIRAC cycle:
 * a promoted pack carries the same file names with different content, and a
 * stale extract shadowing the new plate is the one failure this feature must
 * not have.
 *
 * Everything here is a no-op off the Android shell, where the caller's own
 * anchor opens the SIA link exactly as it does today. */

import { docBlob, hasDoc } from '$lib/offline/docPack';
import { supPackId, type DocPackId } from '$lib/offline/docPacks';
import { isNativeApp } from '$lib/native/platform';
import { viewPdf } from '$lib/native/openDocument';
import { docPackFor } from '$lib/state/offlineDocs.svelte';
import { blobToBase64 } from '$lib/ui/dom';

/** Where the extracted copies live under the app cache. */
const CACHE_DIR = 'aip-docs';

/** Which pack holds a document, and under which name. The VAC packs are
 *  tried current-first: after a promotion only the current one exists, and
 *  before one the pre-release pack holds next cycle's edition of the same
 *  plate, which must not win while this cycle's is on disk. */
function locate(name: string, sup: boolean, lang: 'fr' | 'en'): DocPackId | null {
	const candidates: DocPackId[] = sup ? [supPackId(lang), supPackId(lang === 'en' ? 'fr' : 'en')] : ['fr-vac', 'fr-vac-next'];
	for (const id of candidates) {
		const pack = docPackFor(id);
		if (pack && hasDoc(pack, name)) {
			return id;
		}
	}
	return null;
}

/** True when a stored pack carries this document, so a panel can mark the
 *  link as available offline. Reads the open packs, so callers in a reactive
 *  context must also read `offlineDocs.gen` to re-run when one lands. */
export function storedDoc(name: string | null, sup: boolean, lang: 'fr' | 'en'): DocPackId | null {
	if (!name) {
		return null;
	}
	return locate(name, sup, lang);
}

/** The AIRAC cycle a stored document belongs to, or null when its set has no
 *  cycle. The panel prints it beside the link whenever it is not the one in
 *  force: the system viewer shows nothing of ours, so the tap is the last
 *  place a pilot can be told the plate is superseded. */
export function storedDocCycle(id: DocPackId): string | null {
	return docPackFor(id)?.index.cycle ?? null;
}

/** Open a stored document in the phone's PDF viewer. False when there is no
 *  stored copy or the hand-off failed, which is the caller's cue to let its
 *  own link open the online PDF instead. */
export async function openStoredDoc(
	name: string,
	sup: boolean,
	lang: 'fr' | 'en',
): Promise<boolean> {
	if (!isNativeApp()) {
		return false;
	}
	const id = locate(name, sup, lang);
	if (!id) {
		return false;
	}
	const pack = docPackFor(id);
	const blob = pack ? docBlob(pack, name) : null;
	if (!pack || !blob) {
		return false;
	}
	const dir = `${CACHE_DIR}/${pack.index.cycle ?? pack.index.set}`;
	const path = `${dir}/${name}`;
	try {
		const { Filesystem, Directory } = await import('@capacitor/filesystem');
		let uri: string;
		try {
			// Already extracted: reuse it rather than re-encoding a megabyte.
			uri = (await Filesystem.getUri({ path, directory: Directory.Cache })).uri;
			await Filesystem.stat({ path, directory: Directory.Cache });
		} catch {
			const written = await Filesystem.writeFile({
				path,
				directory: Directory.Cache,
				data: await blobToBase64(blob),
				recursive: true,
			});
			uri = written.uri;
		}
		return await viewPdf(uri);
	} catch {
		return false;
	}
}

/** Intercept a click on a document link.
 *
 * The decision is SYNCHRONOUS, because preventDefault has to be: if a stored
 * copy exists the anchor is stopped and the local file opens, otherwise the
 * anchor is left alone and does exactly what it does today. A hand-off that
 * then fails (no PDF viewer, a shell without the plugin) falls back to the
 * online link, so the tap never does nothing. */
export function docLinkClick(
	e: MouseEvent,
	href: string,
	name: string | null,
	sup: boolean,
	lang: 'fr' | 'en',
): void {
	if (!name || !storedDoc(name, sup, lang)) {
		return;
	}
	e.preventDefault();
	void openStoredDoc(name, sup, lang).then((ok) => {
		if (!ok) {
			window.open(href, '_blank', 'noopener,noreferrer');
		}
	});
}

/** Drop extracted copies belonging to cycles no longer held, so a superseded
 *  edition does not keep hundreds of megabytes of cache alive after its pack
 *  has been replaced. Best effort: the cache is Android's to reclaim anyway. */
export async function purgeDocCache(keepCycles: readonly string[]): Promise<void> {
	if (!isNativeApp()) {
		return;
	}
	try {
		const { Filesystem, Directory } = await import('@capacitor/filesystem');
		const listing = await Filesystem.readdir({ path: CACHE_DIR, directory: Directory.Cache });
		for (const entry of listing.files) {
			if (entry.type === 'directory' && !keepCycles.includes(entry.name)) {
				await Filesystem.rmdir({
					path: `${CACHE_DIR}/${entry.name}`,
					directory: Directory.Cache,
					recursive: true,
				});
			}
		}
	} catch {
		/* nothing extracted yet, or the cache is already gone */
	}
}
