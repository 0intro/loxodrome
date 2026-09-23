/* Offline packs: whole archives in OPFS (docs/offline-maps.md).
 *
 * Two FAMILIES share this one implementation, each in its own directory:
 * the chart packs (a layer's whole PMTiles archive) and the AIP document
 * packs (every PDF of one document set, internal/docpack). They differ only
 * in where they sit and what they are read WITH; the download itself, with
 * its resume, its checkpoints and its manifest, is the same problem twice,
 * so it is written once.
 *
 * Layout, under the app origin's private file system:
 *   <family>/manifest.json        completed packs: {id: {etag, bytes, downloadedAt}}
 *   <family>/<id><ext>            a completed archive (the map or panel reads it)
 *   <family>/<id><ext>.part       an in-progress / paused download
 *   <family>/<id><ext>.etag       the etag the part belongs to (resume guard)
 *
 * OPFS is the single source of truth: no localStorage key, so packs survive
 * "Reset application" exactly like the PWA caches (state/reset.ts doctrine),
 * and boot reconciliation is a directory read. OPFS writables are
 * TRANSACTIONAL (nothing lands until close()), so the download CHECKPOINTS
 * every CHECKPOINT_BYTES: an interruption keeps everything up to the last
 * checkpoint and the next attempt resumes from there with a Range request.
 * A changed server etag restarts from zero; cancel just stops (the part
 * stays, resumable); delete removes archive + part. */

export interface PackEntry {
	etag: string | null;
	bytes: number;
	downloadedAt: string;
}

export type PackManifest = Record<string, PackEntry>;

export interface DownloadProgress {
	received: number;
	total: number | null;
}

export interface DownloadResult {
	bytes: number;
	etag: string | null;
}

/** A failed archive request whose HTTP status is known, so a caller can tell
 *  "the server does not publish this pack" (404) from "the download broke"
 *  and say the right thing. Sending a pilot to check their connection when
 *  the set simply is not on the server yet is a wrong answer, not a vague
 *  one. */
export class PackHttpError extends Error {
	constructor(readonly status: number, phase: 'HEAD' | 'GET') {
		// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
		super(`archive ${phase} ${status}`);
		this.name = 'PackHttpError';
	}
}

/** Where one kind of pack lives and what its archives are called. */
export interface PackFamily {
	dir: string;
	ext: string;
}

/** A layer's whole PMTiles archive, read by map/packChartLayer.ts. */
export const CHART_PACK_FAMILY: PackFamily = { dir: 'chart-packs', ext: '.pmtiles' };

/** One document set's PDFs, read by offline/docPack.ts. */
export const DOC_PACK_FAMILY: PackFamily = { dir: 'doc-packs', ext: '.pack' };

/** One pack: which family, and which member of it. */
export interface PackRef {
	family: PackFamily;
	id: string;
}

const MANIFEST = 'manifest.json';
const CHECKPOINT_BYTES = 64 * 1024 * 1024;

/** FileSystemFileHandle.move is not in lib.dom yet; Chromium (and the
 *  Android WebView, probed) implement it. The copy fallback covers engines
 *  without it. */
interface MovableHandle extends FileSystemFileHandle {
	move?(name: string): Promise<void>;
}

export function opfsSupported(): boolean {
	return (
		typeof navigator !== 'undefined' &&
		typeof navigator.storage?.getDirectory === 'function'
	);
}

async function dir(family: PackFamily): Promise<FileSystemDirectoryHandle> {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(family.dir, { create: true });
}

const archiveName = (ref: PackRef): string => ref.id + ref.family.ext;
const partName = (ref: PackRef): string => `${archiveName(ref)}.part`;
const partEtagName = (ref: PackRef): string => `${archiveName(ref)}.etag`;

async function fileOrNull(
	d: FileSystemDirectoryHandle,
	name: string,
): Promise<File | null> {
	try {
		const h = await d.getFileHandle(name);
		return await h.getFile();
	} catch {
		return null;
	}
}

async function removeIfPresent(d: FileSystemDirectoryHandle, name: string): Promise<void> {
	try {
		await d.removeEntry(name);
	} catch {
		/* absent */
	}
}

async function readManifest(d: FileSystemDirectoryHandle): Promise<PackManifest> {
	const f = await fileOrNull(d, MANIFEST);
	if (!f) {
		return {};
	}
	try {
		return JSON.parse(await f.text()) as PackManifest;
	} catch {
		return {};
	}
}

