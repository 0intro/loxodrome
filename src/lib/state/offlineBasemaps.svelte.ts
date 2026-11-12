/* Offline base-map packs: the reactive face over offline/packStore.ts for
 * the base layers whose pyramid ships whole (offline/basemapPacks.ts, Plan
 * IGN today). A READY pack makes MapView serve that base layer from the
 * device up to the archive's last zoom (map/packBaseLayer.ts); `gen` is the
 * swap signal MapView's base-layer effect reads.
 *
 * Sibling of state/offlineCharts.svelte.ts, deliberately, as offlineDocs is:
 * the three share the download, the resume, the quota check, the manifest
 * and the one offline queue, and differ in what a pack IS read with. A base
 * map also has an EDITION, the date its tiles were harvested, read off the
 * archive's metadata.
 *
 * The update rule is the siblings' (docs/offline-maps.md, "Updates"):
 * `status` is the ARCHIVE, so a held pack stays 'ready', and keeps serving,
 * while an update runs, is paused or fails; `heldBytes` and `partBytes` keep
 * the archive and the transfer apart, and Discard drops the part alone.
 *
 * Errors are CODES for the catalogs (docs/i18n.md: state stores no rendered
 * strings). */

import { BASEMAP_PACKS, basemapPackDef, type BasemapPackId } from '$lib/offline/basemapPacks';
import type { BaseLayerId } from '$lib/state/layers.svelte';
import {
	BASEMAP_PACK_FAMILY,
	deletePack as storeDelete,
	discardPart as storeDiscardPart,
	downloadPack as storeDownload,
	listPacks,
	openPack,
	opfsSupported,
	PackHttpError,
	partBytes,
} from '$lib/offline/packStore';
import { quotaAllows } from '$lib/offline/quota';
import {
	cancelDownload,
	enqueueDownload,
	isQueued,
	isRunning,
	queuedAt,
} from '$lib/state/offlineQueue.svelte';
import type { JobRef } from '$lib/offline/downloadQueue';
import type { PackErrorCode } from '$lib/state/offlineCharts.svelte';

const packRef = (id: BasemapPackId) => ({ family: BASEMAP_PACK_FAMILY, id });

export interface BasemapPackView {
	/** The ARCHIVE: 'ready' whenever one is held, an update included;
	 *  'downloading' / 'error' only for a pack with none yet. */
	status: 'none' | 'downloading' | 'ready' | 'error';
	/** 0..1 while downloading. */
	progress: number;
	/** Archive size on the server (from HEAD), null until known. */
	sizeBytes: number | null;
	/** The held archive's size, 0 when none: what Delete frees. */
	heldBytes: number;
	/** The transfer's resumable part, 0 when none: what Discard frees. */
	partBytes: number;
	downloadedAt: string | null;
	updateAvailable: boolean;
	/** The held archive's edition (YYYY-MM-DD, when IGN's tiles were
	 *  harvested), read off its metadata; null until read or when absent. */
	edition: string | null;
	error: PackErrorCode | null;
}

function blankView(): BasemapPackView {
	return {
		status: 'none',
		progress: 0,
		sizeBytes: null,
		heldBytes: 0,
		partBytes: 0,
		downloadedAt: null,
		updateAvailable: false,
		edition: null,
		error: null,
	};
}

export const offlineBasemaps = $state<{
	supported: boolean;
	ready: boolean;
	/** Bumped whenever a pack appears or disappears; MapView's base-layer
	 *  effect reads it and swaps the base layer. */
	gen: number;
	packs: Partial<Record<BasemapPackId, BasemapPackView>>;
}>({
	supported: opfsSupported(),
	ready: false,
	gen: 0,
	packs: {},
});

/** Open Files for ready packs. A plain Map on purpose: MapView reads it
 *  through basemapPack(), and `gen` alone says it changed, so a download's
 *  progress never re-runs the map's base-layer effect. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- File handles for the map layer, never rendered; gen is the signal
const files = new Map<BasemapPackId, File>();

/** Server size + etag per archive, HEADed once per session. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- session cache behind the reactive views
const remote = new Map<BasemapPackId, { bytes: number; etag: string | null }>();

const jobRef = (id: BasemapPackId): JobRef => ({ kind: 'basemap', id });

/** The reactive view, created on first use. Assign and READ BACK (see the
 *  chart sibling's view() for why). */
