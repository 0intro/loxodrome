/* The navaid and obstacle panels list every NOTAM linked to the feature,
 * whatever the evaluation window (links-and-toggles.md, "Linked lists always
 * show"): a lapsed outage stays listed and explainable, as the airport and
 * airspace panels keep theirs. The map's cue rings keep the window. Both
 * panels read the window until notamsByNavaid / notamsByObstacle, so a
 * NOTAM that had just lapsed vanished from them while the NOTAM panel
 * still listed the feature. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotams } from '$lib/notam';
import type { Navaid } from '$lib/data/navaids';
import type { Obstacle } from '$lib/data/obstacles';

const m = vi.hoisted(() => ({ navaids: [] as Navaid[], obstacles: [] as Obstacle[] }));

vi.mock('$lib/state/data.svelte', async () => {
	const real = await vi.importActual<typeof import('$lib/state/data.svelte')>('$lib/state/data.svelte');
	return { ...real, getNavaids: () => m.navaids, getObstacles: () => m.obstacles };
});

const { notamState } = await import('$lib/state/notam.svelte');
const { filter } = await import('$lib/state/filter.svelte');
const { activeNotamsByNavaid, notamsByNavaid } = await import('$lib/state/notamNavaidLinks.svelte');
const { activeNotamsByObstacle, notamsByObstacle } = await import(
	'$lib/state/notamObstacleLinks.svelte'
);

const NOW = '2026-07-31T12:00:00Z';

const CGN: Navaid = {
	id: 'VOR-DME:CGN',
	type: 'VOR-DME',
	ident: 'CGN',
	name: 'CGN',
	lat: 49.0,
	lon: 2.0,
	freq: '',
	channel: '',
	elev: null,
	rmk: '',
	ad: '',
	source: 'fr',
};

const MAST: Obstacle = {
	id: 'FR_77009',
	type: 'mast',
	name: '77009',
	lat: 49.0,
	lon: 2.0,
	elev: null,
	hgt: 60,
	lit: false,
	group: false,
	rmk: '',
	source: 'fr',
};

// Both ended an hour before NOW.
const LAPSED = `A0101/26
Q) LFFF/QNMAS/IV/BO/AE/000/999/4900N00200E025
A) LFFF B) 2607300000 C) 2607311100
E) VOR/DME 'CGN' U/S.

A0102/26
Q) LFFF/QOLAS/IV/M/AE/000/010/4900N00200E001
A) LFFF B) 2607300000 C) 2607311100
E) OBST NR 77009 LGT U/S.
`;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(NOW));
	filter.window.mode = 'now';
	filter.query = '';
	m.navaids = [CGN];
	m.obstacles = [MAST];
	notamState.notams = parseNotams(LAPSED);
	notamState.parsedAt = Date.now();
});

afterEach(() => {
	vi.useRealTimers();
	notamState.notams = [];
	notamState.parsedAt = 0;
	m.navaids = [];
	m.obstacles = [];
});

describe('a feature panel lists a lapsed NOTAM', () => {
	it('the navaid panel keeps it, the cue ring drops it', () => {
		expect(notamsByNavaid().get(CGN.id)?.map((it) => it.notam.id)).toEqual(['A0101/26']);
		expect(activeNotamsByNavaid().get(CGN.id)).toBeUndefined();
	});

	it('the obstacle panel keeps it, the cue ring drops it', () => {
		expect(notamsByObstacle().get(MAST.id)?.map((it) => it.notam.id)).toEqual(['A0102/26']);
		expect(activeNotamsByObstacle().get(MAST.id)).toBeUndefined();
	});
});
