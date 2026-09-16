/* Offline chart packs: the reactive face over offline/packStore.ts
 * (docs/offline-maps.md). One pack per chart layer that publishes an
 * archive; a READY pack makes MapView build that chart from the local
 * PMTiles instead of the network (the `gen` counter is the swap signal the
 * chart-stack effect reads). A download is a job on the one offline queue
 * (state/offlineQueue.svelte.ts), so asking for several is a tap each and
 * they run in order; cancel keeps the part file, so the next attempt
 * resumes where it stopped.
 *
 * Errors are CODES for the catalogs (docs/i18n.md: state stores no rendered
 * strings). */

import { CHART_LAYERS } from '$lib/map/chartOverlays';
import type { ChartLayerId } from '$lib/state/layers.svelte';
import {
	CHART_PACK_FAMILY,
	deletePack as storeDelete,
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

/** This module's half of the shared pack store: every call names the chart
 *  family, the AIP document packs being the other one. */
const packRef = (id: ChartLayerId) => ({ family: CHART_PACK_FAMILY, id });

export type PackErrorCode = 'quota' | 'download' | 'unpublished' | 'unsupported';

export interface PackView {
	status: 'none' | 'downloading' | 'ready' | 'error';
	/** 0..1 while downloading. */
	progress: number;
	/** Archive size on the server (from HEAD), null until known. */
	sizeBytes: number | null;
	/** Bytes secured locally: the archive when ready, the part while paused. */
	localBytes: number;
	downloadedAt: string | null;
	updateAvailable: boolean;
	error: PackErrorCode | null;
}

function blankView(): PackView {
	return {
		status: 'none',
		progress: 0,
		sizeBytes: null,
		localBytes: 0,
		downloadedAt: null,
		updateAvailable: false,
		error: null,
	};
}

export const offlineCharts = $state<{
	supported: boolean;
	ready: boolean;
	/** Bumped whenever a pack appears or disappears; MapView's chart-stack
	 *  effect reads it and swaps the live layers. */
	gen: number;
	packs: Partial<Record<ChartLayerId, PackView>>;
}>({
	supported: opfsSupported(),
	ready: false,
	gen: 0,
	packs: {},
});

/** Open Files for ready packs, keyed by chart id. Layer construction is
 *  synchronous, so the Files are pre-opened here and read via packFile(). */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- File handles for the map layer, never rendered; gen is the signal
const files = new Map<ChartLayerId, File>();

/** Server size + etag per archive, HEADed once per session. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- session cache behind the reactive views
const remote = new Map<ChartLayerId, { bytes: number; etag: string | null }>();

/** This chart's job on the offline queue. */
const jobRef = (id: ChartLayerId): JobRef => ({ kind: 'chart', id });

/** The reactive view for a chart, created on first use. Assign and READ BACK:
 *  a logical-assignment expression evaluates to its right-hand side, so
 *  `return (packs[id] ??= blankView())` hands out the raw object rather than
 *  the $state proxy the store holds, and every mutation through it is lost
 *  (Svelte's own assignment_value_stale warning). */
function view(id: ChartLayerId): PackView {
	offlineCharts.packs[id] ??= blankView();
	return offlineCharts.packs[id];
}

/** The chart defs that publish an archive (the manager's list). */
export function packableCharts(): { id: ChartLayerId; archive: string }[] {
	return CHART_LAYERS.flatMap((d) =>
		d.archive !== undefined ? [{ id: d.id, archive: d.archive }] : [],
	);
}

/** The local archive for a chart, when its pack is ready. */
export function packFile(id: ChartLayerId): File | null {
	return files.get(id) ?? null;
}

let initPromise: Promise<void> | null = null;

/** Reconcile state from OPFS once per session (App boot; safe to re-call). */
export function ensureOfflineCharts(): Promise<void> {
	if (!offlineCharts.supported) {
		offlineCharts.ready = true;
		return Promise.resolve();
	}
	initPromise ??= (async () => {
		try {
			const manifest = await listPacks(CHART_PACK_FAMILY);
			for (const { id } of packableCharts()) {
				const entry = manifest[id];
				const v = view(id);
				if (entry) {
					const f = await openPack(packRef(id));
					if (f) {
						files.set(id, f);
						v.status = 'ready';
						v.localBytes = entry.bytes;
						v.downloadedAt = entry.downloadedAt || null;
					}
				} else {
					v.localBytes = await partBytes(packRef(id));
				}
			}
			offlineCharts.gen++;
		} finally {
			offlineCharts.ready = true;
		}
	})();
	return initPromise;
}

/** HEAD every archive for size + etag (session-cached); flags updates for
 *  ready packs whose etag no longer matches. */
export async function ensurePackSizes(): Promise<void> {
	if (!offlineCharts.supported) {
		return;
	}
	await Promise.all(
		packableCharts().map(async ({ id, archive }) => {
			if (remote.has(id)) {
				return;
			}
			try {
				const r = await fetch(archive, { method: 'HEAD' });
				if (!r.ok) {
					return;
				}
				const bytes = Number(r.headers.get('Content-Length')) || 0;
				const etag = r.headers.get('ETag');
				remote.set(id, { bytes, etag });
				const v = view(id);
				v.sizeBytes = bytes || null;
			} catch {
				/* offline or worker down: sizes stay unknown */
			}
		}),
	);
	await ensureOfflineCharts();
	const manifest = await listPacks(CHART_PACK_FAMILY);
	for (const { id } of packableCharts()) {
		const entry = manifest[id];
		const known = remote.get(id);
		if (entry && known?.etag) {
			view(id).updateAvailable = entry.etag !== null && entry.etag !== known.etag;
		}
	}
}

/** INTERNAL: the download itself, run by the offline queue's drain and by
 *  nothing else. Everything that used to guard it (the one-at-a-time flag,
 *  the abort controller) now lives in the queue; what stays here is what
 *  only this module knows, namely what a chart pack IS. */
async function runChartPack(
	id: ChartLayerId,
	archive: string,
	signal: AbortSignal,
	onProgress: (fraction: number) => void,
): Promise<void> {
	await ensureOfflineCharts();
	const v = view(id);
	// At DEQUEUE, not at the tap: three jobs ahead of this one may have just
	// written 4 GB, so the headroom has to be read the moment before the
	// stream opens.
	if (!(await quotaAllows(remote.get(id)?.bytes, v.localBytes))) {
		v.status = 'error';
		v.error = 'quota';
		return;
	}
	try {
		// Best-effort durability; denied in the Android WebView, where OPFS
		// already lives inside the app's own data directory.
		void navigator.storage.persist?.();
	} catch {
		/* not supported */
	}

	v.status = 'downloading';
	v.error = null;
	v.progress = v.sizeBytes ? Math.min(1, v.localBytes / v.sizeBytes) : 0;
	try {
		const r = await storeDownload(packRef(id), archive, {
			signal,
			onProgress: ({ received, total }) => {
				v.localBytes = received;
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
		files.set(id, f);
		v.status = 'ready';
		v.localBytes = r.bytes;
		v.downloadedAt = new Date().toISOString();
		v.updateAvailable = false;
		offlineCharts.gen++;
	} catch (e) {
		if ((e as DOMException).name === 'AbortError') {
			// Cancel keeps the part: back to idle, resumable. The row reads
			// that part back as "paused" from localBytes.
			v.status = 'none';
			v.localBytes = await partBytes(packRef(id)).catch(() => v.localBytes);
		} else {
			v.status = 'error';
			// A 404 is the server not publishing this pack, not a broken
			// download: say so rather than send the pilot to their settings.
			v.error = e instanceof PackHttpError && e.status === 404 ? 'unpublished' : 'download';
		}
	}
}

/** Ask for this chart's pack. Enqueues and returns at once, so tapping five
 *  charts queues five; the queue runs them in order, one at a time.
 *  Synchronous to its last line on purpose: an await here would reopen the
 *  window in which two taps both got through. */
export function downloadPack(id: ChartLayerId): void {
	if (!offlineCharts.supported) {
		view(id).error = 'unsupported';
		view(id).status = 'error';
		return;
	}
	const def = CHART_LAYERS.find((d) => d.id === id);
	const archive = def?.archive;
	if (archive === undefined) {
		return;
	}
	const v = view(id);
	v.error = null;
	enqueueDownload(jobRef(id), {
		sizeBytes: v.sizeBytes,
		localBytes: v.localBytes,
		run: (signal, onProgress) => runChartPack(id, archive, signal, onProgress),
	});
}

/** Stop this chart's download: an abort while it runs (the part survives, so
 *  it is a pause), a plain removal while it waits. */
export function cancelPack(id: ChartLayerId): void {
	cancelDownload(jobRef(id));
}

/** Whether this chart is waiting its turn, and where. */
export function packQueued(id: ChartLayerId): boolean {
	return isQueued(jobRef(id));
}

export function packQueuePosition(id: ChartLayerId): number {
	return queuedAt(jobRef(id));
}

export function packRunning(id: ChartLayerId): boolean {
	return isRunning(jobRef(id));
}

export async function removePack(id: ChartLayerId): Promise<void> {
	// Also drops a WAITING job: without it, deleting a queued pack would
	// leave the queue about to download it again.
	cancelPack(id);
	await storeDelete(packRef(id));
	files.delete(id);
	const v = view(id);
	v.status = 'none';
	v.progress = 0;
	v.localBytes = 0;
	v.downloadedAt = null;
	v.updateAvailable = false;
	v.error = null;
	offlineCharts.gen++;
}
