/* The HTTP edges every route shares: the CORS headers of an allowed origin,
 * JSON answers in Open-Meteo's error shape, and the per-address limit kept in
 * the isolate (loxodrome-proxy's sliding window, its LRU bound). */

export const DEFAULT_ALLOW_ORIGINS = 'https://loxodrome.fr,https://www.loxodrome.fr,https://localhost';

/** Requests a minute per address: a map lattice and a route's two
 *  requests per edit sit far below; a scripted scrape does not. */
const RATE_LIMIT = { limit: 300, windowMs: 60_000 };
const RL_MAX_KEYS = 5000;
const rlHits = new Map<string, number[]>();

export function corsHeaders(origin: string): Record<string, string> {
	return origin
		? {
				'Access-Control-Allow-Origin': origin,
				'Access-Control-Allow-Methods': 'GET, OPTIONS',
				'Access-Control-Max-Age': '86400',
				'Access-Control-Expose-Headers': 'Retry-After',
				Vary: 'Origin',
			}
		: {};
}

export function json(body: unknown, status: number, origin: string, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(origin), ...extra },
	});
}

export function failure(status: number, reason: string, origin: string, extra: Record<string, string> = {}): Response {
	return json({ error: true, reason }, status, origin, extra);
}

/** The rate-limit key: the IPv4 address, or the IPv6 /64. */
export function clientKey(ip: string): string {
	if (!ip.includes(':')) {
		return ip;
	}
	const [head, tail] = ip.split('::');
	const h = head ? head.split(':') : [];
	const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
	const full = tail !== undefined ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
	return full
		.slice(0, 4)
		.map((x) => x.replace(/^0+(?=.)/, '').toLowerCase())
		.join(':') + '::/64';
}

export function rateLimited(key: string, now: number): number {
	const hits = (rlHits.get(key) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
	rlHits.delete(key);
	if (hits.length >= RATE_LIMIT.limit) {
		rlHits.set(key, hits);
		return Math.max(1, Math.ceil((hits[0] + RATE_LIMIT.windowMs - now) / 1000));
	}
	hits.push(now);
	rlHits.set(key, hits);
	while (rlHits.size > RL_MAX_KEYS) {
		rlHits.delete(rlHits.keys().next().value as string);
	}
	return 0;
}
