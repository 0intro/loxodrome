/* A pack archive served the way the chart worker serves one (the oaci repo's
 * deploy/src/worker.js, /{layer}/archive): HEAD answers the size and the
 * etag, a GET with `Range: bytes=N-` answers 206 with its Content-Range, one
 * starting at or past the end answers 416 with `bytes *` + `/size`. Switches
 * stand in for what can go wrong, and the fetch honours its signal, the body
 * included. Every request is recorded. */

export interface ArchiveServerOptions {
	/** The ETag header; null sends none. */
	etag?: string | null;
	/** An ETag the GET answers instead (republished between HEAD and GET). */
	getEtag?: string;
	/** Send Content-Length on the HEAD (default true). */
	headLength?: boolean;
	headStatus?: number;
	getStatus?: number;
	/** Answer 200 and the whole archive to a Range. */
	ignoreRange?: boolean;
	/** A 206 whose Content-Range starts one byte late. */
	wrongStart?: boolean;
	/** The body ends this many bytes early. */
	shortBy?: number;
	/** The body errors after this many bytes. */
	failAfter?: number;
	/** The body holds after this many bytes until the promise resolves. */
	holdAfter?: number;
	hold?: Promise<void>;
	/** Bytes per chunk (default 64). */
	chunk?: number;
}

export interface ArchiveRequest {
	method: string;
	range: string | null;
	cache: RequestCache | undefined;
}

export function archiveServer(archive: Uint8Array, initial: ArchiveServerOptions = {}) {
	let opts: ArchiveServerOptions = { etag: '"edition-1"', ...initial };
	const requests: ArchiveRequest[] = [];
	const aborted = (): DOMException => new DOMException('aborted', 'AbortError');

	const fetchImpl = (async (_url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
		const method = init.method ?? 'GET';
		const range = new Headers(init.headers).get('Range');
		requests.push({ method, range, cache: init.cache });
		const signal = init.signal ?? null;
		if (signal?.aborted) {
			throw aborted();
		}
		await Promise.resolve();
		const etagHeaders = (etag: string | null | undefined): Record<string, string> =>
			etag === null || etag === undefined ? {} : { ETag: etag };
		if (method === 'HEAD') {
			if (opts.headStatus) {
				return new Response(null, { status: opts.headStatus });
			}
			return new Response(null, {
				status: 200,
				headers: {
					...etagHeaders(opts.etag),
					...(opts.headLength === false ? {} : { 'Content-Length': String(archive.length) }),
				},
			});
		}
		if (opts.getStatus) {
			return new Response('nope', { status: opts.getStatus });
		}
		const etag = opts.getEtag ?? opts.etag;
		const from = range && !opts.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
		if (range && !opts.ignoreRange && from >= archive.length) {
			return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${archive.length}` } });
		}
		const end = archive.length - (opts.shortBy ?? 0);
		const rest = archive.slice(from, end);
		const chunk = opts.chunk ?? 64;
		const { failAfter, holdAfter, hold } = opts;
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				signal?.addEventListener('abort', () => {
					try {
						c.error(aborted());
					} catch {
						/* already closed */
					}
				});
			},
			async pull(c) {
				if (signal?.aborted) {
					c.error(aborted());
					return;
				}
				if (failAfter !== undefined && sent >= failAfter) {
					c.error(new TypeError('network error'));
					return;
				}
				if (holdAfter !== undefined && hold && sent >= holdAfter) {
					await hold;
					if (signal?.aborted) {
						c.error(aborted());
						return;
					}
				}
				if (sent >= rest.length) {
					c.close();
					return;
				}
				let n = Math.min(chunk, rest.length - sent);
				if (failAfter !== undefined) {
					n = Math.min(n, failAfter - sent);
				}
				if (holdAfter !== undefined && hold && sent < holdAfter) {
					n = Math.min(n, holdAfter - sent);
				}
				c.enqueue(rest.slice(sent, sent + n));
				sent += n;
			},
		});
		if (range && !opts.ignoreRange) {
			const start = opts.wrongStart ? from + 1 : from;
			return new Response(body, {
				status: 206,
				headers: { ...etagHeaders(etag), 'Content-Range': `bytes ${start}-${archive.length - 1}/${archive.length}` },
			});
		}
		return new Response(body, {
			status: 200,
			headers: { ...etagHeaders(etag), 'Content-Length': String(archive.length) },
		});
	}) as typeof fetch;

	return {
		fetch: fetchImpl,
		requests,
		set(next: ArchiveServerOptions): void {
			opts = { etag: '"edition-1"', ...next };
		},
	};
}

/** A deterministic archive of `n` bytes (offset mod 251), so any splice of
 *  the wrong bytes shows. */
export function patternArchive(n: number, seed = 0): Uint8Array {
	return new Uint8Array(n).map((_, i) => (i + seed) % 251);
}
