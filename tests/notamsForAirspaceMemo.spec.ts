/* notamsForAirspace is memoised per airspace on the briefing and the dataset
 * (state/notamLinks.svelte.ts): the FIS closure resolve asks it twice per
 * candidate row on every minute tick, and it walked the whole filtered
 * briefing each time. The memo must hand back the same list while nothing
 * changes, across a tick included, and invalidate on a filter change, a
 * re-parse and a new dataset. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Airspace } from '$lib/data/airspaces';

let rows: Airspace[] = [];

vi.mock('$lib/state/data.svelte', async () => {
	const actual = await vi.importActual<typeof import('$lib/state/data.svelte')>('$lib/state/data.svelte');
	return { ...actual, getAirspaces: () => rows };
});

import { parseNotams } from '$lib/notam';
import { filter } from '$lib/state/filter.svelte';
import { notamState, visibleNotams } from '$lib/state/notam.svelte';
import { notamsForAirspace } from '$lib/state/notamLinks.svelte';

const NOW = '2026-07-31T12:00:00Z';

const ACTIVATION = `A0007/26
Q) LFBB/QRRCA/IV/BO/W/000/055/4500N00100W005
A) LFBB
B) 2607010000 C) 2612310000
E) LF-R262 ACTIVE.
`;
const OTHER = `A0008/26
Q) LFBB/QRRCA/IV/BO/W/000/055/4500N00100W005
A) LFBB
B) 2607010000 C) 2612310000
E) LF-R263 ACTIVE.
`;

function airspace(id: string, name: string): Airspace {
	return {
		id,
		key: `${id}|${name}`,
		type: 'R',
		name,
		airClass: '',
		upper: null,
		lower: null,
		vUpper: null,
		vLower: null,
		vMax: null,
		vMnm: null,
		workHr: '',
		rmkWorkHr: '',
		rmk: '',
		ring: [
			[45, -1],
			[45, -0.9],
			[45.1, -0.9],
			[45.1, -1],
		],
	} as unknown as Airspace;
}

describe('notamsForAirspace (memoised on the briefing and the dataset)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		filter.window.mode = 'now';
		filter.query = '';
		rows = [airspace('LFR262', 'R 262'), airspace('LFR263', 'R 263')];
		notamState.notams = parseNotams(ACTIVATION + OTHER);
		notamState.parsedAt = Date.now();
	});

	afterEach(() => {
		vi.useRealTimers();
		notamState.notams = [];
		notamState.parsedAt = 0;
		filter.query = '';
		rows = [];
	});

	it('lists the NOTAMs linked to the airspace, and only those', () => {
		expect(notamsForAirspace(rows[0]).map((it) => it.notam.id)).toEqual(['A0007/26']);
		expect(notamsForAirspace(rows[1]).map((it) => it.notam.id)).toEqual(['A0008/26']);
		expect(notamsForAirspace(airspace('LFR999', 'R 999'))).toEqual([]);
	});

	it('hands back the same list while nothing changes, across a minute tick too', () => {
		const first = notamsForAirspace(rows[0]);
		expect(notamsForAirspace(rows[0])).toBe(first);
		vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
		notamState.tick++;
		expect(notamsForAirspace(rows[0])).toBe(first);
	});

	it('invalidates on a data filter change', () => {
		const first = notamsForAirspace(rows[0]);
		filter.query = 'LF-R263';
		const after = notamsForAirspace(rows[0]);
		expect(after).not.toBe(first);
		expect(after).toEqual([]);
	});

	it('invalidates on a re-parse of the same text', () => {
		const first = notamsForAirspace(rows[0]);
		notamState.notams = parseNotams(ACTIVATION + OTHER);
		const after = notamsForAirspace(rows[0]);
		expect(after).not.toBe(first);
		expect(after.map((it) => it.notam.id)).toEqual(['A0007/26']);
	});

	it('invalidates when the dataset is replaced (a country arriving)', () => {
		const first = notamsForAirspace(rows[0]);
		rows = [...rows];
		expect(notamsForAirspace(rows[0])).not.toBe(first);
	});
});

describe('the window split across a minute tick', () => {
	const SHORT = `A0009/26
Q) LFBB/QRTCA/IV/BO/W/000/055/4500N00100W005
A) LFBB
B) 2607010000 C) 2607311201
E) ENDS AT 1201.
`;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		filter.window.mode = 'now';
		filter.query = '';
		notamState.notams = parseNotams(ACTIVATION + OTHER + SHORT);
		notamState.parsedAt = Date.now();
	});

	afterEach(() => {
		vi.useRealTimers();
		notamState.notams = [];
		notamState.parsedAt = 0;
	});

	it('keeps the same visible array when nothing crosses the window edge', () => {
		const first = visibleNotams();
		expect(first.map((it) => it.notam.id)).toContain('A0009/26');
		vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
		notamState.tick++;
		expect(visibleNotams()).toBe(first);
	});

	it('hands out a new array once a NOTAM lapses', () => {
		const first = visibleNotams();
		vi.setSystemTime(new Date(Date.parse(NOW) + 2 * 60_000));
		notamState.tick++;
		const after = visibleNotams();
		expect(after).not.toBe(first);
		expect(after.map((it) => it.notam.id)).not.toContain('A0009/26');
	});
});

// Rows sharing an id are each judged as themselves: ENAIRE files UIR
// CANARIAS ahead of TMA CANARIAS under GCCC, and the SIA files TMA
// VILLACOUBLAY ahead of CTR VILLACOUBLAY under LFPV. Judged by id, the TMA
// CANARIAS panel listed the UIR's FIR briefing, and the CTR panel the TMA's
// links.
describe('rows sharing an id', () => {
	// The merge keys a repeat of id and name with its rank (`#2`).
	function row(key: string, type: string, name: string, source: string, category: string): Airspace {
		const id = key.split('|')[0];
		return { ...airspace(id, name), key, type, source, category } as Airspace;
	}
	// An aerodrome subject, so only the by-name link (its typed form) can
	// reach an airspace, never the designator tiers keyed on the shared id.
	const NAMES_CTR = `A0011/26
Q) LFFF/QFAXX/IV/NBO/A/000/015/4846N00212E005
A) LFPV B) 2607010000 C) 2612310000
E) CTR VILLACOUBLAY HOURS OF ACTIVITY CHANGED.
`;
	const NAMES_TMA = `A0012/26
Q) GCCC/QATCA/IV/NBO/E/000/245/2808N01526W050
A) GCCC B) 2607010000 C) 2612310000
E) TMA CANARIAS SECTOR 2 CLSD.
`;
	const FIR_ONLY = `A0013/26
Q) GCCC/QWELW/IV/BO/W/000/020/2808N01526W005
A) GCCC B) 2607010000 C) 2612310000
E) LASER EMISSION ACTIVITY.
`;

	beforeEach(() => {
		filter.query = '';
		notamState.notams = parseNotams(NAMES_CTR + NAMES_TMA + FIR_ONLY);
		notamState.parsedAt = Date.now();
	});

	afterEach(() => {
		notamState.notams = [];
		notamState.parsedAt = 0;
		rows = [];
	});

	it('lists a NOTAM naming the CTR under the CTR, filed after its TMA', () => {
		const tma = row('LFPV|VILLACOUBLAY', 'TMA', 'VILLACOUBLAY', 'fr', 'tma');
		const ctr = row('LFPV|VILLACOUBLAY#2', 'CTR', 'VILLACOUBLAY', 'fr', 'ctr');
		rows = [tma, ctr];
		expect(notamsForAirspace(ctr).map((it) => it.notam.id)).toEqual(['A0011/26']);
		expect(notamsForAirspace(tma)).toEqual([]);
	});

	it('lists the TMA its own links, filed after its UIR', () => {
		const uir = row('GCCC|UIR CANARIAS PARTE 1', 'UIR', 'UIR CANARIAS PARTE 1', 'es', 'fir');
		const tma = row('GCCC|TMA CANARIAS', 'TMA', 'TMA CANARIAS', 'es', 'tma');
		rows = [uir, tma];
		expect(notamsForAirspace(tma).map((it) => it.notam.id)).toEqual(['A0012/26']);
		expect(notamsForAirspace(uir).map((it) => it.notam.id)).toContain('A0013/26');
	});
});
