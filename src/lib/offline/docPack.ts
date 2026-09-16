/* Reading an AIP document pack: one downloaded archive holding every PDF of
 * a document set, with an index at its head (cmd/aipdocs, internal/docpack;
 * contract in docs/offline-maps.md).
 *
 *   0    : magic "LOXDOCS1"           8 bytes
 *   8    : index length, uint32 LE    4 bytes
 *   12   : index JSON                 n bytes
 *   12+n : payloads, concatenated
 *
 * Entry offsets are relative to the START OF THE PAYLOAD AREA, not to the
 * file: absolute offsets would depend on the length of the index carrying
 * them, which depends on how many digits those offsets take. The reader has
 * parsed the header by then, so it knows the base.
 *
 * The whole file stays on disk. A document is one File.slice(), the same
 * "OPFS File as a random-access source" idiom offline/filePmtiles.ts uses
 * for the chart archives, so opening one plate never reads the other 655.
 *
 * Pure: no Svelte, no catalogs, no storage. state/offlineDocs.svelte.ts owns
 * the lifecycle. */

/** Opens every pack. What tells a truncated or misrouted download from a
 *  real one before any offset is trusted. */
export const DOC_PACK_MAGIC = 'LOXDOCS1';

const HEADER_SIZE = DOC_PACK_MAGIC.length + 4;

/** Bound on the index a reader will accept, so a corrupt length field cannot
 *  make it allocate wildly. The Atlas VAC's 656 entries are about 30 KB. */
const MAX_INDEX_BYTES = 8 << 20;

/** One document's place in the payload area: [offset, length]. */
export type DocEntry = readonly [offset: number, length: number];

export interface DocPackIndex {
	/** Which document set this is ("fr-vac", "fr-sup"). */
	set: string;
	/** SIA eAIP date segment ("06_AUG_2026") for a cycle-stamped set. */
	cycle?: string;
	/** The cycle's AIRAC date ("2026-08-06"), which the slot picker reads. */
	effective?: string;
	/** Language a single-language set was cut in. */
	lang?: string;
	/** Documents the source did not publish. Recorded rather than hidden: a
	 *  plate absent from the pack is one the panel must not claim to hold. */
	missing?: string[];
	entries: Record<string, DocEntry>;
}

export interface DocPack {
	index: DocPackIndex;
	/** Offset the entries are measured from. */
	base: number;
	file: File;
}

function isEntry(v: unknown): v is DocEntry {
	return (
		Array.isArray(v) &&
		v.length === 2 &&
		typeof v[0] === 'number' &&
		typeof v[1] === 'number' &&
		v[0] >= 0 &&
		v[1] >= 0
	);
}

/** Parse a downloaded pack's head. Returns null for anything that is not a
 *  readable pack, since a half-written or wrong file must read as "no pack"
 *  rather than throw into a boot path. */
export async function readDocPack(file: File): Promise<DocPack | null> {
	try {
		if (file.size < HEADER_SIZE) {
			return null;
		}
		const header = new Uint8Array(await file.slice(0, HEADER_SIZE).arrayBuffer());
		const magic = new TextDecoder().decode(header.subarray(0, DOC_PACK_MAGIC.length));
		if (magic !== DOC_PACK_MAGIC) {
			return null;
		}
		const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
		const n = view.getUint32(DOC_PACK_MAGIC.length, true);
		if (n === 0 || n > MAX_INDEX_BYTES || HEADER_SIZE + n > file.size) {
			return null;
		}
		const body = await file.slice(HEADER_SIZE, HEADER_SIZE + n).text();
		const index = JSON.parse(body) as DocPackIndex;
		if (typeof index !== 'object' || index === null || typeof index.entries !== 'object') {
			return null;
		}
		return { index, base: HEADER_SIZE + n, file };
	} catch {
		return null;
	}
}

/** True when the pack carries this document. */
export function hasDoc(pack: DocPack, name: string): boolean {
	return isEntry(pack.index.entries[name]);
}

/** One document's bytes, or null when the pack does not carry it or its
 *  entry points outside the file (a corrupt index must not slice garbage
 *  into something the pilot reads as a chart). */
export function docBlob(pack: DocPack, name: string): Blob | null {
	const entry = pack.index.entries[name];
	if (!isEntry(entry)) {
		return null;
	}
	const [offset, length] = entry;
	const start = pack.base + offset;
	if (start + length > pack.file.size) {
		return null;
	}
	return pack.file.slice(start, start + length, 'application/pdf');
}

/** How many documents the pack holds. */
export function docCount(pack: DocPack): number {
	return Object.keys(pack.index.entries).length;
}
