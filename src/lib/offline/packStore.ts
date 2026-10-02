/* Offline packs: whole archives in OPFS (docs/offline-maps.md).
 *
 * Three FAMILIES share this one implementation, each in its own directory:
 * the chart packs (a layer's whole PMTiles archive), the base-map packs (a
 * base layer's, offline/basemapPacks.ts) and the AIP document packs (every
 * PDF of one document set, internal/docpack). They differ only
 * in where they sit and what they are read WITH; the download itself, with
 * its resume, its checkpoints and its manifest, is the same problem twice,
 * so it is written once.
 *
 * Layout, under the app origin's private file system:
 *   <family>/manifest.json        completed packs: {id: {etag, bytes, downloadedAt}}
 *   <family>/<id><ext>            a completed archive (the map or panel reads it)
 *   <family>/<id><ext>.part       an in-progress / paused download
 *   <family>/<id><ext>.etag       the sidecar: the etag the part belongs to, and
 *                                 how much of it is flushed (packTransfer.ts)
 *   <family>/<name>[.N].crswap    Chromium's swap file for an open writable;
 *                                 a killed one is removed here (removeSwapFiles)
 *
 * OPFS is the single source of truth: no localStorage key, so packs survive
 * "Reset application" exactly like the PWA caches (state/reset.ts doctrine),
 * and boot reconciliation is a directory read.
 *
 * A download is a TRANSFER into the part, then a COMMIT on the page (the
 * length checked, the part moved over the archive, the manifest entry). The
 * transfer runs in a worker that writes the part IN PLACE through a sync
 * access handle (packTransferCore.ts: every byte written once, a kill
 * keeping every byte written, a stamp per flush for power loss); an engine
 * without one takes the page path below, whose transactional writables
 * checkpoint every CHECKPOINT_BYTES. Either resumes with a Range request; a
 * changed server etag restarts from zero; cancel just stops (the part stays,
 * resumable); delete removes archive + part. */

import {
	openTransfer,
	parseSidecar,
	trustedLength,
	type Sidecar,
	type TransferStart,
} from './packTransfer';

export { PackHttpError, resumePlan } from './packTransfer';

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

/** Where one kind of pack lives and what its archives are called. */
export interface PackFamily {
	dir: string;
	ext: string;
}

/** A layer's whole PMTiles archive, read by map/packChartLayer.ts. */
export const CHART_PACK_FAMILY: PackFamily = { dir: 'chart-packs', ext: '.pmtiles' };

/** One document set's PDFs, read by offline/docPack.ts. */
export const DOC_PACK_FAMILY: PackFamily = { dir: 'doc-packs', ext: '.pack' };

/** The base-map packs (offline/basemapPacks.ts): PMTiles like the charts, so
 *  they need a directory of their own, or each family's boot reconcile would
 *  adopt the other's archives as orphans. */
export const BASEMAP_PACK_FAMILY: PackFamily = { dir: 'basemap-packs', ext: '.pmtiles' };

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

/** Chromium stages a writable in a swap file beside its target,
 *  `<name>.crswap`, or `<name>.1.crswap` and on while that name is taken,
 *  and renames it over the target at close() (probed 2026-10-01). A process
 *  killed with the writable open, which is what the checkpoints exist for,
 *  leaves it behind, as big as the part it was copying: on the emulator a
 *  force-stop mid-download left 372 MB that the manager lists nowhere and
 *  every later writable steps around. Nothing but this module removes one. */
const SWAP_SUFFIX = /(?:\.\d+)?\.crswap$/;

/** The part and etag files downloadPack is writing in this page, whose swap
 *  files are live. Downloads run only in the shell, one page, so this page's
 *  set is every writer there is. */
const writing = new Set<string>();

/** Remove the swap files of `targets`, a pack's own files at a moment its
 *  transfer cannot be running; or, with no list, every swap file of a part
 *  or an etag that nothing is writing, which at boot is all of them. */
