/* Which app this bundle is booting: the flight app (Loxodrome), or the NOTAM
 * Viewer, published inside the same site and so reading the same origin's
 * storage (docs/notam-viewer.md).
 *
 * A few state modules act on that storage the moment they load, and the
 * viewer, which has no aircraft and no navigation, must not let them: the
 * navigation trace's boot restore MOVES a finished trace to its outbox key, a
 * write into the flight app's own storage, and adopted a trace the viewer's
 * airport panel then offered Direct-To from; the aircraft module fetched the
 * whole fleet library at load for a plane the viewer never shows, and its
 * fuel chips named the flight app's selected plane. The viewer's entry marks
 * itself BEFORE its App loads (dynamically, so those modules evaluate after),
 * and nothing else needs to: unmarked, a bundle is the flight app. Plain .ts,
 * no state: it is decided once, before anything reads it. */

let notamViewer = false;

/** The NOTAM Viewer's entry, first thing (src/notam/main.ts). */
export function markNotamViewer(): void {
	notamViewer = true;
}

/** Is this the NOTAM Viewer? */
export function isNotamViewer(): boolean {
	return notamViewer;
}
