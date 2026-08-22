/* Offline AIP document packs: the reactive face over offline/packStore.ts
 * and offline/docPack.ts (docs/offline-maps.md). One pack per document set;
 * a READY pack lets the airport and SUP AIP panels open a PDF with no
 * network, sliced out of the archive on disk.
 *
 * Sibling of state/offlineCharts.svelte.ts, deliberately: the two share the
 * download, the resume, the quota check and the manifest, and differ only in
 * what a pack IS read with. Everything here that is not in that file is
 * something documents have and tiles do not: an index of entry names, an
 * AIRAC cycle stamped inside the pack, and the promotion that happens when
 * the pre-release cycle arrives.
 *
 * Errors are CODES for the catalogs (docs/i18n.md: state stores no rendered
 * strings). */

import { currentAiracString } from '$lib/data/airac';
import { pickActiveDataset } from '$lib/data/meta';
import { docCount, readDocPack, type DocPack } from '$lib/offline/docPack';
import { DOC_PACKS, docPackDef, type DocPackId } from '$lib/offline/docPacks';
import {
	DOC_PACK_FAMILY,
	deletePack as storeDelete,
	downloadPack as storeDownload,
	listPacks,
	openPack,
	opfsSupported,
	PackHttpError,
	partBytes,
	renamePack,
} from '$lib/offline/packStore';
import { offlineCharts } from '$lib/state/offlineCharts.svelte';
import { acquireWakeLock, releaseWakeLock } from '$lib/ui/wakeLock';

/** This module's half of the shared pack store. */
const packRef = (id: DocPackId) => ({ family: DOC_PACK_FAMILY, id });

export type DocPackErrorCode = 'quota' | 'download' | 'unpublished' | 'unsupported';

export interface DocPackView {
	status: 'none' | 'downloading' | 'ready' | 'error';
	/** 0..1 while downloading. */
	progress: number;
	/** Archive size on the server (from HEAD), null until known. */
	sizeBytes: number | null;
	/** Bytes secured locally: the archive when ready, the part while paused. */
	localBytes: number;
	downloadedAt: string | null;
	updateAvailable: boolean;
	/** Documents the pack carries, 0 until it is open. */
	files: number;
	/** Documents the SIA did not publish when the pack was cut. */
	missing: number;
	/** The AIRAC cycle the pack was cut from, null for a set with no slot. */
	cycle: string | null;
	/** True when `cycle` is no longer the one in force. The pack still opens,
	 *  and the panel label carries the cycle at the tap: an out-of-date plate
	 *  the pilot can see is out of date beats no plate at all, but it must
	 *  never pass for a current one. */
	stale: boolean;
	error: DocPackErrorCode | null;
}

function blankView(): DocPackView {
	return {
		status: 'none',
		progress: 0,
		sizeBytes: null,
		localBytes: 0,
		downloadedAt: null,
		updateAvailable: false,
		files: 0,
		missing: 0,
		cycle: null,
		stale: false,
		error: null,
	};
}

export const offlineDocs = $state<{
	supported: boolean;
	ready: boolean;
	/** Bumped whenever a pack appears, is promoted or disappears; the panels
	 *  read it so an offline marker resolves as soon as a download lands. */
	gen: number;
	packs: Partial<Record<DocPackId, DocPackView>>;
	downloading: DocPackId | null;
}>({
	supported: opfsSupported(),
	ready: false,
	gen: 0,
	packs: {},
	downloading: null,
});

/** Open packs (File plus its parsed index), keyed by pack id. Panels resolve
 *  a document synchronously against these; `gen` is the change signal. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- open archives + indexes, never rendered; gen is the signal
const open = new Map<DocPackId, DocPack>();

/** Server size + etag per archive, HEADed once per session. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- session cache behind the reactive views
const remote = new Map<DocPackId, { bytes: number; etag: string | null }>();

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- abort plumbing, never rendered
const controllers = new Map<DocPackId, AbortController>();

/** The reactive view for a pack, created on first use. Assign and READ BACK:
 *  a logical-assignment expression evaluates to its right-hand side, so
 *  `return (packs[id] ??= blankView())` hands out the raw object rather than
 *  the $state proxy the store holds, and every mutation through it is lost. */
