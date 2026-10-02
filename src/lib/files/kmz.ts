/* Reading a ZIP container. Two shapes arrive, and one walk of the central
 * directory serves both:
 *
 *  - a KMZ, the trace import's own container (docs/trace-files.md): Google
 *    Earth saves .kmz by default, a zipped KML, so a file the user actually
 *    has on disk arrives compressed. `kmzToKml` takes the one document out
 *    and everything downstream still sees TEXT, which is what keeps
 *    files/detect.ts pure and text-only;
 *  - a flights BUNDLE (docs/flights-library.md): the whole library as one
 *    archive of the files the app already writes. `zipEntries` hands every
 *    member back and the batch importer sniffs each one, so a bundle needs
 *    no manifest and no format of its own.
 *
 * Nothing here decides which is which: the caller sniffs the members it gets
 * back, and an archive holding exactly one file the app recognises IS a KMZ
 * by that measure. That test is what keeps a bundle of .kml traces from
 * reading as a KMZ.
 *
 * The sibling writer (files/zip.ts) deflates only when it shrinks a member;
 * a reader cannot be so relaxed, since Google Earth always deflates.
 * Inflation goes through the platform's own DecompressionStream('deflate-raw')
 * - present in every target browser and in Node, so this module is testable
 * without a harness - and no dependency is added for it.
 *
 * The central directory is the authority, never the local headers: a writer
 * that streams entries (general-purpose bit 3) leaves the local header's
 * sizes at zero and states them only in the central directory and a trailing
 * descriptor. Tested by tests/kmz.spec.ts. */

import { inflateRaw } from './deflate';

/** What one member may decompress to. A malformed or hostile archive must
 *  not inflate unbounded (the rule cmd/at applies to the Austrian KMZ, whose
 *  own KML really is ~25 MB, so the cap sits well above a real file). */
const MAX_MEMBER_BYTES = 64 * 1024 * 1024;

/** What a WHOLE archive may inflate to, and how many members it may hold.
 *  The per-member cap was the total bound only while `kmzToKml` stopped at
 *  the first .kml; `zipEntries` walks every member, and the EOCD count is a
 *  uint16, so 65535 members of 64 MiB each were reachable from one tap on a
 *  shared file. Measured before this: a 0.62 MB archive drove 640 MB of
 *  inflate. A real flights bundle is a few hundred members and well under
 *  the budget. */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 4096;

/** How far back the end-of-central-directory record may sit: its own 22
 *  bytes plus a maximal ZIP comment. */
const EOCD_SEARCH = 22 + 0xffff;

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** The ZIP local-file-header magic, "PK\x03\x04": what a KMZ starts with. */
export function isZipBytes(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 4 &&
		bytes[0] === 0x50 &&
		bytes[1] === 0x4b &&
		bytes[2] === 0x03 &&
		bytes[3] === 0x04
	);
}

/** One incoming file as text, unwrapping a ZIP container (a KMZ) on the way.
 *  THE entry point for every import path: the pickers, the Android intent
 *  bridge and the ?file= parameter all read bytes and call this, so no
 *  caller has to know containers exist. */
export async function textOfBytes(bytes: Uint8Array): Promise<string> {
	if (isZipBytes(bytes)) {
		return kmzToKml(bytes);
	}
	return new TextDecoder().decode(bytes);
}

/** One member as the central directory describes it, before it is read. */
interface DirEntry {
	name: string;
	method: number;
	compressed: number;
	uncompressed: number;
	localOff: number;
	/** The DOS stamp, as epoch ms UTC. */
	mtimeMs: number;
}

/** A DOS date+time word pair as epoch ms, read as UTC: the format carries no
 *  zone, and files/zip.ts writes it from UTC for exactly that reason. Two
 *  second resolution is the format's, not ours. */
function dosEpochMs(time: number, date: number): number {
	return Date.UTC(
		1980 + ((date >> 9) & 0x7f),
		((date >> 5) & 0x0f) - 1,
		date & 0x1f,
		(time >> 11) & 0x1f,
		(time >> 5) & 0x3f,
		(time & 0x1f) * 2,
	);
}

/** Walk the central directory. Stops at the first entry that does not carry
 *  the signature, rather than throwing: a truncated tail should still yield
 *  the members before it. Throws only when there is no directory at all. */
function centralDirectory(bytes: Uint8Array, view: DataView, what: string): DirEntry[] {
	const eocd = findEocd(view, bytes.length);
	if (eocd < 0) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error(`Invalid ${what}: no ZIP directory found`);
	}
	const count = view.getUint16(eocd + 10, true);
	const out: DirEntry[] = [];
	let off = view.getUint32(eocd + 16, true);
	for (let i = 0; i < count; i++) {
		if (off + 46 > bytes.length || view.getUint32(off, true) !== SIG_CENTRAL) {
			break;
		}
		const nameLen = view.getUint16(off + 28, true);
		const extraLen = view.getUint16(off + 30, true);
		const commentLen = view.getUint16(off + 32, true);
		out.push({
			name: new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen)),
			method: view.getUint16(off + 10, true),
			compressed: view.getUint32(off + 20, true),
			uncompressed: view.getUint32(off + 24, true),
			localOff: view.getUint32(off + 42, true),
			mtimeMs: dosEpochMs(view.getUint16(off + 12, true), view.getUint16(off + 14, true)),
		});
		off += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

/** The KML document inside a KMZ: the FIRST member whose name ends .kml,
 *  taken by position (Google Earth writes doc.kml, other tools their own
 *  name, and an archive commonly opens with an images/ folder). Throws with
 *  a readable reason rather than yielding an empty document. */
