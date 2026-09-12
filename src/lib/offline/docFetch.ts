/* One AIP document's bytes, wherever they happen to be.
 *
 * From a downloaded pack when there is one: that is docPack.ts's File
 * slice, no network, and it is how the Android shell reads a plate at an
 * aerodrome with no signal.
 *
 * Otherwise by RANGED READS of the same pack on the worker. The pack's
 * index sits at its head with payload-relative offsets, so three small
 * requests fetch one plate out of a 195 MB archive: twelve bytes for the
 * header, the index, then the slice. The route already answers them, since
 * `/{id}/archive` parses `bytes=N-M`, replies 206 with Content-Range, and
 * exposes the headers to the page for the pack downloader's own resume.
 *
 * Failing both, through the notam-proxy relay, one document at a time. The
 * SIA serves its PDFs with no CORS header, so a browser cannot read one
 * from the source whatever it does (docs/offline-maps.md); the relay is
 * the floor under the other two, for a reader with no pack whose archive
 * read found nothing.
 *
 * The order is the point. A pack on disk costs nothing and works with no
 * signal; a ranged read costs three requests and no upstream traffic,
 * since the pack was built once for everyone; the relay costs the
 * publisher a fetch, so it goes last.
 *
 * A document read is memoised, since one plate carries several of the map's
 * panels and a pan comes back to the same aerodrome over and over.
 *
 * Pure of Svelte and of storage: the caller decides which packs to try and
 * in which order (current before pre-release, always). */

import { docBlob, DOC_PACK_MAGIC, hasDoc, type DocPack, type DocPackIndex } from './docPack';

const HEADER_SIZE = DOC_PACK_MAGIC.length + 4;
const MAX_INDEX_BYTES = 8 << 20;

/** Where one document set can be read from, in the order worth trying. */
export interface DocSource {
	/** A pack already in OPFS, if the manager has one. */
	local: DocPack | null;
	/** The pack's archive URL on the worker, for ranged reads. */
	archive: string;
	/** The proxy route that relays this one document from its publisher.
	 *  The last resort, and the only one that works for a reader with no
	 *  pack while the archive route is not serving the packs. */
	relay?: string | null;
}

/** A pack's index and the offset its entries are measured from, as read
 *  over the wire. */
export interface RemoteIndex {
	index: DocPackIndex;
	base: number;
}

/** Decode a pack header. Returns the index length, or null when the bytes
 *  are not a pack head: a redirect to an error page is a 200 with a body,
 *  and must read as "no pack" rather than as an enormous length. */
export function parsePackHeader(head: Uint8Array): number | null {
	if (head.length < HEADER_SIZE) {
		return null;
	}
	const magic = new TextDecoder().decode(head.subarray(0, DOC_PACK_MAGIC.length));
	if (magic !== DOC_PACK_MAGIC) {
		return null;
	}
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const n = view.getUint32(DOC_PACK_MAGIC.length, true);
	return n > 0 && n <= MAX_INDEX_BYTES ? n : null;
}

/** The absolute byte range of one document inside a pack, or null when the
 *  pack does not carry it. Ranges are inclusive at both ends, which is what
 *  an HTTP Range header means and what the worker's route matches. */
export function docByteRange(
	idx: RemoteIndex,
	name: string,
): { start: number; end: number } | null {
	const entry = idx.index.entries[name];
	if (
		!Array.isArray(entry) ||
		entry.length !== 2 ||
		typeof entry[0] !== 'number' ||
		typeof entry[1] !== 'number' ||
		entry[0] < 0 ||
		entry[1] <= 0
	) {
		return null;
	}
	const start = idx.base + entry[0];
	return { start, end: start + entry[1] - 1 };
}

// One index per archive, for the session. It is a few tens of kilobytes and
// it does not change between two reads of the same cycle's pack.
const remoteIndexes = new Map<string, Promise<RemoteIndex | null>>();

async function range(url: string, start: number, end: number): Promise<ArrayBuffer | null> {
	const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
	// 206 is the answer we asked for; a 200 means the server ignored the
	// Range and sent the whole multi-hundred-megabyte archive, which is not
	// something to buffer.
	if (res.status !== 206) {
		return null;
	}
	return res.arrayBuffer();
}

/** Read a pack's index over the wire, cached per archive. */
export function remotePackIndex(archive: string): Promise<RemoteIndex | null> {
	const cached = remoteIndexes.get(archive);
	if (cached) {
		return cached;
	}
	const p = (async (): Promise<RemoteIndex | null> => {
		try {
			const head = await range(archive, 0, HEADER_SIZE - 1);
			if (!head) {
				return null;
			}
			const n = parsePackHeader(new Uint8Array(head));
			if (n === null) {
				return null;
			}
			const body = await range(archive, HEADER_SIZE, HEADER_SIZE + n - 1);
			if (!body) {
				return null;
			}
			const index = JSON.parse(new TextDecoder().decode(body)) as DocPackIndex;
			if (typeof index !== 'object' || index === null || typeof index.entries !== 'object') {
				return null;
			}
			return { index, base: HEADER_SIZE + n };
		} catch {
			return null;
		}
	})();
	remoteIndexes.set(archive, p);
	return p;
}

