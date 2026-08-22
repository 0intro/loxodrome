/* HTTP plumbing for the autorouter proxy.
 *
 * The proxy authenticates to autorouter at the application level and injects
 * the bearer token itself (see notam-proxy/worker.js, getAutorouterToken), so
 * the browser sends no credentials and no token. This is a plain
 * authenticated-by-the-proxy GET with error mapping. */

import { t } from '$lib/state/i18n.svelte';
import { UserFacingError } from '$lib/i18n/errorText';
import { humanErrorDetail, parseRetryAfterMs } from './errorDetail';
import { proxyBase } from './state.svelte';

// Hung requests must settle (the awc.ts convention): a stalled proxy socket
// would otherwise pin autorouter.fetching, and with it every NOTAM fetch
// button (notamFetchBusy), until the browser's own socket timeout. Generous:
// a /notam batch is chunky.
const FETCH_TIMEOUT_MS = 30_000;

/** GET JSON from the proxy. The proxy injects the autorouter bearer token, so
 *  no Authorization header is sent here. A 429 (autorouter's shared quota or
 *  the proxy's per-IP flood guard) maps to the localized rate-limit message;
 *  other failures carry the proxy / upstream detail (trimmed to 240 chars, via
 *  errorDetail.ts) so 4xx/5xx name their cause instead of a bare status code. */
export async function getJson<T>(url: string): Promise<T> {
	let res: Response;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (e) {
		throw new Error(
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			`Cannot reach proxy at ${proxyBase()}: ${e instanceof Error ? e.message : String(e)}`,
			{ cause: e },
		);
	}
	if (res.status === 429) {
		// A rate-limit tier refused us. When the proxy sent Retry-After (both
		// tiers do), show the exact wait; otherwise the generic line.
		const retryMs = parseRetryAfterMs(res);
		if (retryMs != null) {
			const sec = Math.ceil(retryMs / 1000);
			throw new UserFacingError(
				() => t.errors.proxyBusy(sec),
				// i18n-ignore: UserFacingError EN fallback (Error.message for consoles); the display text is the t.errors thunk
				`The service is busy right now, retry in ${sec}s.`,
			);
		}
		throw new UserFacingError(
			() => t.errors.autorouterRateLimit,
			// i18n-ignore: UserFacingError EN fallback (Error.message for consoles); the display text is the t.errors thunk
			'Too many NOTAM requests right now. Wait a few seconds and try again.',
		);
	}
	if (!res.ok) {
		const detail = await bodyDetail(res);
		throw new Error(
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			`NOTAM fetch failed: HTTP ${res.status}${detail ? ': ' + detail : ''}`,
		);
	}
	return (await res.json()) as T;
}

/** The response body reduced to its human-readable message (the RFC 6749
 *  error_description, a JSON message field, else the raw text, trimmed and
 *  capped; see errorDetail.ts), empty when unreadable. Appended to the
 *  HTTP-error diagnostics. */
async function bodyDetail(res: Response): Promise<string> {
	let body = '';
	try {
		body = await res.text();
	} catch {
		/* leave the detail empty */
	}
	return humanErrorDetail(body);
}
