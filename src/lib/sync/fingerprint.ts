/* SHA-256 and identity helpers for the sync layer (docs/accounts-sync.md).
 * SHA-256 on purpose, never state/hash.ts's djb2: that one's own header
 * calls it a change detector whose 32 bits need a second factor, and sync
 * must not miss a change; blobs are additionally ADDRESSED by these
 * digests server-side, so the hash is load-bearing both locally and on
 * the wire. Pure: no storage, no state. */

const utf8 = new TextEncoder();

/** UTF-8 bytes of a string: the hashing and wire form of every text
 *  payload. */
export function utf8Bytes(text: string): Uint8Array {
	return utf8.encode(text);
}

/** Lower-case hex SHA-256 of bytes. Throws where WebCrypto is missing
 *  (an insecure context); sync is unusable there anyway and every
 *  shipped origin is secure. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
	const bytes = new Uint8Array(digest);
	let out = '';
	for (const b of bytes) {
		out += b.toString(16).padStart(2, '0');
	}
	return out;
}

/** sha256Hex over a string's UTF-8 bytes. */
export async function sha256HexOfText(text: string): Promise<string> {
	return sha256Hex(utf8Bytes(text));
}

/** The outing points DIRTY fingerprint: {count}:{last timeMs}. A cheap
 *  test instead of a hash, because the arrays are immutable except
 *  Continue-extends, which only GROW; hashing megabytes of points on
 *  every sync trigger would be waste (docs/accounts-sync.md, "Dirty
 *  detection"). */
export function outingPointsFingerprint(points: readonly { timeMs: number }[]): string {
	const last = points.length > 0 ? points[points.length - 1].timeMs : 0;
	return `${points.length}:${last}`;
}

/** A v4 UUID (the device id). crypto.randomUUID needs a secure context,
 *  which every shipped origin is; the fallback covers a stray plain-http
 *  LAN dev origin rather than any supported platform. */
export function newUuid(): string {
	if (typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	const b = crypto.getRandomValues(new Uint8Array(16));
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
	return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
		.slice(6, 8)
		.join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}
