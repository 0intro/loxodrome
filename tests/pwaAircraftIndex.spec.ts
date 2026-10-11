/* The aircraft library's sidecar is its FILE INDEX: read network first and
 * kept a month (vite.config.ts), where the datasets' sidecars expire after
 * a day. Workbox answers a request with the FIRST route that matches, and
 * the sidecars' own rule matches this path too (it ends in .meta.json), so
 * the rule's place is the contract: moved below, the index would expire
 * after a day, and an offline session past it could not load a library
 * whose sheets were cached for a month. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('the aircraft index', () => {
	it('has a network-first rule of its own, kept a month, ahead of every /data/ rule', () => {
		const cfg = readFileSync('vite.config.ts', 'utf8');
		const caching = cfg.slice(cfg.indexOf('runtimeCaching: ['));
		const own = caching.indexOf("url.pathname === '/data/aircraft.meta.json'");
		const firstData = caching.indexOf("url.pathname.startsWith('/data/')");
		expect(own).toBeGreaterThan(-1);
		expect(firstData).toBeGreaterThan(own);
		const rule = caching.slice(own, firstData);
		expect(rule).toContain("handler: 'NetworkFirst'");
		expect(rule).toContain("cacheName: 'aircraft-index'");
		expect(rule).toContain('maxAgeSeconds: 60 * 60 * 24 * 30');
	});
});