function view(id: BasemapPackId): BasemapPackView {
	offlineBasemaps.packs[id] ??= blankView();
	return offlineBasemaps.packs[id];
}

/** The held archive serving a base layer, if any. Not reactive: read it
 *  where `offlineBasemaps.gen` is tracked. */
export function basemapPack(id: BaseLayerId): File | null {
	const def = basemapPackDef(id);
	return def ? (files.get(def.id) ?? null) : null;
}

/** Whether a base layer is drawn from the device: the Layers tab's chip. */
export function basemapHeld(id: BaseLayerId): boolean {
	const def = basemapPackDef(id);
	return def !== undefined && offlineBasemaps.packs[def.id]?.status === 'ready';
}

/** Read a held archive's edition off its metadata, best-effort and after the
 *  File already serves: the map never waits on it. The reader is imported on
 *  first use, keeping pmtiles out of the entry chunk. */
function readEdition(id: BasemapPackId, f: File): void {
	void import('$lib/offline/filePmtiles')
		.then((m) => m.archiveInfo(f, `basemap:${id}`))
		.then((info) => {
			if (files.get(id) === f) {
				view(id).edition = info.edition;
			}
		})
		.catch(() => {
			/* an unreadable edition leaves the row without one */
		});
}

let initPromise: Promise<void> | null = null;

/** Reconcile state from OPFS once per session (App boot; safe to re-call). */
export function ensureOfflineBasemaps(): Promise<void> {
	if (!offlineBasemaps.supported) {
		offlineBasemaps.ready = true;
		return Promise.resolve();
	}
	initPromise ??= (async () => {
		try {
			const manifest = await listPacks(BASEMAP_PACK_FAMILY);
			for (const { id } of BASEMAP_PACKS) {
				const entry = manifest[id];
				const v = view(id);
				if (entry) {
					const f = await openPack(packRef(id));
					if (f) {
						files.set(id, f);
						v.status = 'ready';
						v.heldBytes = entry.bytes;
						v.downloadedAt = entry.downloadedAt || null;
						readEdition(id, f);
					}
				}
				v.partBytes = await partBytes(packRef(id));
			}
			offlineBasemaps.gen++;
		} finally {
			offlineBasemaps.ready = true;
		}
	})();
	return initPromise;
}

/** HEAD every archive for size + etag (session-cached); flags updates for
 *  held packs whose etag no longer matches. A 404 leaves the size unknown:
 *  the archive is not published yet, and the row says so if asked. */
export async function ensureBasemapPackSizes(): Promise<void> {
	if (!offlineBasemaps.supported) {
		return;
	}
	await Promise.all(
		BASEMAP_PACKS.map(async ({ id, archive }) => {
			if (remote.has(id)) {
				return;
			}
			try {
				const r = await fetch(archive, { method: 'HEAD' });
				if (!r.ok) {
					return;
				}
				const bytes = Number(r.headers.get('Content-Length')) || 0;
				remote.set(id, { bytes, etag: r.headers.get('ETag') });
				view(id).sizeBytes = bytes || null;
			} catch {
				/* offline or worker down: sizes stay unknown */
			}
		}),
	);
	await ensureOfflineBasemaps();
	const manifest = await listPacks(BASEMAP_PACK_FAMILY);
	for (const { id } of BASEMAP_PACKS) {
		const entry = manifest[id];
		const known = remote.get(id);
		if (entry && known?.etag) {
			view(id).updateAvailable = entry.etag !== null && entry.etag !== known.etag;
		}
	}
}

/** INTERNAL: the download, run by the offline queue's drain and by nothing
 *  else. */
