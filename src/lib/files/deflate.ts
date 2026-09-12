/* Raw DEFLATE both ways, through the platform's own streams.
 *
 * One pair, three callers with nothing else in common: the ZIP writer
 * (files/zip.ts) compressing a bundle's members, the ZIP reader
 * (files/kmz.ts) inflating them again, and the flights library
 * (state/flightsDb.ts) storing an imported trace's pristine source beside its
 * points, where a trace text is about a tenth of its size compressed and the
 * library is evictable browser storage.
 *
 * "Raw" is deflate with no zlib wrapper, which is what ZIP carries. The
 * streams are present in every target browser and in Node, so this module and
 * everything over it is testable without a harness, and no dependency is
 * added for it. Pure (no Svelte, no I/O). */

/** Compress. Never throws for size: the caller decides what it is willing to
 *  hold, and the OUTPUT of a compressor is bounded by its input anyway. */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
	return drain(
		new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw')),
		Number.POSITIVE_INFINITY,
	);
}

/** Decompress, refusing to grow past `maxBytes`. A declared size is a claim a
 *  malformed or hostile archive can make freely; only the drain is the truth,
 *  so the cap is applied to the bytes as they arrive. */
export async function inflateRaw(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
	return drain(
		new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
		maxBytes,
	);
}

async function drain(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
	const reader = stream.getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.length;
		if (total > maxBytes) {
			await reader.cancel();
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			throw new Error('deflate stream too large');
		}
		parts.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}