async function writeManifest(d: FileSystemDirectoryHandle, m: PackManifest): Promise<void> {
	const h = await d.getFileHandle(MANIFEST, { create: true });
	const w = await h.createWritable();
	await w.write(JSON.stringify(m));
	await w.close();
}

/** The manifest reconciled against the files actually present: entries
 *  without their archive are dropped, archives without an entry are adopted
 *  (etag unknown, so the update check will flag them). Pure logic split out
 *  for tests. */
export function reconcileManifest(
	manifest: PackManifest,
	files: { name: string; size: number }[],
	family: PackFamily,
): PackManifest {
	const byName = new Map(files.map((f) => [f.name, f]));
	const out: PackManifest = {};
	for (const [id, entry] of Object.entries(manifest)) {
		if (byName.has(id + family.ext)) {
			out[id] = entry;
		}
	}
	for (const f of files) {
		if (!f.name.endsWith(family.ext)) {
			continue;
		}
		const id = f.name.slice(0, -family.ext.length);
		out[id] ??= { etag: null, bytes: f.size, downloadedAt: '' };
	}
	return out;
}

export async function listPacks(family: PackFamily): Promise<PackManifest> {
	const d = await dir(family);
	const files: { name: string; size: number }[] = [];
	for await (const handle of d.values()) {
		if (handle.kind === 'file') {
			const f = await handle.getFile();
			files.push({ name: handle.name, size: f.size });
		}
	}
	const before = await readManifest(d);
	const after = reconcileManifest(before, files, family);
	if (JSON.stringify(after) !== JSON.stringify(before)) {
		await writeManifest(d, after);
	}
	return after;
}

/** The completed archive as a File (random-access via slice), null when the
 *  pack is absent. */
export async function openPack(ref: PackRef): Promise<File | null> {
	return fileOrNull(await dir(ref.family), archiveName(ref));
}

export async function deletePack(ref: PackRef): Promise<void> {
	const d = await dir(ref.family);
	await removeIfPresent(d, archiveName(ref));
	await removeIfPresent(d, partName(ref));
	await removeIfPresent(d, partEtagName(ref));
	const m = await readManifest(d);
	if (ref.id in m) {
		delete m[ref.id];
		await writeManifest(d, m);
	}
}

async function writeSmallText(
	d: FileSystemDirectoryHandle,
	name: string,
	text: string,
): Promise<void> {
	const h = await d.getFileHandle(name, { create: true });
	const w = await h.createWritable();
	await w.write(text);
	await w.close();
}

/** Decide how a download attempt starts, given the local part and the
 *  server's etag for the archive. Pure, pinned by tests. */
export function resumePlan(
	partBytes: number,
	partEtag: string | null,
	serverEtag: string | null,
): { offset: number; restart: boolean } {
	if (partBytes <= 0) {
		return { offset: 0, restart: false };
	}
	// An unknown etag on either side cannot prove the part still matches the
	// archive; restart rather than risk a corrupt splice.
	if (partEtag === null || serverEtag === null || partEtag !== serverEtag) {
		return { offset: 0, restart: true };
	}
	return { offset: partBytes, restart: false };
}

async function renameIntoPlace(d: FileSystemDirectoryHandle, ref: PackRef): Promise<void> {
	const part = (await d.getFileHandle(partName(ref))) as MovableHandle;
	await removeIfPresent(d, archiveName(ref));
	if (typeof part.move === 'function') {
		await part.move(archiveName(ref));
		return;
	}
	// Engine without move(): stream-copy then drop the part.
	const src = await part.getFile();
	const dst = await d.getFileHandle(archiveName(ref), { create: true });
	const w = await dst.createWritable();
	await src.stream().pipeTo(w);
	await removeIfPresent(d, partName(ref));
}

/** Download (or resume) a pack archive. Progress totals count the WHOLE
 *  archive, resumed bytes included. Abort via the signal keeps the part
 *  (cancel is a pause); a completed download moves the part into place and
 *  records the manifest entry. */