function view(id: DocPackId): DocPackView {
	offlineDocs.packs[id] ??= blankView();
	return offlineDocs.packs[id];
}

/** An open pack, when it is ready. */
export function docPackFor(id: DocPackId): DocPack | null {
	return open.get(id) ?? null;
}

/** The AIRAC cycles the held packs were cut from, so the extracted-PDF cache
 *  can drop the ones no longer represented. */
export function heldCycles(): string[] {
	const out: string[] = [];
	for (const pack of open.values()) {
		if (pack.index.cycle) {
			out.push(pack.index.cycle);
		}
	}
	return out;
}

/** True while either pack family is downloading. The two are the heavy jobs
 *  (a chart archive runs to gigabytes, a document set to hundreds of
 *  megabytes) and racing them just halves both. Lives here rather than in a
 *  third module so the import stays one-way. */
export function offlineBusy(): boolean {
	return offlineDocs.downloading !== null || offlineCharts.downloading !== null;
}

async function adopt(id: DocPackId, entry: { bytes: number; downloadedAt: string }): Promise<void> {
	const f = await openPack(packRef(id));
	if (!f) {
		return;
	}
	const pack = await readDocPack(f);
	const v = view(id);
	if (!pack) {
		// A file that is not a readable pack is not a pack. Leave it alone
		// rather than delete it: the next download replaces it anyway, and
		// silently discarding a pilot's 195 MB is not ours to do.
		v.status = 'error';
		v.error = 'download';
		return;
	}
	open.set(id, pack);
	v.status = 'ready';
	v.localBytes = entry.bytes;
	v.downloadedAt = entry.downloadedAt || null;
	v.files = docCount(pack);
	v.missing = pack.index.missing?.length ?? 0;
	v.cycle = pack.index.cycle ?? null;
	v.stale = v.cycle !== null && v.cycle !== currentAiracString();
	v.error = null;
}

/** Promote a held pre-release pack once its cycle has arrived.
 *
 * The choice is made by pickActiveDataset, the same function that picks a
 * dataset slot from two meta sidecars, fed the two packs' own `effective`
 * stamps. When it answers "next", the pre-release IS the current edition:
 * it moves onto the current id and the edition it supersedes goes with the
 * move. Nothing is retired until that replacement is in hand. */
async function promoteIfDue(now: number): Promise<boolean> {
	const current = open.get('fr-vac');
	const next = open.get('fr-vac-next');
	if (!next?.index.effective) {
		return false;
	}
	const picked = pickActiveDataset(
		current?.index.effective ?? null,
		next.index.effective,
		'current',
		'next',
		new Date(now),
	);
	if (picked.slot !== 'next') {
		return false;
	}
	if (!(await renamePack(packRef('fr-vac-next'), packRef('fr-vac')))) {
		return false;
	}
	open.delete('fr-vac-next');
	open.delete('fr-vac');
	offlineDocs.packs['fr-vac-next'] = blankView();
	offlineDocs.packs['fr-vac'] = blankView();
	return true;
}

let initPromise: Promise<void> | null = null;

/** Reconcile state from OPFS once per session (App boot; safe to re-call). */
export function ensureOfflineDocs(): Promise<void> {
	if (!offlineDocs.supported) {
		offlineDocs.ready = true;
		return Promise.resolve();
	}
	initPromise ??= (async () => {
		try {
			await reconcile();
			if (await promoteIfDue(Date.now())) {
				await reconcile();
			}
			offlineDocs.gen++;
		} finally {
			offlineDocs.ready = true;
		}
	})();
	return initPromise;
}

async function reconcile(): Promise<void> {
	const manifest = await listPacks(DOC_PACK_FAMILY);
	for (const { id } of DOC_PACKS) {
		const entry = manifest[id];
		if (entry) {
			await adopt(id, entry);
		} else {
			view(id).localBytes = await partBytes(packRef(id));
		}
	}
}

