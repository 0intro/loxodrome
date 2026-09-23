import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type L from 'leaflet';
import { parseNotams } from '$lib/notam';
import { notamAreaAt, notamAreasAt } from '$lib/state/notamHit.svelte';
import { notamState } from '$lib/state/notam.svelte';
import { filter } from '$lib/state/filter.svelte';

// Minimal Leaflet-map stub; notamAreasAt only calls map.getZoom() for the
// low-zoom cutoff, so a single-method shim is enough.
function stubMap(zoom: number): L.Map {
	return { getZoom: () => zoom } as unknown as L.Map;
}

const MAP = stubMap(10);

// Restricted-area polygon: a 20'×20' square at (47.0–47.333° N, 2.0–2.333° E).
// Contains (47.1, 2.1); misses (50, 5).
const POLY_NOTAM = `LFFA-R0001/26
Q) LFFF / QRTCA / IV / BO / W / 000/050 / 4710N00210E020
A) LFFF
B) 2605010000 C) 2606010000
E) TEMPORARY RESTRICTED AREA TEST :
1)LATERAL LIMITS :
470000N 0020000E
470000N 0022000E
472000N 0022000E
472000N 0020000E
470000N 0020000E
2)VERTICAL LIMITS:
SFC/FL050
`;

// Point-plus-radius danger area: 10 NM (~18.5 km) circle at (45.0, 3.0).
// Contains the centre; misses (45.5, 3.0) which is ~55 km north.
const CIRCLE_NOTAM = `LFFA-D0002/26
Q) LFFF / QRDCA / IV / BO / W / 000/050 / 4500N00300E010
A) LFFF
B) 2605010000 C) 2606010000
E) ACTIVITY WI 10NM RADIUS CENTERED ON PSN 450000N 0030000E.
`;

// Obstacle pin; only a Q-line coordinate with `type: 'qualifierLine'`.
// notamContains skips qualifierLine coords, so this must never hit.
const PIN_NOTAM = `B0003/26
Q) LFFF / QOBCE / IV / M / A / 000/005 / 4300N00400E001
A) LFFF
B) 2605010000 C) 2606010000
E) NEW OBSTACLE CRANE.
`;

// A wider danger circle (30 NM, ~55 km) centred at (47.0, 2.0) so that it
// covers the polygon. Used to verify ordering when several features stack.
const WIDE_CIRCLE_NOTAM = `LFFA-D0099/26
Q) LFFF / QRDCA / IV / BO / W / 000/050 / 4700N00200E030
A) LFFF
B) 2605010000 C) 2606010000
E) DANGER AREA WI 30NM RADIUS CENTERED ON PSN 470000N 0020000E.
`;

// Two rings under one id, the inner one inside the outer: the shape you click
// is not the shape the id's first entry draws.
const NESTED_NOTAM = `LFFA-R0007/26
Q) LFFF / QRTCA / IV / BO / W / 000/050 / 4710N00210E020
A) LFFF
B) 2605010000 C) 2606010000
E) TEMPORARY RESTRICTED AREA NESTED :
1)ZONE A :
470000N 0020000E
470000N 0022000E
472000N 0022000E
472000N 0020000E
470000N 0020000E
2)ZONE B :
470500N 0020500E
470500N 0021500E
471500N 0021500E
471500N 0020500E
470500N 0020500E
3)VERTICAL LIMITS:
SFC/FL050
`;

beforeEach(() => {
	// Reset before each case so prior parses don't bleed into the next test.
	notamState.notams = [];
	notamState.parsedAt = 0;
	notamState.rawText = '';
	// The hit test runs through visibleNotams, which is judged against the
	// evaluation window; the fixtures are dated 2605010000 to 2606010000, so
	// pin a window inside their validity rather than depend on the wall clock.
	filter.window.mode = 'custom';
	filter.window.fromDate = '2026-05-15';
	filter.window.fromTime = '00:00';
	filter.window.toDate = '2026-05-16';
	filter.window.toTime = '00:00';
});

afterEach(() => {
	filter.window.mode = 'now';
});

