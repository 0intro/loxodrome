/* Reactive state for the autorouter connection settings.
 *
 * autorouter is authenticated at the APPLICATION level: the shared credential
 * lives in the notam-proxy Worker, which exchanges it for a bearer token
 * server-side and injects it on each /notam request (see notam-proxy/worker.js).
 * The browser therefore holds no autorouter credentials; this module keeps only
 * the proxy URL (shared infra) and the fetch status. The fetch pipeline lives
 * in session.ts (HTTP), viewport.ts (viewport-to-ICAO derivation), and fetch.ts
 * (orchestration). */

import type { ErrorText } from '$lib/i18n/errorText';
import { readItem, removeItem, writeItem } from '$lib/state/persist';
import { PROXY_DEFAULT } from '$lib/net/endpoints';

const LS_PROXY = 'loxodrome:autorouter-proxy';

// Legacy per-user credential keys, obsolete now that autorouter is
// authenticated at the application level in the Worker. Cleared once on load so
// a previously-typed password doesn't linger in this browser's localStorage.
const LS_EMAIL = 'loxodrome:autorouter-email';
const LS_PASSWORD = 'loxodrome:autorouter-password';
removeItem(LS_EMAIL);
removeItem(LS_PASSWORD);

// Which Cloudflare Worker relays /notam (and the app's other network routes)
// to their upstreams with the right CORS headers. See notam-proxy/.
//
// Sourcing order (first non-empty wins):
//   1. localStorage override under LS_PROXY -- power users can pin a
//      different proxy via DevTools without rebuilding. That tier is this
//      module's; the two below are PROXY_DEFAULT's, in net/endpoints.ts.
//   2. VITE_NOTAM_PROXY_URL build-time env var -- lets a downstream
//      deploy point at its own worker without patching the source.
//   3. The address the build ships, used by the canonical loxodrome.fr
//      deploy.

/** Which of the two autorouter fetches a status field describes: the viewport
 *  fetch (the fetch view's first section) or the route corridor fetch (its
 *  second). Both write these same fields, so each field carries the button it
 *  belongs to and each section renders only its own. */
export type AutorouterFetchKind = 'viewport' | 'route';

export const autorouter = $state<{
	proxyUrl: string;
	/** The fetch running now, null when idle. */
	fetching: AutorouterFetchKind | null;
	error: ErrorText | null;
	/** The kind of the last ATTEMPT, stamped before the pre-flight guards
	 *  (which set `error` and return without ever setting `fetching`): the
	 *  section `error` belongs to. */
	lastKind: AutorouterFetchKind | null;
}>({
	proxyUrl: loadString(LS_PROXY, PROXY_DEFAULT),
	fetching: null,
	error: null,
	lastKind: null,
});

function loadString(key: string, fallback = ''): string {
	return readItem(key) ?? fallback;
}

/** Persist a string; an empty value clears the key instead. */
function saveString(key: string, value: string): void {
	if (value) {
		writeItem(key, value);
	} else {
		removeItem(key);
	}
}

export function setProxyUrl(v: string): void {
	autorouter.proxyUrl = v.trim();
	saveString(LS_PROXY, autorouter.proxyUrl);
}

/** Proxy URL with any trailing slashes trimmed; used by session + fetch. */
export function proxyBase(): string {
	return autorouter.proxyUrl.replace(/\/+$/, '');
}