/** HEAD every archive for size + etag (session-cached); flags updates for
 *  ready packs whose etag no longer matches.
 *
 *  A 404 is expected and is not a failure: the pre-release pack exists only
 *  while the SIA publishes the next cycle's Atlas VAC, which is about a
 *  month in twenty-eight. Its size staying null is what keeps the row from
 *  offering a download of something that is not there. */
export async function ensureDocPackSizes(): Promise<void> {
	if (!offlineDocs.supported) {
		return;
	}
	await Promise.all(
		DOC_PACKS.map(async ({ id, archive }) => {
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
				view(id).sizeBytes = bytes || null;
			} catch {
				/* offline or worker down: sizes stay unknown */
			}
		}),
	);
	await ensureOfflineDocs();
	const manifest = await listPacks(DOC_PACK_FAMILY);
	for (const { id } of DOC_PACKS) {
		const entry = manifest[id];
		const known = remote.get(id);
		if (entry && known?.etag) {
			view(id).updateAvailable = entry.etag !== null && entry.etag !== known.etag;
		}
	}
}

/** True when the server publishes this pack at all (the pre-release slot
 *  usually does not). Unknown before the HEAD, which reads as "offer it":
 *  the download's own error is a better answer than hiding the row. */
export function docPackPublished(id: DocPackId): boolean {
	const def = docPackDef(id);
	if (def?.slot !== 'next') {
		return true;
	}
	return remote.has(id);
}

async function quotaAllows(id: DocPackId): Promise<boolean> {
	const need = remote.get(id)?.bytes;
	if (!need) {
		return true; // unknown size: let the download try
	}
	try {
		const est = await navigator.storage.estimate();
		if (est.quota === undefined || est.usage === undefined) {
			return true;
		}
		const already = view(id).localBytes;
		return need - already <= (est.quota - est.usage) * 0.95;
	} catch {
		return true;
	}
}

export async function downloadDocPack(id: DocPackId): Promise<void> {
	if (!offlineDocs.supported) {
		const v = view(id);
		v.error = 'unsupported';
		v.status = 'error';
		return;
	}
	if (offlineBusy()) {
		return; // one heavy download at a time; the UI disables the buttons
	}
	const def = docPackDef(id);
	if (!def) {
		return;
	}
	await ensureOfflineDocs();
	const v = view(id);
	if (!(await quotaAllows(id))) {
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

	const controller = new AbortController();
	controllers.set(id, controller);
	offlineDocs.downloading = id;
	v.status = 'downloading';
	v.error = null;
	v.progress = v.sizeBytes ? Math.min(1, v.localBytes / v.sizeBytes) : 0;
	// Hundreds of megabytes over a phone link: keep the screen up so the
	// download is not suspended halfway through pre-flight.
	acquireWakeLock('aip-docs');
	try {
		const r = await storeDownload(packRef(id), def.archive, {
			signal: controller.signal,
			onProgress: ({ received, total }) => {
				v.localBytes = received;
				const denom = total ?? v.sizeBytes;
				v.progress = denom ? Math.min(1, received / denom) : 0;
			},
		});
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a one-shot timestamp, not state
		await adopt(id, { bytes: r.bytes, downloadedAt: new Date().toISOString() });
		if (view(id).status === 'ready') {
			view(id).updateAvailable = false;
		}
		offlineDocs.gen++;
	} catch (e) {
		if ((e as DOMException).name === 'AbortError') {
			// Cancel keeps the part: back to idle, resumable.
			v.status = 'none';
			v.localBytes = await partBytes(packRef(id)).catch(() => v.localBytes);
		} else {
			v.status = 'error';
			// A 404 is the server not publishing this pack, not a broken
			// download: say so rather than send the pilot to their settings.
			v.error = e instanceof PackHttpError && e.status === 404 ? 'unpublished' : 'download';
		}
	} finally {
		releaseWakeLock('aip-docs');
		controllers.delete(id);
		offlineDocs.downloading = null;
	}
}

export function cancelDocPack(id: DocPackId): void {
	controllers.get(id)?.abort();
}

export async function removeDocPack(id: DocPackId): Promise<void> {
	cancelDocPack(id);
	await storeDelete(packRef(id));
	open.delete(id);
	offlineDocs.packs[id] = blankView();
	offlineDocs.gen++;
}
