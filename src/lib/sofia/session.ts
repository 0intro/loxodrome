/* One anonymous SOFIA-Briefing session for a burst of POSTs. The proxy's
 * /sofia/session route hands back a JSESSIONID (loxodrome-proxy/worker.js,
 * handleSofiaSession); passing it to each POST as ?session= spares the worker
 * a homepage handshake per request. Shared by the route-NOTAM briefing
 * (fetch.ts: every route of one briefing) and the TEMSI / WINTEM catalog
 * (state/sofiaCharts.svelte.ts: both products of one zone). Null whenever the
 * handshake fails, which is never fatal: a POST without the param makes the
 * worker do its own handshake inline. */

/** The handshake's budget. INVARIANT (docs/sofia-briefing.md): it outlasts the
 *  worker's own for the same call (loxodrome-proxy/worker.js FETCH_TIMEOUT_MS
 *  `session`), so the worker always answers first. Pinned by
 *  tests/sofiaTimeouts.spec.ts. */
export const SESSION_TIMEOUT_MS = 12_000;

/** One JSESSIONID from the proxy, or null (an older worker, a failed
 *  handshake, the budget spent, or `stop` aborted). */
export async function fetchSofiaSession(
	proxyBase: string,
	stop?: AbortSignal,
): Promise<string | null> {
	try {
		const timeout = AbortSignal.timeout(SESSION_TIMEOUT_MS);
		const res = await fetch(proxyBase + '/sofia/session', {
			headers: { Accept: 'application/json' },
			signal: stop ? AbortSignal.any([stop, timeout]) : timeout,
		});
		if (!res.ok) {
			return null;
		}
		const data = (await res.json()) as { session?: string };
		return data.session ?? null;
	} catch {
		return null;
	}
}
