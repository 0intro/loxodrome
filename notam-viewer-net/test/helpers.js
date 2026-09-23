/* The zero-dependency test harness (the notam-proxy/test posture): node:test,
 * no wrangler, no miniflare, no network. The worker is driven through its own
 * fetch handler with globalThis.fetch stubbed, so what the tests observe is the
 * URL it asks upstream for, which IS the whole worker. */

let seq = 0;

/** A fresh worker module per test. This worker holds no module state, so the
 *  cache-bust is belt and braces; it is here because the other two workers'
 *  suites do it and a future binding would need it. */
export async function freshWorker() {
	const href = new URL('../worker.js', import.meta.url).href + '?fresh=' + seq++;
	return await import(href);
}

/** Stub globalThis.fetch and record what the worker asked for. */
export function stubFetch(handler = () => new Response('ok')) {
	const calls = [];
	globalThis.fetch = async (input, init) => {
		const url = typeof input === 'string' ? input : input.url;
		// The INPUT is recorded beside the init because the worker calls
		// fetch(Request, init): the method, headers and body are on the
		// Request and only the redirect mode is in the init.
		calls.push({ url, init, input });
		return handler(url, init, calls.length);
	};
	return calls;
}

/** A request at the masked domain. */
export function req(
	path,
	{ host = 'notam-viewer.net', method = 'GET', headers = {}, scheme = 'https' } = {},
) {
	// `scheme` because http is a case with its own behaviour, not a typo: the
	// worker has to send it to https before anything else, the proxy's
	// allow-list being per-ORIGIN and http a different one.
	return new Request(`${scheme}://${host}${path}`, { method, headers });
}