export async function kmzToKml(bytes: Uint8Array): Promise<string> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (const e of centralDirectory(bytes, view, 'KMZ')) {
		if (e.name.toLowerCase().endsWith('.kml')) {
			return new TextDecoder().decode(await memberBytes(bytes, view, e));
		}
	}
	// i18n-ignore: wire diagnostic, stays EN
	throw new Error('Invalid KMZ: no .kml document inside');
}

/** One member of an archive, as the importer takes them. */
export interface ZipMember {
	/** The archive path, exactly as stored (folders included). */
	name: string;
	text: string;
	/** The member's stored timestamp. The flights bundle writes each plan's
	 *  savedAtMs here, so a library that moves between devices keeps the date
	 *  it was stored on rather than the date it was moved. */
	mtimeMs: number;
	/** The member's bytes, exactly as stored. `text` is a DECODING of these
	 *  and is lossy: a BOM disappears through it and any byte that is not
	 *  valid UTF-8 becomes U+FFFD (measured on an ISO-8859-1 IGC header, which
	 *  loggers really do write). Anything that must hand the file back
	 *  unchanged keeps these; only the sniffer and the parsers read `text`. */
	bytes: Uint8Array;
}

/** Every TEXT member of an archive, in directory order.
 *
 *  Skipped without complaint: directory entries, and members whose bytes are
 *  not text. A KMZ's overlay imagery is the everyday case of the latter, and
 *  the NUL probe runs on the member's BYTES, never on a decoded string: for a
 *  stored member that costs nothing at all, and for a deflated one - which is
 *  what Google Earth and every general-purpose writer emit, so it is the case
 *  that matters - it saves turning a 10 MB JPEG into a JS string only for the
 *  sniffer to reject it. A member too large to inflate, or one whose
 *  compression method we do not implement, is skipped too: one bad member
 *  must not cost the caller the archive. */
export async function zipEntries(bytes: Uint8Array): Promise<ZipMember[]> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out: ZipMember[] = [];
	let budget = MAX_ARCHIVE_BYTES;
	let seen = 0;
	for (const e of centralDirectory(bytes, view, 'archive')) {
		if (e.name.endsWith('/') || e.uncompressed === 0) {
			continue;
		}
		if (++seen > MAX_ARCHIVE_MEMBERS || budget <= 0) {
			break;
		}
		let raw: Uint8Array;
		try {
			// Capped by what is LEFT as well as by the per-member ceiling, and
			// the cap is enforced on the drain, never on the declared size,
			// which is only a claim. A member that will not fit is skipped
			// like any other unreadable one: a single bad member must not cost
			// the caller the whole archive.
			raw = await memberBytes(bytes, view, e, Math.min(MAX_MEMBER_BYTES, budget));
		} catch {
			continue;
		}
		budget -= raw.length;
		if (looksBinary(raw)) {
			continue;
		}
		out.push({
			name: e.name,
			text: new TextDecoder().decode(raw),
			bytes: raw,
			mtimeMs: e.mtimeMs,
		});
	}
	return out;
}

/** Does this member open with a NUL? The head is enough: text files do not
 *  carry one, and every binary container this could meet states its magic in
 *  the first bytes. */
function looksBinary(raw: Uint8Array): boolean {
	return raw.subarray(0, 512).includes(0);
}

/** Scan backwards for the end-of-central-directory signature: a ZIP comment
 *  pushes it off the last 22 bytes. */
function findEocd(view: DataView, length: number): number {
	const from = Math.max(0, length - EOCD_SEARCH);
	for (let i = length - 22; i >= from; i--) {
		if (view.getUint32(i, true) === SIG_EOCD) {
			return i;
		}
	}
	return -1;
}

/** Where one member's data begins, or -1 when its local header is broken.
 *  The local header is re-read at its recorded offset for its OWN name and
 *  extra lengths: they differ from the central directory's, and adding the
 *  wrong one lands in the middle of the data. */
function memberStart(bytes: Uint8Array, view: DataView, localOff: number): number {
	if (localOff + 30 > bytes.length || view.getUint32(localOff, true) !== SIG_LOCAL) {
		return -1;
	}
	return localOff + 30 + view.getUint16(localOff + 26, true) + view.getUint16(localOff + 28, true);
}

/** One member's raw bytes, inflating when it is deflated. */
async function memberBytes(
	bytes: Uint8Array,
	view: DataView,
	e: DirEntry,
	cap = MAX_MEMBER_BYTES,
): Promise<Uint8Array> {
	if (e.uncompressed > cap) {
		// i18n-ignore: wire diagnostic, stays EN
		throw new Error('Invalid KMZ: the KML inside is too large');
	}
	const start = memberStart(bytes, view, e.localOff);
	if (start < 0) {
		// i18n-ignore: wire diagnostic, stays EN
		throw new Error('Invalid KMZ: broken entry header');
	}
	const data = bytes.subarray(start, start + e.compressed);
	if (e.method === 0) {
		if (data.length > cap) {
			// i18n-ignore: wire diagnostic, stays EN
			throw new Error('Invalid KMZ: the KML inside is too large');
		}
		return data;
	}
	if (e.method !== 8) {
		// i18n-ignore: wire diagnostic, stays EN
		throw new Error(`Invalid KMZ: unsupported compression method ${e.method}`);
	}
	try {
		return await inflateRaw(data, cap);
	} catch {
		// i18n-ignore: wire diagnostic, stays EN
		throw new Error('Invalid KMZ: the KML inside is too large');
	}
}

/** Base64 back to bytes: how the Android bridge carries a binary file, since
 *  its channel is JSON text (docs/android.md). */
export function base64Bytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}
