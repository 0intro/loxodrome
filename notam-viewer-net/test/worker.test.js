/* What notam-viewer.net serves.
 *
 * The worker is one mapping, so the suite is the mapping's table plus the two
 * cases that are about safety rather than routing. Those two are why the
 * mapping is a PREFIX and not a pass-through, and they are the reason to read
 * this file before changing worker.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshWorker, req, stubFetch } from './helpers.js';

/** The upstream URL the worker asks for, given a path at the masked domain. */
async function upstreamFor(path, opts) {
	const mod = await freshWorker();
	const calls = stubFetch();
	await mod.default.fetch(req(path, opts));
	assert.equal(calls.length, 1, 'expected exactly one upstream request');
	return calls[0].url;
}

test('the root serves the viewer, not a Pages redirect to it', async () => {
	// '/notam' without the slash would cost a second hop: Pages answers it with
	// a 301 of its own.
	assert.equal(await upstreamFor('/'), 'https://loxodrome.fr/notam/');
});

test('an ordinary path lands inside the viewer', async () => {
	assert.equal(await upstreamFor('/index.html'), 'https://loxodrome.fr/notam/index.html');
});

test('/index.html is the viewer and NOT the flight app', async () => {
	// The case the prefix mapping exists for. Passing paths through unchanged
	// would send this to loxodrome.fr/index.html, which is Loxodrome's shell;
	// serving that here would register its service worker on THIS origin, and
	// that worker answers unmatched navigations with its own index.html. An old
	// bookmark would convert the domain into the wrong app, offline-first.
	const url = await upstreamFor('/index.html');
	assert.ok(url.startsWith('https://loxodrome.fr/notam/'), url);
	assert.notEqual(url, 'https://loxodrome.fr/index.html');
});

test('/sw.js resolves inside the viewer, where there is no service worker', async () => {
	// dist/notam/ ships none, by decision, pinned by tests/notamViewerSite.spec.ts.
	// So this 404s upstream and no worker can be registered on this origin at
	// all. Safety by construction rather than by an allow-list.
	assert.equal(await upstreamFor('/sw.js'), 'https://loxodrome.fr/notam/sw.js');
});

test('/v2/sw.js reaches the old beta\'s kill switch, which the viewer ships', async () => {
	// The one worker script that must NOT 404. The old site's /v2/ beta
	// installed a service worker that serves an expired AIRAC cycle from its
	// own precache; the kill switch there unregisters it on the next update
	// check, and a 404 on that fetch would leave it in place for good. The
	// file ships at dist/notam/v2/sw.js (src/notam/public/v2), pinned by
	// tests/notamViewerSite.spec.ts; this pins the half that is the mask's.
	assert.equal(await upstreamFor('/v2/sw.js'), 'https://loxodrome.fr/notam/v2/sw.js');
	assert.equal(await upstreamFor('/v2/'), 'https://loxodrome.fr/notam/v2/');
});

test("the viewer's own assets are not prefixed twice", async () => {
	assert.equal(
		await upstreamFor('/notam/assets/notam-abc123.js'),
		'https://loxodrome.fr/notam/assets/notam-abc123.js',
	);
});

test('/notam without a trailing slash is already in base', async () => {
	assert.equal(await upstreamFor('/notam'), 'https://loxodrome.fr/notam');
});

test('the shared paths keep the site root', async () => {
	// Audited against the built document and the loaders: the datasets are all
	// the viewer reads from outside its own base.
	for (const [path, want] of [
		['/data/fr-airspaces.json', 'https://loxodrome.fr/data/fr-airspaces.json'],
		['/data/airports.meta.json', 'https://loxodrome.fr/data/airports.meta.json'],
	]) {
		assert.equal(await upstreamFor(path), want, path);
	}
});

test('the icons are the VIEWER own, not the site ones', async () => {
	// The viewer ships its own mark from its own publicDir, so these resolve
	// inside its base like everything else. The root probe is the case that
	// matters: a browser asks this domain for /favicon.ico with no <link> to
	// go on, and the answer has to be this app's mark rather than Loxodrome's.
	for (const path of ['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png']) {
		assert.equal(await upstreamFor(path), `https://loxodrome.fr/notam${path}`, path);
	}
});

