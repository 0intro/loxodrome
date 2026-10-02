/* The pack transfer's HTTP half (docs/offline-maps.md, "Downloads"): the
 * HEAD, the resume decision, the ranged GET and what its answer means, plus
 * the sidecar that records which edition a part belongs to and how much of
 * it is durable. Shared by the worker that writes a pack in place
 * (packTransfer.worker.ts) and the page path in packStore.ts, so it stays
 * worker-safe: no DOM, no app state, no catalogs
 * (tests/packTransferPurity.spec.ts). */

/** A failed archive request whose HTTP status is known, so a caller can tell
 *  "the server does not publish this pack" (404) from "the download broke"
 *  and say the right thing. Sending a pilot to check their connection when
 *  the set simply is not on the server yet is a wrong answer, not a vague
 *  one. The phase travels with it, so the worker can hand it to the page. */
export class PackHttpError extends Error {
	constructor(
		readonly status: number,
		readonly phase: 'HEAD' | 'GET',
	) {
		// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
		super(`archive ${phase} ${status}`);
		this.name = 'PackHttpError';
	}
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

/** A Content-Range header: `bytes <start>-<end>/<total>`, or on a 416 an
 *  asterisk in place of the range; a total of `*` is unknown. Null when it
 *  is neither. */
export function parseContentRange(
	h: string | null,
): { start: number | null; end: number | null; total: number | null } | null {
	const m = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/.exec(h?.trim() ?? '');
	if (!m) {
		return null;
	}
	return {
		start: m[1] === undefined ? null : Number(m[1]),
		end: m[2] === undefined ? null : Number(m[2]),
		total: m[3] === '*' ? null : Number(m[3]),
	};
}

/** How much the worker writes between two flushes. A flush is what makes the
 *  part durable against a power loss, and what the sidecar's stamp records,
 *  so it is also the most a kill can cost: the bytes past the last stamp are
 *  downloaded again. */
export const FLUSH_BYTES = 16 * 1024 * 1024;

/** What the sidecar says about its part. */
export interface Sidecar {
	etag: string | null;
	/** The part's length as of its last flush, or null for a legacy sidecar
	 *  (the page path's, one line holding the etag), whose part is trusted to
	 *  its size, as before. */
	flushed: number | null;
}

/** The stamp's width. Fixed, so a stamp is rewritten in place at offset 0 and
 *  a kill mid-write cannot leave a shorter record with a longer one's tail. */
export const SIDECAR_DIGITS = 16;

/** The worker's sidecar record: the flushed length, a space, the etag. */
export function formatSidecar(flushed: number, etag: string | null): string {
	return `${String(Math.max(0, Math.floor(flushed))).padStart(SIDECAR_DIGITS, '0')} ${etag ?? ''}`;
}

const STAMPED = new RegExp(`^(\\d{${SIDECAR_DIGITS}}) (.*)$`, 's');

/** Either form of the sidecar. A stamped record starts with exactly
 *  SIDECAR_DIGITS digits and a space, which no HTTP etag does (they are
 *  quoted, or W/ and quoted). */
export function parseSidecar(text: string): Sidecar {
	const m = STAMPED.exec(text);
	if (m) {
		return { flushed: Number(m[1]), etag: m[2].trim() || null };
	}
	return { flushed: null, etag: text.trim() || null };
}

/** The length of a part a resume may build on: its size, or less where the
 *  sidecar's last stamp says that only so much of it is known to be on disk.
 *  A power loss can keep a file's new size and lose its data (f2fs persists
 *  the size first), and a size is then no proof of what lies under it. */
export function trustedLength(size: number, sidecar: Sidecar): number {
	return sidecar.flushed === null ? size : Math.min(size, sidecar.flushed);
}

/** How an attempt goes on after its requests. */
export type TransferStart =
	/** The part already holds the whole archive: commit it, nothing to fetch. */
	| { kind: 'complete'; total: number; etag: string | null }
	/** Bytes to write from `offset`; an offset of 0 means the part is to be
	 *  emptied first, whether this is a first attempt or a restart. */
	| {
			kind: 'body';
			body: NonNullable<Response['body']>;
			offset: number;
			total: number | null;
			etag: string | null;
	  };

const NO_STORE = { cache: 'no-store' } as const;

/** One conditional probe, then the GET it calls for, read for what it means.
 *  `part.bytes` is the trusted length (trustedLength), `part.etag` the
 *  sidecar's.
 *  - A part as long as the archive with the matching etag is COMPLETE: no
 *    GET. Without this a kill between the last write and the commit asked
 *    for a range past the end, which the archive route answers 416, and the
 *    pack failed on every retry until Discard.
 *  - A part longer than the archive restarts; so does a 416 that does not
 *    name the part's own length as the end.
 *  - A 206 must start where the part ends and carry the part's etag, or the
 *    archive changed between the HEAD and the GET: nothing is written, and
 *    the next attempt plans again.
 *  - A 200 is the whole archive, from zero.
 *  Neither request is cached: a gigabyte of ranged answers in the HTTP disk
 *  cache is only writes. */
export async function openTransfer(
	url: string,
	part: { bytes: number; etag: string | null },
	signal: AbortSignal | null,
	fetchImpl: typeof fetch = fetch,
): Promise<TransferStart> {
	const probe = await fetchImpl(url, { method: 'HEAD', signal, ...NO_STORE });
	if (!probe.ok) {
		throw new PackHttpError(probe.status, 'HEAD');
	}
	const serverEtag = probe.headers.get('ETag');
	const length = Number(probe.headers.get('Content-Length')) || null;
	let plan = resumePlan(part.bytes, part.etag, serverEtag);
	if (!plan.restart && plan.offset > 0 && length !== null) {
		if (plan.offset === length) {
			return { kind: 'complete', total: length, etag: serverEtag };
		}
		if (plan.offset > length) {
			plan = { offset: 0, restart: true };
		}
	}

	const headers: Record<string, string> = {};
	if (plan.offset > 0) {
		headers['Range'] = `bytes=${plan.offset}-`;
	}
	const resp = await fetchImpl(url, { headers, signal, ...NO_STORE });
	if (resp.status === 416 && plan.offset > 0) {
		const cr = parseContentRange(resp.headers.get('Content-Range'));
		await resp.body?.cancel();
		if (cr?.total === plan.offset) {
			return { kind: 'complete', total: plan.offset, etag: serverEtag };
		}
		// A range past the end of an archive whose length moved: start over.
		return openTransfer(url, { bytes: 0, etag: null }, signal, fetchImpl);
	}
	if (!(resp.status === 200 || resp.status === 206) || !resp.body) {
		await resp.body?.cancel();
		throw new PackHttpError(resp.status, 'GET');
	}
	const etag = resp.headers.get('ETag') ?? serverEtag;
	if (resp.status === 206) {
		const cr = parseContentRange(resp.headers.get('Content-Range'));
		if (cr === null || cr.start !== plan.offset || etag !== serverEtag) {
			await resp.body.cancel();
			// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
			throw new Error(`archive range does not continue the part at ${plan.offset}`);
		}
		return { kind: 'body', body: resp.body, offset: plan.offset, total: cr.total, etag };
	}
	return {
		kind: 'body',
		body: resp.body,
		offset: 0,
		total: Number(resp.headers.get('Content-Length')) || null,
		etag,
	};
}
