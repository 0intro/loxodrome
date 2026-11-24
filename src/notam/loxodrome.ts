/* The sibling application's address, named once.
 *
 * Two places in this shell point at Loxodrome, the bar and the loader's card,
 * and a second literal is how one of them would come to outlive a move. It
 * does not belong in $lib/net/endpoints.ts, which is the two Cloudflare
 * Workers and exists so the chart worker can be named by both a Leaflet module
 * and a pure registry; this is a link in a page, and only this app has it.
 *
 * ABSOLUTE, and it has to be. The app is published at /notam/ inside
 * Loxodrome's own site, which made a root-relative '/' look right; but it is
 * ALSO served at notam-viewer.net, masked onto that path by
 * notam-viewer-net/worker.js, and there '/' is the viewer itself. Root-relative
 * would send "Part of Loxodrome" back to the page it is on, from the one
 * address where nobody would think to check.
 *
 * No target="_blank": leaving for the full application is a deliberate
 * navigation, and from loxodrome.fr/notam/ it is not even a new site. */

/** Loxodrome, which this app is the NOTAM half of. */
export const LOXODROME_URL = 'https://loxodrome.fr/';

/** The source both applications are built from. Named here beside the other
 *  outbound address for the same reason: one spelling. */
export const SOURCE_URL = 'https://github.com/0intro/loxodrome';
