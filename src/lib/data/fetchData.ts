/* Reading a file off /data/, and telling a failure worth repeating from an
 * answer (docs/data-retry.md).
 *
 * A read either ANSWERS or FAILS. The answer is the document, or the fact
 * that the deployment holds no such file: a 404 or a 410, or in dev the
 * HTML page Vite's SPA fallback serves for a missing file. A failure is
 * TRANSIENT when asking again later can answer: no network (the fetch
 * rejects, which is also what the service worker hands back offline for a
 * file it never cached), any other refusal (a server's "not now", 5xx, 408,
 * 429, and an intermediary's: a portal's 401 or 407, a firewall's 403, a
 * static deployment answering its own files 200), a body that breaks off, a
 * read that stalls, and in a production build an HTML page where a document
 * was due, which is a captive portal or a proxy page (or `vite preview`'s
 * fallback). The rest is a FACT about the document: one that does not parse.
 * JSON is known by its BODY, never by the type the server states: an
 * Android WebView before API 29 serves the APK's own .json with no type at
 * all, and a portal can type its page as anything. The fail-soft loaders
 * used to fold every refusal into an empty list, a 503 included, and the
 * store kept that empty list as the country's rows for the session; they
 * fold only an absent file now.
 *
 * A read that receives NOTHING for DATA_IDLE_MS fails, headers and every body
 * chunk resetting the clock: a socket a fading mobile link leaves open would
 * otherwise hold its read, and the dataset's single-flight promise with it,
 * for good (passiveStore.fetchWithin, the same finding for terrain tiles).
 * Idle rather than a whole budget, because the largest file is 8 MB and a
 * slow link must be allowed to finish it. The timer is the global setTimeout,
 * which a spec's fake clock advances. */

/** How long a read may receive nothing (no headers, no body chunk) before
 *  it is abandoned as a transient failure. */
export const DATA_IDLE_MS = 30_000;

/** A read that did not produce its document. The message keeps the forms
 *  the loaders always threw (`<url>: HTTP 404`, `<url>: not JSON (got ...)`),
 *  which the panels print as the upstream's own words. */
export class DataReadError extends Error {
	readonly url: string;
	/** The HTTP status the read got, null when no answer came. */
	readonly status: number | null;
	/** Asking again later can answer: the network, the server's "not now",
	 *  a body that broke off, a stall. */
	readonly transient: boolean;
	/** The deployment holds no such file. */
	readonly absent: boolean;

	constructor(
		url: string,
		message: string,
		opts: { status: number | null; transient: boolean; absent?: boolean; cause?: unknown },
	) {
		super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
		this.name = 'DataReadError';
		this.url = url;
		this.status = opts.status;
		this.transient = opts.transient;
		this.absent = opts.absent ?? false;
	}
}

/** Is this a read failure worth asking again? Only a DataReadError says so:
 *  a loader's own decode error is a fact about the document. */
export function isTransient(e: unknown): e is DataReadError {
	return e instanceof DataReadError && e.transient;
}

export interface DataReadOptions {
	/** Read an HTML page where a document was due as an absent file (Vite
	 *  dev's SPA fallback) rather than a transient failure (a portal or proxy
	 *  page). A parameter so a spec can take both roads; the default is the
	 *  build's. */
	htmlIsAbsent?: boolean;
	/** The request's cache mode: 'no-cache' asks the server whatever the
	 *  browser holds (a sidecar read again because the answer kept for the
	 *  session picked a file since retired: GitHub Pages answers max-age=600,
	 *  and within ten minutes the browser handed the same retired answer
	 *  back). The browser's default otherwise. */
	cache?: RequestCache;
}

const HTML_IS_ABSENT = import.meta.env.DEV;

/** The statuses that say the deployment holds no such file. Every other
 *  refusal is worth asking again: a static site answers its own files 200. */
function absentStatus(status: number): boolean {
	return status === 404 || status === 410;
}

/** An HTML page where a document was due: the dev server's fallback, or a
 *  portal's page. A document of ours never opens on a tag. */
function looksLikeHtml(text: string): boolean {
	return /^\uFEFF?\s*</.test(text);
}

function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