async function runBasemapPack(
	id: BasemapPackId,
	archive: string,
	signal: AbortSignal,
	onProgress: (fraction: number) => void,
): Promise<void> {
	await ensureOfflineBasemaps();
	const v = view(id);
	// At DEQUEUE, counting this transfer's part as written, never the held
	// archive, which stays on disk until the new one is complete.
	if (!(await quotaAllows(remote.get(id)?.bytes, v.partBytes))) {
		v.error = 'quota';
		if (!files.has(id)) {
			v.status = 'error';
		}
		return;
	}
	try {
		void navigator.storage.persist?.();
	} catch {
		/* not supported */
	}

	if (!files.has(id)) {
		v.status = 'downloading';
	}
	v.error = null;
	v.progress = v.sizeBytes ? Math.min(1, v.partBytes / v.sizeBytes) : 0;
	try {
		const r = await storeDownload(packRef(id), archive, {
			signal,
			onProgress: ({ received, total }) => {
				v.partBytes = received;
				const denom = total ?? v.sizeBytes;
				v.progress = denom ? Math.min(1, received / denom) : 0;
				onProgress(v.progress);
			},
		});
		const f = await openPack(packRef(id));
		if (!f) {
			// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
			throw new Error('pack missing after download');
		}
		// Serve the new File at once: renameIntoPlace has already replaced
		// the old archive, whose File no longer reads.
		files.set(id, f);
		v.status = 'ready';
		v.heldBytes = r.bytes;
		v.partBytes = 0;
		v.downloadedAt = new Date().toISOString();
		v.updateAvailable = false;
		v.edition = null;
		offlineBasemaps.gen++;
		readEdition(id, f);
	} catch (e) {
		if ((e as DOMException).name === 'AbortError') {
			v.status = files.has(id) ? 'ready' : 'none';
			v.partBytes = await partBytes(packRef(id)).catch(() => v.partBytes);
		} else {
			v.status = files.has(id) ? 'ready' : 'error';
			v.error = e instanceof PackHttpError && e.status === 404 ? 'unpublished' : 'download';
		}
	}
}

/** Ask for a base-map pack. Enqueues and returns at once; synchronous to its
 *  last line, like its siblings. */
export function downloadBasemapPack(id: BasemapPackId): void {
	if (!offlineBasemaps.supported) {
		const v = view(id);
		v.error = 'unsupported';
		v.status = 'error';
		return;
	}
	const def = basemapPackDef(id);
	if (!def) {
		return;
	}
	const v = view(id);
	v.error = null;
	enqueueDownload(jobRef(id), {
		sizeBytes: v.sizeBytes,
		localBytes: v.partBytes,
		run: (signal, onProgress) => runBasemapPack(id, def.archive, signal, onProgress),
	});
}

/** Pause the running download (the part survives) or drop a waiting one. */
export function cancelBasemapPack(id: BasemapPackId): void {
	cancelDownload(jobRef(id));
}

export function basemapPackQueued(id: BasemapPackId): boolean {
	return isQueued(jobRef(id));
}

export function basemapPackQueuePosition(id: BasemapPackId): number {
	return queuedAt(jobRef(id));
}

export function basemapPackRunning(id: BasemapPackId): boolean {
	return isRunning(jobRef(id));
}

export async function removeBasemapPack(id: BasemapPackId): Promise<void> {
	cancelBasemapPack(id);
	// The map lets go of the File before it is deleted, swapping to the
	// network rather than reading a file that is gone.
	files.delete(id);
	offlineBasemaps.gen++;
	await storeDelete(packRef(id));
	offlineBasemaps.packs[id] = blankView();
	const known = remote.get(id);
	if (known) {
		offlineBasemaps.packs[id].sizeBytes = known.bytes || null;
	}
}

/** Throw away the transfer's part and nothing else. Never called while the
 *  transfer runs. */
export async function discardBasemapPackPart(id: BasemapPackId): Promise<void> {
	cancelBasemapPack(id);
	await storeDiscardPart(packRef(id));
	const v = view(id);
	v.partBytes = 0;
	v.progress = 0;
	if (v.status !== 'ready') {
		v.status = 'none';
		v.error = null;
	}
}
