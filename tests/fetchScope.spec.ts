/* state/fetchScope.svelte.ts: the region a fetched briefing covers, and what
 * the gate over it keeps.
 *
 * The case worth pinning is the one that made this a type rather than a box.
 * A corridor fetch selects its aerodromes and FIRs with the true
 * point-to-polyline distance, and used to DISPLAY them through the axis-
 * aligned bounding box of that corridor. On a diagonal track the two disagree
 * badly: the NOTAM below sits 48 NM off a 100 NM leg, which the box keeps and
 * the corridor does not. Measured live on LFPN-LFRS the day this landed, the
 * same 338 fetched rows showed 169 through the box and 143 through the
 * corridor.
 *
 * The other direction matters just as much: a corridor scope must not hide
 * what the briefing was FOR, so the FIR-wide entry is pinned as kept.
 *
 * The geometry itself belongs to route/notamCorridor.ts and is pinned by
 * tests/notamCorridor.spec.ts, the per-id rule included. What is pinned here
 * is only the SCOPE: which shape a briefing carries, and that the two shapes
 * answer differently over one set. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotams } from '$lib/notam';
import { routeCorridorBbox } from '$lib/route/notamCorridor';
import { filter, DEFAULT_HORIZON_H } from '$lib/state/filter.svelte';
import type { FetchScope } from '$lib/state/fetchScope.svelte';
import { filteredNotams, notamState } from '$lib/state/notam.svelte';

const NOW = '2026-07-31T12:00:00Z';

/** A 100 NM leg running SE: the diagonal is the whole point, since a track
 *  along a parallel or a meridian IS its own bounding box. */
const TRACK = [
	{ lat: 48, lon: 0 },
	{ lat: 47, lon: 2 },
];
const WIDTH_NM = 15;

/* ON: the leg's midpoint, 0 NM off track.
 * CORNER: the box's NE corner, inside it and 48 NM off the track.
 * FIRWIDE: the 999 NM whole-FIR sentinel, centred on track.
 * FAR: outside both. */
const BRIEFING = `A0001/26
Q) LFFF/QRTCA/IV/BO/AW/000/055/4730N00100E005
A) LFPN B) 2607010000 C) 2612310000
E) ON.

A0002/26
Q) LFFF/QRTCA/IV/BO/AW/000/055/4800N00200E005
A) LFPN B) 2607010000 C) 2612310000
E) CORNER.

A0003/26
Q) LFFF/QRTCA/IV/BO/AE/000/999/4730N00100E999
A) LFFF B) 2607010000 C) 2612310000
E) FIRWIDE.

A0004/26
Q) LFMM/QRTCA/IV/BO/AW/000/055/4400N00600E005
A) LFML B) 2607010000 C) 2612310000
E) FAR.
`;

function shown(scope: FetchScope | null): string[] {
	notamState.fetchScope = scope;
	return [...new Set(filteredNotams().map((it) => it.notam.id))].sort();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(NOW));
	filter.window.mode = 'now';
	filter.window.horizonH = DEFAULT_HORIZON_H;
	filter.query = '';
	filter.trafficMode = 'all';
	filter.kind = { area: true, position: true, qualifierLine: true };
	filter.altitude.enabled = false;
	notamState.notams = parseNotams(BRIEFING);
	notamState.parsedAt = Date.now();
	notamState.fetchScope = null;
});

describe('no scope', () => {
	it('shows the briefing whole', () => {
		// Paste, a file and a SOFIA PIB are each exactly what was asked for.
		expect(shown(null)).toEqual(['A0001/26', 'A0002/26', 'A0003/26', 'A0004/26']);
	});
});

describe('a bbox scope', () => {
	it('keeps the whole box, corners included', () => {
		const bbox = routeCorridorBbox(TRACK, WIDTH_NM);
		expect(bbox).not.toBeNull();
		// This is what a viewport fetch wants (a viewport IS a rectangle) and
		// what a corridor fetch used to settle for. CORNER is the difference.
		expect(shown({ kind: 'bbox', bbox: bbox! })).toContain('A0002/26');
		expect(shown({ kind: 'bbox', bbox: bbox! })).not.toContain('A0004/26');
	});
});

describe('a corridor scope', () => {
	const scope: FetchScope = { kind: 'corridor', tracks: [TRACK], halfWidthNM: WIDTH_NM };

	it('drops what lies off the corridor but inside its box', () => {
		expect(shown(scope)).not.toContain('A0002/26');
	});

	it('keeps what lies on it', () => {
		expect(shown(scope)).toContain('A0001/26');
	});

	it('keeps a FIR-wide entry, failing open with no airspaces loaded', () => {
		// A corridor fetch ASKS for the FIRs it crosses; their FIR-wide
		// entries are answers to the question and not noise around it.
		expect(shown(scope)).toContain('A0003/26');
	});

	it('drops what lies outside both', () => {
		expect(shown(scope)).not.toContain('A0004/26');
	});
});

describe('a corridor too short to draw', () => {
	it('is inert rather than empty', () => {
		// The aerodrome fetch commits null here, but a track that loses a
		// waypoint to a dataset gap must not blank the briefing either.
		const scope: FetchScope = {
			kind: 'corridor',
			tracks: [[{ lat: 48, lon: 0 }]],
			halfWidthNM: WIDTH_NM,
		};
		expect(shown(scope)).toHaveLength(4);
	});
});
