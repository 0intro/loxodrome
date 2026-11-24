/* A zone's state as its panel reads it (state/activity.svelte.ts
 * zoneActivity), the alerts' own reading: 076/2026's ZRT VAUVILLE,
 * activable by NOTAM at 30 minutes' notice, may be active before any
 * briefing, reads inactive under a bulletin loaded ten minutes before, and
 * may be active again when the notice runs out. The supplement is the
 * shipped one. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSupAip, SUPAIP_URL, type SupAip } from '$lib/data/supaip';

let SUPS: SupAip[] = [];

vi.mock('$lib/state/data.svelte', () => ({
	dataState: { airspacesLoaded: true, airportsLoaded: false, supaipLoaded: true },
	getAirspaces: () => [],
	getSupaips: () => SUPS,
	supaipByRef: () => null,
	getAirports: () => [],
	getNavaids: () => [],
	airportByIdent: () => null,
	airportLookup: () => null,
	firIdentSet: () => new Set(),
	navaidById: () => null,
	ensureAirports: () => Promise.resolve([]),
	ensureAirspaces: () => Promise.resolve(null),
	ensureNavaids: () => Promise.resolve([]),
	ensureSupaip: () => Promise.resolve(SUPS),
}));

// Monday 23 November 2026 at 10:00 UTC.
const T = Date.parse('2026-11-23T10:00:00Z');
const MIN = 60_000;

// A bulletin by hand: one NOTAM far from the Cotentin.
const BULLETIN = `R2724/26
Q) LFEE/QRRCA/IV/BO/W/000/017/4755N00724E002
A) LFEE
B) 2609280000 C) 2611272359
D) MON-FRI H24
E) RESTRICTED AREA LF-R 174 'MEYENHEIM' ACTIVE
F) SFC
G) 1700FT AMSL
`;

async function vauville(bulletinAgoMin: number | null) {
	const { notamState, parseInput } = await import('$lib/state/notam.svelte');
	const { supZone, zoneActivity } = await import('$lib/state/activity.svelte');
	if (bulletinAgoMin !== null) {
		vi.setSystemTime(T - bulletinAgoMin * MIN);
		notamState.rawText = BULLETIN;
		parseInput();
	}
	vi.setSystemTime(T);
	const v = supZone(SUPS.find((s) => s.title === '076/2026') as SupAip, 4);
	return v ? zoneActivity(v, { fromMs: T, toMs: T }) : null;
}

describe('zoneActivity', () => {
	beforeAll(async () => {
		vi.stubGlobal('fetch', (url: string) =>
			Promise.resolve(
				new Response(readFileSync(new URL(`../public${url}`, import.meta.url), 'utf-8'), {
					headers: { 'content-type': 'application/json' },
				}),
			),
		);
		try {
			SUPS = (await loadSupAip(SUPAIP_URL)).filter((s) => ['076/2026', '153/2026'].includes(s.title) && s.region === 'metropole');
		} finally {
			vi.unstubAllGlobals();
		}
	});
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers({ toFake: ['Date'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('may be active before any briefing', async () => {
		expect(SUPS.find((s) => s.title === '076/2026')?.zones[4]?.name).toBe('ZRT VAUVILLE');
		const z = await vauville(null);
		expect([z?.answer.state, z?.answer.reason, z?.noticeMin]).toEqual(['activable', 'notam-unbriefed', 30]);
	});

	it('stays may be active under a France-wide zone answer silent on it, on the panel and the strip', async () => {
		// The answer holds what is filed under the five FIRs, and a third of
		// France's activation NOTAMs are filed under an aerodrome.
		vi.setSystemTime(T);
		const { applyZoneAnswer } = await import('$lib/state/zoneNotams.svelte');
		applyZoneAnswer(T, []);
		const z = await vauville(null);
		expect([z?.answer.state, z?.answer.reason]).toEqual(['activable', 'notam-unbriefed']);
		const { bandStates } = await import('$lib/state/activity.svelte');
		const key = 'sup:metropole-2026-076#4';
		const band = bandStates([{ key }], { fromMs: T, toMs: T }, { notam: true, rtba: true }).get(key);
		expect([band?.state, band?.reason]).toEqual(['activable', 'notam-unbriefed']);
	});

	it('reads a supplement band by its key for the crossings strip, under the route\'s briefing', async () => {
		vi.setSystemTime(T);
		const { bandStates } = await import('$lib/state/activity.svelte');
		const key = 'sup:metropole-2026-076#4';
		const at = { fromMs: T, toMs: T };
		// The briefing leaves the zones activated by NOTAM unknown: may be active.
		const open = bandStates([{ key }], at, { notam: true, rtba: true }).get(key);
		expect([open?.state, open?.reason]).toEqual(['activable', 'notam-unbriefed']);
		// It covers the flight: inactive.
		const shut = bandStates([{ key }], at, { notam: false, rtba: false }).get(key);
		expect([shut?.state, shut?.reason]).toEqual(['inactive', 'notam-none']);
	});

	it('judges a crossing at its own time rather than over the day', async () => {
		vi.setSystemTime(T);
		const { bandStates, crossingRanges } = await import('$lib/state/activity.svelte');
		// 153/2026's ZRT BLOIS, "Activable de SR à SS-1HR".
		const key = 'sup:metropole-2026-153#0';
		const day = { fromMs: Date.UTC(2026, 10, 23), toMs: Date.UTC(2026, 10, 23, 23, 59) };
		expect(bandStates([{ key }], day, null).get(key)?.state).toBe('activable');
		// Crossed at 02:00Z by a flight leaving at 01:00Z at 100 kt: before
		// sunrise, so inactive from 15 min before the entry to an hour after.
		const clock = (nm: number) => Date.UTC(2026, 10, 23, 1) + nm * 36_000;
		const ranges = crossingRanges([{ key, spans: [{ enterNM: 100, leaveNM: 110 }] }], clock);
		expect(ranges.get(key)).toEqual({ fromMs: Date.UTC(2026, 10, 23, 1, 45), toMs: Date.UTC(2026, 10, 23, 3, 6) });
		const at = bandStates([{ key }], day, null, ranges).get(key);
		expect([at?.state, at?.reason]).toEqual(['inactive', 'outside']);
	});

	it('notes who knows, and a later change only where it raises the state', async () => {
		vi.setSystemTime(T);
		const { bandNotes } = await import('$lib/state/activity.svelte');
		const key = 'sup:metropole-2026-153#0';
		const day = { fromMs: Date.UTC(2026, 10, 23), toMs: Date.UTC(2026, 10, 23, 23, 59) };
		const noon = Date.UTC(2026, 10, 23, 12);
		// Crossed at night: it may be active from sunrise, and BLOIS INFO knows.
		const night = new Map([[key, { fromMs: Date.UTC(2026, 10, 23, 1, 45), toMs: Date.UTC(2026, 10, 23, 3, 6) }]]);
		const n = bandNotes([{ key }], day, null, night, noon).get(key);
		expect(n?.known.map((k) => k.unit)).toContain('BLOIS INFO');
		expect(n?.next?.answer.state).toBe('activable');
		expect(n && n.next && n.next.atMs > Date.UTC(2026, 10, 23, 6, 30) && n.next.atMs < Date.UTC(2026, 10, 23, 8)).toBe(true);
		// Crossed at noon: the change an hour before sunset lowers it, unsaid.
		const midday = new Map([[key, { fromMs: noon - 15 * MIN, toMs: noon + 60 * MIN }]]);
		expect(bandNotes([{ key }], day, null, midday, day.toMs).get(key)?.next).toBeNull();
	});

	it('reads inactive under a fresh bulletin, may be active once its notice runs out', async () => {
		const z = await vauville(10);
		expect([z?.answer.state, z?.answer.reason, z?.briefedAtMs]).toEqual(['inactive', 'notam-none', T - 10 * MIN]);
		expect([z?.next?.atMs, z?.next?.answer.reason]).toEqual([T + 20 * MIN, 'notam-notice']);
	});
});
