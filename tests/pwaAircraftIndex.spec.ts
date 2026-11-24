/* The aircraft library's sidecar is its FILE INDEX: read network first and
 * kept a month (vite.config.ts), like the sheets it lists, so an offline
 * session can load a library whose sheets are cached. Workbox answers a
 * request with the FIRST route that matches, so the rule stands ahead of
 * every /data/ rule. */

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
