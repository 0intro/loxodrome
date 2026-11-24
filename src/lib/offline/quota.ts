/* Whether the device can still take what is about to be written
 * (docs/offline-maps.md). One definition of the headroom rule, which the
 * chart packs, the document packs and the terrain pins all ask.
 *
 * The whole policy is FAIL OPEN: an unknown quota, an unknown need or a
 * storage manager that throws all read as "let it try". A refusal that
 * cannot be justified is a worse answer than a download that fails with its
 * own error, and every caller already renders that error.
 */

/** Kept clear of the reported quota, so a pack that exactly fits does not
 *  fill the device to its last byte and take the rest of the app down with
 *  it. */
const HEADROOM = 0.95;

export interface StorageSpace {
	usage: number;
	quota: number;
}

/** What the storage manager reports, or null when it will not say (every
 *  browser may decline, and the Android WebView routinely does). */
export async function storageSpace(): Promise<StorageSpace | null> {
	try {
		const est = await navigator.storage.estimate();
		if (est.quota === undefined || est.usage === undefined) {
			return null;
		}
		return { usage: est.usage, quota: est.quota };
	} catch {
		return null;
	}
}

/** Free bytes as the storage manager reports them; null when unknown. */
export async function freeBytes(): Promise<number | null> {
	const s = await storageSpace();
	return s === null ? null : Math.max(0, s.quota - s.usage);
}

/** Whether `needBytes` more can be written, `alreadyBytes` of it already on
 *  disk (a paused .part), keeping HEADROOM of the quota clear. */
export async function quotaAllows(
	needBytes: number | null | undefined,
	alreadyBytes = 0,
): Promise<boolean> {
	if (!needBytes) {
		return true; // unknown size: let the download try
	}
	const s = await storageSpace();
	if (s === null) {
		return true;
	}
	return needBytes - alreadyBytes <= (s.quota - s.usage) * HEADROOM;
}
