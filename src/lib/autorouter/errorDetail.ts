/* Reduce an autorouter / proxy error body to its human-readable message.
 *
 * The token endpoint answers RFC 6749 section 5.2 JSON, documented on the
 * autorouter wiki (/wiki/api/authentication/):
 *   {"error": "invalid_client", "error_description": "The client credentials are invalid"}
 * Other payloads seen on the wire are ad-hoc JSON with a message field, and
 * the notam-proxy worker's own plain-text errors ("origin not allowed",
 * "upstream error: ..."). All of it is upstream wire text and stays EN by
 * policy (docs/i18n.md rule 7); this module only unwraps it. */

const MAX_DETAIL = 240;

/** The human message inside an error body: the RFC 6749 error_description,
 *  else a JSON message / error field, else the raw text; trimmed and capped
 *  either way. Empty string when the body carries nothing usable. */
export function humanErrorDetail(body: string): string {
	const raw = body.trim();
	if (raw === '') {
		return '';
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return cap(raw);
	}
	if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
		const o = parsed as Record<string, unknown>;
		for (const field of ['error_description', 'message', 'error']) {
			const v = o[field];
			if (typeof v === 'string' && v.trim() !== '') {
				return cap(v);
			}
		}
	}
	return cap(raw);
}

function cap(s: string): string {
	return s.trim().slice(0, MAX_DETAIL);
}

/** The response's Retry-After as milliseconds: integer delta-seconds (what the
 *  notam-proxy 429 refusals send) or an HTTP-date, whichever the server used;
 *  null when the header is absent or unparseable. The worker exposes Retry-After
 *  via Access-Control-Expose-Headers, so cross-origin JS can read it. */
export function parseRetryAfterMs(res: Response): number | null {
	const raw = res.headers.get('Retry-After');
	if (raw == null) {
		return null;
	}
	const trimmed = raw.trim();
	if (/^\d+$/.test(trimmed)) {
		return Number(trimmed) * 1000;
	}
	const at = Date.parse(trimmed);
	return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