async function read(url: string, json: boolean, opts: DataReadOptions): Promise<unknown> {
	const htmlIsAbsent = opts.htmlIsAbsent ?? HTML_IS_ABSENT;
	const ctrl = new AbortController();
	let status: number | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pipe: TransformStreamDefaultController<Uint8Array> | null = null;
	let expire: (e: DataReadError) => void = () => {};
	// The race the whole read runs against: a stall settles the read even
	// when what it waits on ignores the abort.
	const expired = new Promise<never>((_, reject) => {
		expire = reject;
	});
	expired.catch(() => {});
	const stall = (): void => {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		const e = new DataReadError(url, `${url}: no data for ${DATA_IDLE_MS / 1000} s`, { status, transient: true });
		ctrl.abort(e);
		pipe?.error(e);
		expire(e);
	};
	const poke = (): void => {
		clearTimeout(timer);
		timer = setTimeout(stall, DATA_IDLE_MS);
	};
	try {
		poke();
		let res: Response;
		try {
			res = await Promise.race([
				fetch(url, opts.cache ? { signal: ctrl.signal, cache: opts.cache } : { signal: ctrl.signal }),
				expired,
			]);
		} catch (e) {
			if (e instanceof DataReadError) {
				throw e;
			}
			throw new DataReadError(url, `${url}: ${messageOf(e)}`, { status: null, transient: true, cause: e });
		}
		poke();
		status = res.status;
		if (!res.ok) {
			const absent = absentStatus(res.status);
			throw new DataReadError(url, `${url}: HTTP ${res.status}`, {
				status: res.status,
				transient: !absent,
				absent,
			});
		}
		let text: string;
		try {
			text = res.body
				? await Promise.race([
						new Response(
							res.body.pipeThrough(
								new TransformStream<Uint8Array, Uint8Array>({
									start(c) {
										pipe = c;
									},
									transform(chunk, c) {
										poke();
										c.enqueue(chunk);
									},
								}),
							),
						).text(),
						expired,
					])
				: '';
		} catch (e) {
			if (e instanceof DataReadError) {
				throw e;
			}
			// The body broke off (a TypeError) or was aborted (a DOMException).
			throw new DataReadError(url, `${url}: ${messageOf(e)}`, { status: res.status, transient: true, cause: e });
		}
		if (looksLikeHtml(text)) {
			const ct = res.headers.get('content-type') ?? '';
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			throw new DataReadError(url, `${url}: not ${json ? 'JSON' : 'a data file'} (got ${ct || 'no content-type'})`, {
				status: res.status,
				transient: !htmlIsAbsent,
				absent: htmlIsAbsent,
			});
		}
		if (!json) {
			return text;
		}
		try {
			return JSON.parse(text) as unknown;
		} catch (e) {
			throw new DataReadError(url, `${url}: ${messageOf(e)}`, { status: res.status, transient: false, cause: e });
		}
	} finally {
		clearTimeout(timer);
	}
}

/** Read a JSON file off /data/. Rejects with a DataReadError, an absent
 *  file included. */
export async function readDataJson<T>(url: string, opts: DataReadOptions = {}): Promise<T> {
	return (await read(url, true, opts)) as T;
}

/** Read a text file off /data/ (the aircraft YAML sheets), whatever type the
 *  server states: servers type .yaml inconsistently. An HTML page is refused
 *  as it is for JSON. */
export async function readDataText(url: string, opts: DataReadOptions = {}): Promise<string> {
	return (await read(url, false, opts)) as string;
}

/** The fail-soft rule, stated once: the document, or null with a console
 *  warning when the deployment holds no such file, so the other publishers
 *  still render. Everything else rejects, for the caller's retry: a failure
 *  that may pass, and a document that does not parse, folded into an empty
 *  list, became the country's rows for the session, "nothing there" where
 *  something did not load. */
export async function readDataJsonSoft<T>(url: string, opts: DataReadOptions = {}): Promise<T | null> {
	try {
		return await readDataJson<T>(url, opts);
	} catch (e) {
		if (!(e instanceof DataReadError) || !e.absent) {
			throw e;
		}
		console.warn(e.message);
		return null;
	}
}
