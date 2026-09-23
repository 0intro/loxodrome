import { describe, it, expect } from 'vitest';
import { parseNotams } from '$lib/notam';
import { notamIntersectsBbox, type Bbox } from '$lib/notam/geometry';
import type { Notam } from '$lib/notam/types';

// A viewport fetch over central France: a 2 deg x 2 deg box around 45N 3E.
const FETCH_BBOX: Bbox = { minLat: 44, minLon: 2, maxLat: 46, maxLon: 4 };

function only(text: string): Notam {
	const notams = parseNotams(text);
	expect(notams.length).toBe(1);
	return notams[0];
}

// 10 NM circle centred at (45.0, 3.0): squarely inside the viewport.
const CIRCLE_INSIDE = `LFFA-D0001/26
Q) LFFF / QRDCA / IV / BO / W / 000/050 / 4500N00300E010
A) LFFF
B) 2605010000 C) 2606010000
E) ACTIVITY WI 10NM RADIUS CENTERED ON PSN 450000N 0030000E.
`;

// Obstacle pin (Q-line only) at (50.0, 5.0), ~440 km north of the box.
const PIN_FAR_NORTH = `B0002/26
Q) LFFF / QOBCE / IV / M / A / 000/005 / 5000N00500E001
A) LFFF
B) 2605010000 C) 2606010000
E) NEW OBSTACLE CRANE.
`;

// FIR-wide GNSS outage centred at (50.0, 3.0) with a 400 NM (~740 km) radius.
// The centre is well north of the box, but the circle still covers it.
const WIDE_FIR_NOTAM = `A0003/26
Q) LFFF / QGAAU / IV / BO / E / 000/999 / 5000N00300E400
A) LFFF
B) 2605010000 C) 2606010000
E) GNSS RAIM OUTAGE MAY OCCUR WITHIN FIR.
`;

// Small restricted-area polygon up at 50 deg N: entirely north of the box.
const POLYGON_FAR_NORTH = `LFFA-R0004/26
Q) LFFF / QRTCA / IV / BO / W / 000/050 / 5010N00510E020
A) LFFF
B) 2605010000 C) 2606010000
E) TEMPORARY RESTRICTED AREA :
1)LATERAL LIMITS :
500000N 0050000E
500000N 0052000E
502000N 0052000E
502000N 0050000E
500000N 0050000E
2)VERTICAL LIMITS:
SFC/FL050
`;

// Large polygon (40-50N, 0-6E) whose vertices all sit outside the box but
// which encloses it: a danger area you are inside even though no corner is.
const POLYGON_ENCLOSING = `LFFA-D0005/26
Q) LFFF / QRDCA / IV / BO / W / 000/200 / 4500N00300E300
A) LFFF
B) 2605010000 C) 2606010000
E) DANGER AREA :
1)LATERAL LIMITS :
400000N 0000000E
400000N 0060000E
500000N 0060000E
500000N 0000000E
400000N 0000000E
2)VERTICAL LIMITS:
SFC/FL200
`;

describe('notamIntersectsBbox', () => {
	it('keeps a small circle inside the viewport', () => {
		expect(notamIntersectsBbox(only(CIRCLE_INSIDE), FETCH_BBOX)).toBe(true);
	});

	it('drops a point NOTAM far north of the viewport', () => {
		expect(notamIntersectsBbox(only(PIN_FAR_NORTH), FETCH_BBOX)).toBe(false);
	});

	it('keeps a FIR-wide NOTAM whose large radius still covers the viewport', () => {
		const n = only(WIDE_FIR_NOTAM);
		// Fell back to the Q-line coord, carrying the 400 NM radius.
		expect(n.coordinates[0].type).toBe('qualifierLine');
		expect(n.coordinates[0].radius).toBe(400);
		expect(notamIntersectsBbox(n, FETCH_BBOX)).toBe(true);
	});

	it('drops a polygon sitting entirely north of the viewport', () => {
		const n = only(POLYGON_FAR_NORTH);
		expect(n.isPolygon).toBe(true);
		expect(notamIntersectsBbox(n, FETCH_BBOX)).toBe(false);
	});

	it('keeps a polygon that encloses the viewport with no vertex inside it', () => {
		const n = only(POLYGON_ENCLOSING);
		expect(n.isPolygon).toBe(true);
		expect(notamIntersectsBbox(n, FETCH_BBOX)).toBe(true);
	});
});