test('a path that merely starts like a shared one is still prefixed', async () => {
	// /database is not /data/.
	assert.equal(await upstreamFor('/database'), 'https://loxodrome.fr/notam/database');
	assert.equal(await upstreamFor('/favicon.ico.bak'), 'https://loxodrome.fr/notam/favicon.ico.bak');
});

test('the query string survives, which the ?file= boot parameter needs', async () => {
	assert.equal(
		await upstreamFor('/?file=https%3A%2F%2Fexample.org%2Fbrief.txt'),
		'https://loxodrome.fr/notam/?file=https%3A%2F%2Fexample.org%2Fbrief.txt',
	);
});

test('http redirects to https, because the proxy allow-list is per-ORIGIN', async () => {
	// Masking over http is the worst kind of working: the page loads, looks
	// entirely right, and every proxy fetch is refused, the allow-list
	// carrying the https origin and a browser treating the http one as
	// different. Seen live, as a whole application that could not brief.
	const mod = await freshWorker();
	const calls = stubFetch();
	const res = await mod.default.fetch(req('/?file=x', { scheme: 'http' }));
	assert.equal(res.status, 301);
	assert.equal(res.headers.get('location'), 'https://notam-viewer.net/?file=x');
	assert.equal(calls.length, 0, 'a redirect must not also fetch upstream');
});

test('http on www takes ONE redirect to the canonical origin', async () => {
	// Scheme and host are normalised together, so a reader never pays for two.
	const mod = await freshWorker();
	stubFetch();
	const res = await mod.default.fetch(
		req('/notam/', { scheme: 'http', host: 'www.notam-viewer.net' }),
	);
	assert.equal(res.status, 301);
	assert.equal(res.headers.get('location'), 'https://notam-viewer.net/notam/');
});

test('www redirects to the apex instead of masking a second host', async () => {
	const mod = await freshWorker();
	const calls = stubFetch();
	const res = await mod.default.fetch(req('/some/path', { host: 'www.notam-viewer.net' }));
	assert.equal(res.status, 301);
	assert.equal(res.headers.get('location'), 'https://notam-viewer.net/some/path');
	assert.equal(calls.length, 0, 'a redirect must not also fetch upstream');
});

test('follows an upstream redirect instead of handing it to the reader', async () => {
	// The leak this worker exists to prevent, and it was live: an incoming
	// Request carries redirect 'manual', fetch inherits it from the Request it
	// is given, and Pages answers any directory path without a trailing slash
	// with a 301 to an ABSOLUTE loxodrome.fr Location. notam-viewer.net/notam
	// sent the reader off the masked domain.
	const mod = await freshWorker();
	const calls = stubFetch();
	await mod.default.fetch(req('/notam'));
	assert.equal(calls[0].init?.redirect, 'follow');
});

test('rewrites a surviving Location back onto the masked host', async () => {
	// Behind the follow, for a 3xx that following cannot resolve. Only the host
	// moves: mapping the path back is ambiguous, and a working address with a
	// redundant prefix beats a guess.
	const mod = await freshWorker();
	stubFetch(() =>
		new Response(null, {
			status: 301,
			headers: { location: 'https://loxodrome.fr/notam/somewhere/' },
		}),
	);
	const res = await mod.default.fetch(req('/somewhere'));
	assert.equal(res.status, 301);
	assert.equal(res.headers.get('location'), 'https://notam-viewer.net/notam/somewhere/');
});

test('leaves a Location pointing anywhere else alone', async () => {
	const mod = await freshWorker();
	stubFetch(() =>
		new Response(null, { status: 302, headers: { location: 'https://example.org/x' } }),
	);
	const res = await mod.default.fetch(req('/x'));
	assert.equal(res.headers.get('location'), 'https://example.org/x');
});

test('the method and headers are forwarded whole', async () => {
	const mod = await freshWorker();
	const calls = stubFetch();
	await mod.default.fetch(req('/', { method: 'HEAD', headers: { 'x-probe': '1' } }));
	const sent = calls[0].input;
	assert.equal(sent.method, 'HEAD');
	assert.equal(sent.headers.get('x-probe'), '1');
});