describe('notamAreasAt', () => {
	it('returns NOTAMs whose polygon contains the click', () => {
		notamState.notams = parseNotams(POLY_NOTAM);
		const hits = notamAreasAt(MAP, 47.1, 2.1);
		expect(hits.map((it) => it.notam.id)).toEqual(['LFFA-R0001/26']);
	});

	it('returns nothing when the click is outside the polygon', () => {
		notamState.notams = parseNotams(POLY_NOTAM);
		expect(notamAreasAt(MAP, 50, 5)).toEqual([]);
	});

	it('returns NOTAMs whose circle contains the click', () => {
		notamState.notams = parseNotams(CIRCLE_NOTAM);
		const hits = notamAreasAt(MAP, 45.0, 3.0); // dead-centre
		expect(hits.map((it) => it.notam.id)).toEqual(['LFFA-D0002/26']);
	});

	it('misses when the click is outside the circle radius', () => {
		notamState.notams = parseNotams(CIRCLE_NOTAM);
		// (45.5, 3.0) is ~55 km from the centre; well outside the 10 NM ring.
		expect(notamAreasAt(MAP, 45.5, 3.0)).toEqual([]);
	});

	it('ignores point-only NOTAMs (no polygon, no body radius)', () => {
		notamState.notams = parseNotams(PIN_NOTAM);
		// Even at the exact Q-line coordinate the pin contributes nothing -
		// qualifierLine coords are excluded from the hit-test.
		expect(notamAreasAt(MAP, 43.0, 4.0)).toEqual([]);
	});

	it('stacks polygon + larger circle smallest-first when both contain the click', () => {
		notamState.notams = parseNotams(POLY_NOTAM + '\n' + WIDE_CIRCLE_NOTAM);
		const ids = notamAreasAt(MAP, 47.1, 2.1).map((it) => it.notam.id);
		// Polygon is ~925 km², the 30 NM circle is ~9500 km², so the polygon
		// appears at the top of the right-click menu.
		expect(ids).toEqual(['LFFA-R0001/26', 'LFFA-D0099/26']);
	});

	it('deduplicates multi-area NOTAMs to one entry per id', () => {
		// Same id as the polygon, but two disjoint polygons. The parser emits
		// two IndexedNotam entries; the hit-test must collapse them.
		const multi = `LFFA-R0001/26
Q) LFFF / QRTCA / IV / BO / W / 000/050 / 4710N00210E040
A) LFFF
B) 2605010000 C) 2606010000
E) TEMPORARY RESTRICTED AREA MULTI :
1)ZONE A :
470000N 0020000E
470000N 0022000E
472000N 0022000E
472000N 0020000E
470000N 0020000E
2)ZONE B :
480000N 0040000E
480000N 0042000E
482000N 0042000E
482000N 0040000E
480000N 0040000E
3)VERTICAL LIMITS:
SFC/FL050
`;
		notamState.notams = parseNotams(multi);
		// Sanity-check: the parser really did emit two entries for one id.
		const sameId = notamState.notams.filter(
			(n) => n.id === 'LFFA-R0001/26',
		);
		expect(sameId.length).toBeGreaterThanOrEqual(2);
		// Click inside zone A; only one row in the menu.
		const hits = notamAreasAt(MAP, 47.1, 2.1);
		expect(hits.map((it) => it.notam.id)).toEqual(['LFFA-R0001/26']);
	});

	it('bails out at very low zoom', () => {
		notamState.notams = parseNotams(POLY_NOTAM);
		expect(notamAreasAt(stubMap(3), 47.1, 2.1)).toEqual([]);
		expect(notamAreasAt(stubMap(2), 47.1, 2.1)).toEqual([]);
		// 4+ resumes hit-testing.
		expect(notamAreasAt(stubMap(4), 47.1, 2.1).length).toBe(1);
	});

	it('keeps the SMALLEST containing entry of a multi-area NOTAM', () => {
		// Two rings of one id, the second inside the first. The menu row and a
		// left click must name the same ring, or hovering the row would
		// highlight one and clicking it select the other.
		notamState.notams = parseNotams(NESTED_NOTAM);
		const hits = notamAreasAt(MAP, 47.1, 2.1);
		expect(hits).toHaveLength(1);
		expect(hits[0].index).toBe(1);
	});
});

/* notamAreaAt is the single answer the click resolver ranks; notamAreasAt is
 * the list the right-click menu shows. They share one index and one order. */
describe('notamAreaAt', () => {
	it('returns the smallest containing shape, with its own footprint', () => {
		notamState.notams = parseNotams(POLY_NOTAM + '\n' + WIDE_CIRCLE_NOTAM);
		const hit = notamAreaAt(47.1, 2.1);
		expect(hit?.it.notam.id).toBe('LFFA-R0001/26');
		// The 20' x 20' square, about 925 km², well under the 30 NM circle.
		expect(hit?.areaM2).toBeGreaterThan(8e8);
		expect(hit?.areaM2).toBeLessThan(1e9);
	});

	it('answers with the ENTRY, not a row deduped by id', () => {
		// selectNotam and highlightNotam are per-entry, so a multi-area NOTAM
		// has to come back as the ring actually clicked.
		notamState.notams = parseNotams(NESTED_NOTAM);
		expect(notamAreaAt(47.1, 2.1)?.it.index).toBe(1);
		// Inside the outer ring only.
		expect(notamAreaAt(47.02, 2.02)?.it.index).toBe(0);
	});

	it('is null where nothing is drawn', () => {
		notamState.notams = parseNotams(POLY_NOTAM);
		expect(notamAreaAt(50, 5)).toBeNull();
	});

	it('still answers at a zoom where the menu stands down', () => {
		// The areas are drawn at every zoom (renderNotams has no gate), and
		// drawn ink has to stay clickable; a LIST of everything at that scale
		// is what is useless, not one answer.
		notamState.notams = parseNotams(POLY_NOTAM);
		expect(notamAreasAt(stubMap(3), 47.1, 2.1)).toEqual([]);
		expect(notamAreaAt(47.1, 2.1)?.it.notam.id).toBe('LFFA-R0001/26');
	});
});
