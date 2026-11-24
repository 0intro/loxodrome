/* The France-wide zone NOTAMs (state/zoneNotams.svelte.ts, the proxy's
 * /notam/fr-zones): the answer's rows read as the NOTAMs they are and join
 * the loaded briefing's for the activation joins, each once. A zone the
 * answer leaves silent keeps its reading (tests/zoneActivity.spec.ts). A
 * NOTAM of the answer creating a zone of its own is drawn beside the
 * briefing's, addressed by a negative index, and an open panel follows it
 * across a refresh. The map loads the airspaces for the zones it activates,
 * every category off and no briefing loaded. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyZoneAnswer, zoneNotamState } from '$lib/state/zoneNotams.svelte';
import {
	answerAreaNotams,
	drawnNotams,
	joinNotams,
	notamAt,
	notamIndexById,
	notamState,
	selectedNotam,
} from '$lib/state/notam.svelte';
import { ui } from '$lib/state/ui.svelte';

const T = Date.UTC(2026, 10, 23, 10);

// R2724/26, LF-R 174 activated Monday to Friday, as autorouter rows it.
const ROW = {
	series: 'R',
	number: 2724,
	year: 26,
	code23: 'RT',
	code45: 'CA',
	itema: 'LFRR',
	itemd: 'MON-FRI H24',
	iteme: 'LF-R 174 ACTIVE.',
	startvalidity: T / 1000 - 86_400,
	endvalidity: T / 1000 + 30 * 86_400,
	fir: 'LFRR',
	traffic: 'IV',
	purpose: 'BO',
	scope: 'W',
	lower: 0,
	upper: 30,
	lat: 47.9,
	lon: -2.1,
	radius: 5,
};

// R3338/26 (LFFF, 2026-11-22), ZRT 'EXTEL 14', a zone its own text draws.
const ZRT = {
	series: 'R',
	number: 3338,
	year: 26,
	code23: 'RT',
	code45: 'CA',
	itema: 'LFFF',
	iteme: "TEMPORARY RESTRICTED AREA (ZRT) 'EXTEL 14' FOR MICRODRONE ACT :\n1/ LATERAL LIMITS :\n483527N 0041354E\n483819N 0042619E\n483207N 0043448E\n482512N 0041658E\n483527N 0041354E",
	startvalidity: T / 1000 - 3600,
	endvalidity: T / 1000 + 86_400,
	fir: 'LFFF',
	traffic: 'IV',
	purpose: 'BO',
	scope: 'W',
	lower: 0,
	upper: 15,
	lat: 48.5,
	lon: 4.4,
	radius: 9,
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T);
});

afterEach(() => {
	vi.useRealTimers();
	ui.detail = null;
	zoneNotamState.at = null;
	zoneNotamState.notams = [];
	notamState.notams = [];
});

describe('the zone answer', () => {
	it('reads its rows as NOTAMs and joins the briefing, each once', () => {
		applyZoneAnswer(T, [ROW]);
		expect(zoneNotamState.notams.map((n) => n.id)).toContain('R2724/26');
		expect(joinNotams().map((n) => n.id)).toEqual(zoneNotamState.notams.map((n) => n.id));
		notamState.notams = [...zoneNotamState.notams];
		expect(joinNotams().filter((n) => n.id === 'R2724/26')).toHaveLength(zoneNotamState.notams.filter((n) => n.id === 'R2724/26').length);
	});

	it('draws the zones it creates apart from the briefing, and finds each NOTAM by id', () => {
		applyZoneAnswer(T, [ROW, ZRT]);
		// R2724/26 activates LF-R 174 and draws through it, R3338/26 draws.
		expect(answerAreaNotams().map((e) => [e.notam.id, e.index])).toEqual([['R3338/26', -2]]);
		expect(notamAt(-2)?.id).toBe('R3338/26');
		expect([notamIndexById('R2724/26'), notamIndexById('R3338/26'), notamIndexById('A0001/26')]).toEqual([-1, -2, null]);
		expect(drawnNotams()).toBe(drawnNotams());
		expect(drawnNotams().map((e) => e.index)).toEqual([-2]);
		// The briefing's own copy is the one drawn.
		notamState.notams = [zoneNotamState.notams[1]];
		expect(answerAreaNotams()).toEqual([]);
		expect(notamIndexById('R3338/26')).toBe(0);
	});

	it('keeps an open panel on its NOTAM across a refresh, and closes it once the NOTAM is gone', () => {
		applyZoneAnswer(T, [ROW, ZRT]);
		ui.detail = { kind: 'notam', index: -2 };
		applyZoneAnswer(T + 300_000, [{ ...ROW, number: 9999 }, ROW, ZRT]);
		expect([ui.detail?.kind === 'notam' && ui.detail.index, selectedNotam()?.id]).toEqual([-3, 'R3338/26']);
		applyZoneAnswer(T + 600_000, [ROW]);
		expect(ui.detail).toBeNull();
	});
});

describe('the map under the zone answer', () => {
	it('loads the airspaces for the zones the answer activates, every category off and no briefing', () => {
		const src = readFileSync('src/lib/components/MapView.svelte', 'utf8');
		const at = src.indexOf('const needed =');
		expect(at).toBeGreaterThan(0);
		const needed = src.slice(at, src.indexOf(';', at)).replace(/\s+/g, ' ');
		expect(needed).toBe(
			'const needed = anyOn || routeOnlyActive || notamState.notams.length > 0 || zoneNotamState.notams.length > 0 || dataState.airspacesLoaded',
		);
	});
});