export async function downloadPack(
	ref: PackRef,
	url: string,
	opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void } = {},
): Promise<DownloadResult> {
	const d = await dir(ref.family);

	const existingPart = await fileOrNull(d, partName(ref));
	const partEtagFile = await fileOrNull(d, partEtagName(ref));
	const partEtag = partEtagFile ? (await partEtagFile.text()).trim() || null : null;

	// One conditional probe decides resume vs restart before any body flows.
	const probe = await fetch(url, { method: 'HEAD', signal: opts.signal ?? null });
	if (!probe.ok) {
		throw new PackHttpError(probe.status, 'HEAD');
	}
	const serverEtag = probe.headers.get('ETag');
	const plan = resumePlan(existingPart?.size ?? 0, partEtag, serverEtag);

	const headers: Record<string, string> = {};
	if (plan.offset > 0) {
		headers['Range'] = `bytes=${plan.offset}-`;
	}
	const resp = await fetch(url, { headers, signal: opts.signal ?? null });
	if (!(resp.status === 200 || resp.status === 206) || !resp.body) {
		throw new PackHttpError(resp.status, 'GET');
	}
	// A 200 despite our Range means the server restarted us from zero.
	const offset = resp.status === 206 ? plan.offset : 0;
	const contentRange = resp.headers.get('Content-Range');
	const total =
		resp.status === 206
			? contentRange
				? Number(contentRange.split('/')[1]) || null
				: null
			: Number(resp.headers.get('Content-Length')) || null;
	const etag = resp.headers.get('ETag') ?? serverEtag;

	const handle = await d.getFileHandle(partName(ref), { create: true });
	if (offset === 0) {
		await writeSmallText(d, partEtagName(ref), etag ?? '');
	}

	let received = offset;
	let sinceCheckpoint = 0;
	let w = await handle.createWritable({ keepExistingData: offset > 0 });
	await w.seek(offset);
	const reader = resp.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			await w.write(value);
			received += value.byteLength;
			sinceCheckpoint += value.byteLength;
			opts.onProgress?.({ received, total });
			// OPFS writables are transactional: nothing survives an
			// interruption until close(). Checkpoint so a kill mid-download
			// loses at most this slice.
			if (sinceCheckpoint >= CHECKPOINT_BYTES) {
				await w.close();
				w = await handle.createWritable({ keepExistingData: true });
				await w.seek(received);
				sinceCheckpoint = 0;
			}
		}
		await w.close();
	} catch (e) {
		// Preserve progress up to here for a later resume, then rethrow
		// (AbortError included: cancel is a pause).
		try {
			await w.close();
		} catch {
			/* the writable may already be gone */
		}
		throw e;
	}

	if (total !== null && received !== total) {
		// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error(`archive truncated: ${received} of ${total} bytes`);
	}

	await renameIntoPlace(d, ref);
	await removeIfPresent(d, partEtagName(ref));
	const m = await readManifest(d);
	m[ref.id] = { etag, bytes: received, downloadedAt: new Date().toISOString() };
	await writeManifest(d, m);
	return { bytes: received, etag };
}

/** Move a completed pack onto another id in the same family, replacing
 *  whatever was there and carrying its manifest entry across. Returns false
 *  when there was nothing to move.
 *
 *  This is the AIRAC promotion: when a pre-release pack's cycle arrives it
 *  BECOMES the current pack, and the edition it supersedes is retired in the
 *  same step, so the two never both claim to be current. Retiring only here,
 *  with the replacement already in hand, is deliberate: a pilot who never
 *  downloaded the pre-release keeps the plates they have. */
export async function renamePack(from: PackRef, to: PackRef): Promise<boolean> {
	if (from.family !== to.family) {
		// i18n-ignore: programmer diagnostic, never rendered (docs/i18n.md rule 7)
		throw new Error('renamePack across families');
	}
	const d = await dir(from.family);
	let handle: MovableHandle;
	try {
		handle = await d.getFileHandle(archiveName(from));
	} catch {
		return false;
	}
	await removeIfPresent(d, archiveName(to));
	if (typeof handle.move === 'function') {
		await handle.move(archiveName(to));
	} else {
		const src = await handle.getFile();
		const dst = await d.getFileHandle(archiveName(to), { create: true });
		const w = await dst.createWritable();
		await src.stream().pipeTo(w);
		await removeIfPresent(d, archiveName(from));
	}
	await removeIfPresent(d, partName(from));
	await removeIfPresent(d, partEtagName(from));
	const m = await readManifest(d);
	const entry = m[from.id];
	if (entry) {
		m[to.id] = entry;
		delete m[from.id];
		await writeManifest(d, m);
	}
	return true;
}

/** Bytes already secured in a paused download's part file (0 when none). */
export async function partBytes(ref: PackRef): Promise<number> {
	const f = await fileOrNull(await dir(ref.family), partName(ref));
	return f?.size ?? 0;
}

/** Archive sizes for the manager, locale-invariant ("1.6 GB", "830 MB"). */
export function formatPackBytes(n: number): string {
	if (n >= 1e9) {
		const gb = n / 1e9;
		return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
	}
	return `${Math.max(1, Math.round(n / 1e6))} MB`;
}