async function removeSwapFiles(
	d: FileSystemDirectoryHandle,
	family: PackFamily,
	targets?: string[],
): Promise<void> {
	const names: string[] = [];
	for await (const name of d.keys()) {
		names.push(name);
	}
	for (const name of names) {
		const m = SWAP_SUFFIX.exec(name);
		if (!m) {
			continue;
		}
		const target = name.slice(0, m.index);
		const stale = targets
			? targets.includes(target)
			: (target.endsWith('.part') || target.endsWith('.etag')) &&
				!writing.has(`${family.dir}/${target}`);
		if (stale) {
			await removeIfPresent(d, name);
		}
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
	await removeSwapFiles(d, family);
	const files: { name: string; size: number }[] = [];
	for await (const handle of d.values()) {
		// Archives only, the one kind reconcileManifest reads: never a part
		// a transfer may hold.
		if (handle.kind === 'file' && handle.name.endsWith(family.ext)) {
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
	await quiet(ref);
	const d = await dir(ref.family);
	await removeIfPresent(d, archiveName(ref));
	await removeIfPresent(d, partName(ref));
	await removeIfPresent(d, partEtagName(ref));
	await removeSwapFiles(d, ref.family, [archiveName(ref), partName(ref), partEtagName(ref)]);
	const m = await readManifest(d);
	if (ref.id in m) {
		delete m[ref.id];
		await writeManifest(d, m);
	}
}

/** Drop a pack's resumable part and leave its archive alone: what Discard
 *  means for an update paused over a held pack, where deletePack would throw
 *  the pilot's current edition away with the half-downloaded new one. */
export async function discardPart(ref: PackRef): Promise<void> {
	await quiet(ref);
	const d = await dir(ref.family);
	await removeIfPresent(d, partName(ref));
	await removeIfPresent(d, partEtagName(ref));
	await removeSwapFiles(d, ref.family, [partName(ref), partEtagName(ref)]);
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

const isLockError = (e: unknown): boolean => (e as DOMException | null)?.name === 'NoModificationAllowedError';

/** Run an OPFS call that a lock just released elsewhere may still refuse:
 *  a worker's close() and terminate() release their lock asynchronously for
 *  the other contexts (probed: none in 200 close-then-move cycles, 11 to
 *  16 ms after a terminate()), so a short retry covers what no ordering
 *  guarantees. */
async function retryLocked<T>(op: () => Promise<T>, tries = 10, waitMs = 50): Promise<T> {
	for (let i = 1; ; i++) {
		try {
			return await op();
		} catch (e) {
			if (!isLockError(e) || i >= tries) {
				throw e;
			}
			await new Promise((r) => setTimeout(r, waitMs));
		}
	}
}

/** The transfer running for each pack, so what erases a pack waits for it
 *  rather than finding its files locked (removeIfPresent would swallow the
 *  refusal and leave the part behind). The callers abort before they erase. */
const inFlight = new Map<string, Promise<unknown>>();
const packKey = (ref: PackRef): string => `${ref.family.dir}/${ref.id}`;

async function quiet(ref: PackRef): Promise<void> {
	await inFlight.get(packKey(ref))?.catch(() => undefined);
}

async function renameIntoPlace(d: FileSystemDirectoryHandle, ref: PackRef): Promise<void> {
	const part = (await d.getFileHandle(partName(ref))) as MovableHandle;
	if (typeof part.move === 'function') {
		const move = part.move.bind(part);
		try {
			// move() replaces an existing archive in one step (probed in
			// Chromium and the Android WebView), so a held edition is read
			// until the new one takes its name, and never goes missing.
			await retryLocked(() => move(archiveName(ref)));
			return;
		} catch (e) {
			if (isLockError(e)) {
				throw e;
			}
			// An engine whose move() will not replace: clear the name first.
			await removeIfPresent(d, archiveName(ref));
			await move(archiveName(ref));
			return;
		}
	}
	// Engine without move(): stream-copy then drop the part.
	await removeIfPresent(d, archiveName(ref));
	const src = await part.getFile();
	const dst = await d.getFileHandle(archiveName(ref), { create: true });
	const w = await dst.createWritable();
	await src.stream().pipeTo(w);
	await removeIfPresent(d, partName(ref));
}

/** A worker resolves a relative URL against its own script, not the page. */
function absolute(url: string): string {
	return typeof location === 'undefined' ? url : new URL(url, location.href).href;
}

/** What a transfer leaves for the commit. */
interface TransferOutcome {
	received: number;
	total: number | null;
	etag: string | null;
}

interface TransferOptions {
	signal?: AbortSignal | undefined;
	onProgress?: ((p: DownloadProgress) => void) | undefined;
}

async function readSidecar(d: FileSystemDirectoryHandle, ref: PackRef): Promise<Sidecar> {
	const f = await fileOrNull(d, partEtagName(ref));
	return f ? parseSidecar(await f.text()) : { etag: null, flushed: null };
}

/** The transfer on the page, through OPFS writables, which are TRANSACTIONAL
 *  (nothing lands until close()): the stream CHECKPOINTS every
 *  CHECKPOINT_BYTES, so a kill keeps everything up to the last one. Each
 *  reopen with keepExistingData copies the whole part into a fresh swap file
 *  (Chromium; the spec says so too), so the copying grows with the square of
 *  the archive: the reason the worker exists. This path remains for an
 *  engine without sync access handles. Its sidecar is the legacy one line,
 *  the part trusted to its size. */
async function transferOnPage(
	d: FileSystemDirectoryHandle,
	ref: PackRef,
	url: string,
	opts: TransferOptions,
): Promise<TransferOutcome> {
	const sidecar = await readSidecar(d, ref);
	const size = (await fileOrNull(d, partName(ref)))?.size ?? 0;
	const trusted = trustedLength(size, sidecar);
	const t: TransferStart = await openTransfer(url, { bytes: trusted, etag: sidecar.etag }, opts.signal ?? null);
	const handle = await d.getFileHandle(partName(ref), { create: true });
	if (t.kind === 'complete') {
		if (size > t.total) {
			const w = await handle.createWritable({ keepExistingData: true });
			await w.truncate(t.total);
			await w.close();
		}
		return { received: t.total, total: t.total, etag: t.etag };
	}

	let w: FileSystemWritableFileStream;
	if (t.offset === 0) {
		// A first attempt or a restart. The part is emptied BEFORE the new
		// edition's etag is recorded: in the other order a kill left the old
		// edition's bytes under the new etag, and the next attempt resumed
		// them into a splice of two editions. An empty writable copies
		// nothing.
		const empty = await handle.createWritable();
		await empty.close();
		await writeSmallText(d, partEtagName(ref), t.etag ?? '');
		w = await handle.createWritable();
	} else {
		w = await handle.createWritable({ keepExistingData: true });
		if (size > t.offset) {
			// Bytes past the trusted length are not known to be good.
			await w.truncate(t.offset);
		}
		await w.seek(t.offset);
	}
	// A stamped sidecar (a worker's) promises only its stamp; once this path's
	// first close() has landed the truncation and its own bytes, the legacy
	// form takes over: trust the size.
	let legacy = sidecar.flushed === null || t.offset === 0;
	const commit = async (): Promise<void> => {
		await w.close();
		if (!legacy) {
			await writeSmallText(d, partEtagName(ref), t.etag ?? '');
			legacy = true;
		}
	};

	let received = t.offset;
	let sinceCheckpoint = 0;
	const reader = t.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			await w.write(value);
			received += value.byteLength;
			sinceCheckpoint += value.byteLength;
			opts.onProgress?.({ received, total: t.total });
			if (sinceCheckpoint >= CHECKPOINT_BYTES) {
				await commit();
				w = await handle.createWritable({ keepExistingData: true });
				await w.seek(received);
				sinceCheckpoint = 0;
			}
		}
		await commit();
	} catch (e) {
		// Preserve progress up to here for a later resume, then rethrow
		// (AbortError included: cancel is a pause).
		try {
			await commit();
		} catch {
			/* the writable may already be gone */
		}
		throw e;
	}
	return { received, total: t.total, etag: t.etag };
}

/** Download (or resume) a pack archive. Progress totals count the WHOLE
 *  archive, resumed bytes included. Abort via the signal keeps the part
 *  (cancel is a pause); a completed download moves the part into place and
 *  records the manifest entry. */
export async function downloadPack(
	ref: PackRef,
	url: string,
	opts: TransferOptions = {},
): Promise<DownloadResult> {
	if (opts.signal?.aborted) {
		throw new DOMException('aborted', 'AbortError');
	}
	const key = packKey(ref);
	await inFlight.get(key)?.catch(() => undefined);
	const job = runDownload(ref, url, opts);
	inFlight.set(key, job);
	try {
		return await job;
	} finally {
		if (inFlight.get(key) === job) {
			inFlight.delete(key);
		}
	}
}

async function runDownload(ref: PackRef, url: string, opts: TransferOptions): Promise<DownloadResult> {
	const d = await dir(ref.family);
	// The swap files of this pack's part and etag are this transfer's until
	// its last close(); a killed attempt's are removed first, or the new
	// writable would step around them and leave them for good.
	const live = [partName(ref), partEtagName(ref)];
	for (const name of live) {
		writing.add(`${ref.family.dir}/${name}`);
	}
	let r: TransferOutcome;
	try {
		await removeSwapFiles(d, ref.family, live);
		// The worker writes the part in place; null means it never took the
		// attempt and nothing was written, so the page does. Loaded here and
		// only here: the NOTAM Viewer reaches this module through the
		// aerodrome panel and must not ship the worker.
		const { transferInWorker } = await import('./packTransferClient');
		const job = { dir: ref.family.dir, part: partName(ref), etagFile: partEtagName(ref), url: absolute(url) };
		r = (await transferInWorker(job, opts)) ?? (await transferOnPage(d, ref, url, opts));
	} finally {
		for (const name of live) {
			writing.delete(`${ref.family.dir}/${name}`);
		}
	}

	if (r.total !== null && r.received !== r.total) {
		// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error(`archive truncated: ${r.received} of ${r.total} bytes`);
	}

	await renameIntoPlace(d, ref);
	await removeIfPresent(d, partEtagName(ref));
	const m = await readManifest(d);
	m[ref.id] = { etag: r.etag, bytes: r.received, downloadedAt: new Date().toISOString() };
	await writeManifest(d, m);
	return { bytes: r.received, etag: r.etag };
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
	await quiet(from);
	await quiet(to);
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
	await removeSwapFiles(d, from.family, [partName(from), partEtagName(from)]);
	const m = await readManifest(d);
	const entry = m[from.id];
	if (entry) {
		m[to.id] = entry;
		delete m[from.id];
		await writeManifest(d, m);
	}
	return true;
}

/** Bytes a paused download's part has secured, as a resume will build on
 *  them: its size, or its last flush where the sidecar stamps one (0 when
 *  there is no part). A failure other than an absent part is an error, not
 *  an empty part: callers keep what they last knew. */
export async function partBytes(ref: PackRef): Promise<number> {
	const d = await dir(ref.family);
	let size: number;
	try {
		size = (await (await d.getFileHandle(partName(ref))).getFile()).size;
	} catch (e) {
		if ((e as DOMException | null)?.name === 'NotFoundError') {
			return 0;
		}
		throw e;
	}
	return trustedLength(size, await readSidecar(d, ref));
}

/** Archive sizes for the manager, locale-invariant ("1.6 GB", "830 MB"). */
export function formatPackBytes(n: number): string {
	if (n >= 1e9) {
		const gb = n / 1e9;
		return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
	}
	return `${Math.max(1, Math.round(n / 1e6))} MB`;
}