// One document's bytes, briefly. Two panels of one aerodrome live in ONE
// plate, the approach sheet and the landing sheet being two rectangles of
// the same PDF, and the render queue asks for them a panel at a time: without
// this the same half-megabyte is fetched once per panel drawn, and again
// whenever a pan brings the aerodrome back.
//
// Bounded by BYTES rather than by count, because the documents differ by an
// order of magnitude: a VAC plate is about half a megabyte, a supplement can
// be several. The budget is small change beside the eight rendered panels the
// overlay holds, each about 11 MB of bitmap.
const DOC_CACHE_BYTES = 8 << 20;

interface DocEntry {
	used: number;
	/** Filled once the read settles; a miss weighs nothing. */
	bytes: number;
	value: Promise<ArrayBuffer | null>;
}

const documents = new Map<string, DocEntry>();
let docClock = 0;
let docBytes = 0;

/** The sources belong in the key, not just the name: the pre-release pack
 *  holds NEXT cycle's edition of the very same file name, and a pack landing
 *  on disk changes which edition a name resolves to. */
function docKey(name: string, sources: readonly DocSource[]): string {
	const sig = sources.map((s) => (s.local ? 'L' : '-') + s.archive).join('|');
	return name + '\u0000' + sig;
}

function evictDocs(): void {
	while (docBytes > DOC_CACHE_BYTES && documents.size > 1) {
		let oldestKey: string | null = null;
		let oldest = Infinity;
		for (const [k, e] of documents) {
			if (e.used < oldest) {
				oldest = e.used;
				oldestKey = k;
			}
		}
		if (oldestKey === null) {
			return;
		}
		docBytes -= documents.get(oldestKey)?.bytes ?? 0;
		documents.delete(oldestKey);
	}
}

/** One document's bytes, from the first source that carries it, read at most
 *  once while it stays in the cache.
 *
 *  Every caller gets its OWN copy. pdf.js may transfer the buffer it is
 *  handed to its worker thread, which detaches it, so a shared master would
 *  be readable exactly once and the second panel would draw nothing. Half a
 *  megabyte of memcpy against a network round trip is not a trade worth
 *  thinking about. */
export async function fetchDocBytes(
	name: string,
	sources: readonly DocSource[],
): Promise<ArrayBuffer | null> {
	const key = docKey(name, sources);
	let entry = documents.get(key);
	if (entry) {
		entry.used = ++docClock;
	} else {
		entry = { used: ++docClock, bytes: 0, value: readDocBytes(name, sources) };
		documents.set(key, entry);
		const held = entry;
		void entry.value.then(
			(buf) => {
				// A miss is remembered too: without it a plate the packs do
				// not carry is re-read on every map move.
				held.bytes = buf?.byteLength ?? 0;
				docBytes += held.bytes;
				evictDocs();
			},
			() => {
				// Never hold a rejection: the next ask should try again.
				documents.delete(key);
			},
		);
	}
	const buf = await entry.value;
	return buf ? buf.slice(0) : null;
}

/** Sources are tried in the order given, and a local pack always beats its
 *  own remote: the caller passes current-cycle before pre-release so a
 *  promoted pack cannot serve next cycle's edition of a plate this cycle
 *  still holds. */
async function readDocBytes(
	name: string,
	sources: readonly DocSource[],
): Promise<ArrayBuffer | null> {
	for (const src of sources) {
		if (src.local && hasDoc(src.local, name)) {
			const blob = docBlob(src.local, name);
			if (blob) {
				return blob.arrayBuffer();
			}
		}
	}
	for (const src of sources) {
		const idx = await remotePackIndex(src.archive);
		if (!idx) {
			continue;
		}
		const r = docByteRange(idx, name);
		if (!r) {
			continue;
		}
		const body = await range(src.archive, r.start, r.end);
		if (body) {
			return body;
		}
	}
	for (const src of sources) {
		if (!src.relay) {
			continue;
		}
		try {
			const res = await fetch(src.relay);
			if (res.ok && (res.headers.get('content-type') ?? '').includes('pdf')) {
				return await res.arrayBuffer();
			}
		} catch {
			// A relay that is not deployed, or refusing, is not an error
			// here: the caller draws nothing and the map is unchanged.
		}
	}
	return null;
}

/** Forget the cached indexes and documents. For tests, and for a pack that
 *  landed, went or was promoted: that changes what a name's bytes ARE. */
export function resetDocFetchCache(): void {
	remoteIndexes.clear();
	documents.clear();
	docBytes = 0;
}
