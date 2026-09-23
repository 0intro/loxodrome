/**
 * notam-viewer.net, served transparently from loxodrome.fr/notam/.
 *
 * The NOTAM Viewer used to be its own site at this domain. It is now published
 * INSIDE Loxodrome's site (docs/notam-viewer.md), which removed a second Pages
 * site, a cross-repo token and 32.6 MB of duplicated datasets. The old address
 * still has to work, and has to KEEP READING notam-viewer.net in the bar: it
 * carries the name, the links and whatever search presence the tool built over
 * the years, and it is the canonical URL the page now names.
 *
 * So this masks rather than redirects, and the whole worker is one mapping.
 *
 * THE MAPPING IS A PREFIX, AND THAT IS THE SAFETY ARGUMENT. Every path lands
 * inside the viewer's own subdirectory unless it is one of the four things the
 * viewer shares with the site around it. The obvious alternative, passing paths
 * through unchanged and special-casing only `/`, is unsafe in a way that is not
 * obvious:
 *
 *   notam-viewer.net/index.html  ->  loxodrome.fr/index.html
 *
 * which is the FLIGHT APP's shell, an old bookmark away (that URL is live on
 * the old site today). Serving it here would register Loxodrome's service
 * worker on THIS origin at scope `/`, and that worker's navigateFallback
 * answers any unmatched navigation with `index.html`. Its denylist carries
 * `/^\/notam(\/|$)/`, which cannot help, because masking is precisely the
 * operation that moves the viewer off that path. One stray visit would convert
 * this domain into the flight app for that reader, offline-first, until the
 * worker updated.
 *
 * Under the prefix mapping both of those become harmless BY CONSTRUCTION:
 *
 *   /index.html  ->  /notam/index.html  ->  200, the viewer
 *   /sw.js       ->  /notam/sw.js       ->  404, because dist/notam/ ships no
 *                                            service worker (a decision pinned
 *                                            by tests/notamViewerSite.spec.ts)
 *
 * What prefixing breaks instead is the shared paths, and that is the better
 * failure: a missing entry in SHARED is a loud 404 on the first page load, not
 * a wrong app cached on a stranger's phone.
 *
 * No HTML rewriting, deliberately. The page's canonical and og:url already name
 * notam-viewer.net, so the same bytes are correct at both addresses and this
 * worker never has to parse or track them.
 */

/** The paths the viewer reads from the SITE ROOT rather than from its own base.
 *  Audited against the built dist/notam/index.html and the loaders: the 130
 *  dataset fetches, and nothing else. It is one entry because everything else
 *  the app owns already lives under /notam/.
 *
 *  The ICONS used to be here and are not any more, which is a correctness gain
 *  and not just a tidy-up. The viewer carries its own mark again (its build has
 *  its own publicDir), so they ship at /notam/ and the prefix rule reaches them
 *  unaided; leaving them shared would have served LOXODROME's mark to a browser
 *  probing this domain's root for /favicon.ico, which is the one request the
 *  document's own <link> cannot answer. */
const SHARED = /^\/data\//;

/** Where the viewer actually lives. */
const ORIGIN_HOST = 'loxodrome.fr';
const BASE = '/notam';

/** Is this path already inside the viewer's base? `/notam` exactly counts, or
 *  it would be prefixed into `/notam/notam`. */
function inBase(pathname) {
	return pathname === BASE || pathname.startsWith(BASE + '/');
}

/** The upstream URL for a masked request. Module-private: the tests drive the
 *  fetch handler and read the URL off a stubbed fetch, which exercises the
 *  transport in the same breath. */
function upstreamUrl(requestUrl) {
	const u = new URL(requestUrl);
	u.hostname = ORIGIN_HOST;
	u.port = '';
	u.protocol = 'https:';
	if (!SHARED.test(u.pathname) && !inBase(u.pathname)) {
		// '/' becomes '/notam/', which is the one path Pages would otherwise
		// answer with a redirect of its own.
		u.pathname = u.pathname === '/' ? BASE + '/' : BASE + u.pathname;
	}
	return u.toString();
}

/** Rewrite a surviving Location back onto the masked host.
 *
 *  Belt and braces behind redirect: 'follow', which should leave none: a 3xx
 *  that following cannot resolve, or one a future rule on the other zone
 *  introduces, would otherwise hand the reader an address off the mask. A leak
 *  is the one failure this worker exists to prevent, so it is worth three
 *  lines. Only the HOST is rewritten: the path is already in the upstream's
 *  own terms, and the mapping back is ambiguous (upstream /notam/x is the
 *  image of both /x and /notam/x), so guessing would be worse than a working
 *  address with a redundant prefix. */
function maskLocation(res, maskedHost) {
	const loc = res.headers.get('location');
	if (!loc) {
		return res;
	}
	let abs;
	try {
		abs = new URL(loc, `https://${ORIGIN_HOST}/`);
	} catch {
		return res;
	}
	if (abs.hostname !== ORIGIN_HOST) {
		return res;
	}
	abs.hostname = maskedHost;
	const out = new Response(res.body, res);
	out.headers.set('location', abs.toString());
	return out;
}

export default {
	async fetch(request) {
		const url = new URL(request.url);

		// ONE canonical origin, reached in ONE redirect: https, and the apex.
		//
		// The scheme half is not housekeeping. Over http the mask WORKS: the
		// page is served, it looks entirely right, and then every request to
		// the proxy fails, because the allow-list carries
		// https://notam-viewer.net and `http://notam-viewer.net` is a
		// different origin to a browser. What the reader sees is a whole
		// application that cannot fetch a briefing, reporting that the proxy
		// could not be reached, which is true and useless. The site this
		// masks has never had the problem: Pages 301s http itself, and this
		// worker answers before anything else could.
		//
		// The www half is the older rule: a mask on both hosts would put one
		// page at two addresses on one zone, the duplicate the canonical tag
		// exists to avoid.
		if (url.protocol === 'http:' || url.hostname.startsWith('www.')) {
			url.protocol = 'https:';
			if (url.hostname.startsWith('www.')) {
				url.hostname = url.hostname.slice(4);
			}
			return Response.redirect(url.toString(), 301);
		}

		// The request is forwarded whole: method, headers and body. The reader
		// is on notam-viewer.net and every byte has to look like it came from
		// there, which is what "transparent" means here.
		//
		// redirect: 'follow' is NOT a detail. An incoming Request in a Worker
		// carries redirect: 'manual', and `fetch(url, request)` inherits it, so
		// an upstream 3xx came back to the browser verbatim with an ABSOLUTE
		// loxodrome.fr Location and the reader left the masked domain. Pages
		// issues exactly that for any directory path without a trailing slash:
		// notam-viewer.net/notam answered 301 to loxodrome.fr/notam/ until this
		// line existed. Followed here, the browser sees the final 200 and keeps
		// the address it asked for.
		// Two arguments, not three: fetch takes (resource, init), and an init
		// passed third is silently ignored. The Request carries the method,
		// headers and body; the init beside it overrides only the redirect
		// mode.
		const upstream = new Request(upstreamUrl(request.url), request);
		const res = await fetch(upstream, { redirect: 'follow' });
		return maskLocation(res, url.hostname);
	},
};
