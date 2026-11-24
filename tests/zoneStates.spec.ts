/* The states the map draws its zones in (state/zoneStates.svelte.ts): the
 * activation hatch marks a zone active over the viewed time, a dashed
 * outline one activated later in the viewing period, from the raw briefing
 * over the shipped French rows. R2724/26 activates LF-R 174 Monday to
 * Friday, LF-R 224 publishes 0800-1900 firm, LF-R 275 is in force at all
 * times. A supplement's zone takes the hatch when active, the layer's band
 * when it may be active and its dashed outline when either comes later
 * (ZRT 'BLOIS', 153/2026, activable from SR to SS-1HR, and ZRT MAGNAC
 * ALPHA, 154/2026, firm H24 on weekdays). The dashed outline marks a zone
 * inactive now: one that may be active now wears that look (LF-R 602). */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Airspace } from '$lib/data/airspaces';

vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/data.svelte')>();
	const { rowToAirspace } = await import('$lib/data/airspaces');
	const { loadSupAip } = await import('$lib/data/supaip');
	const d = JSON.parse(readFileSync('public/data/fr-airspaces.json', 'utf8')) as { rows: unknown[][] };
	const rows = d.rows.map((r) => rowToAirspace(r, 'fr')).filter((a): a is Airspace => a !== null);
	// The shipped supplements, read through the app's own loader.
	const body = readFileSync('public/data/fr-supaip.json', 'utf8');
	const fetch = globalThis.fetch;
	globalThis.fetch = () =>
		Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
	const sups = await loadSupAip();
	globalThis.fetch = fetch;
	return {
		...actual,
		getAirspaces: () => rows,
		getSupaips: () => sups,
		dataState: { ...actual.dataState, airspacesLoaded: true, supaipLoaded: true },
	};
});

const { parseNotams } = await import('$lib/notam');
const { filter } = await import('$lib/state/filter.svelte');
const { notamState } = await import('$lib/state/notam.svelte');
const { airspaceActivations, airspaceFaint, airspaceMay, notamStates, supNotamComing, supStates } = await import('$lib/state/zoneStates.svelte');
const { supHatchZones, supLayerZones, supNotamZones, supSelectionZones, supZoneDrawn } = await import('$lib/state/supaip.svelte');
const { getAirspaces, getSupaips } = await import('$lib/state/data.svelte');
const { layers } = await import('$lib/state/layers.svelte');

const R2724 = `R2724/26 NOTAMN
Q) LFEE/QRRCA/IV/BO/W/000/017/4755N00724E002
A) LFEE B) 2609280000 C) 2611272359
D) MON-FRI H24
E) RESTRICTED AREA LF-R 174 'MEYENHEIM' ACTIVE
F) SFC G) 1700FT AMSL`;

function at(iso: string, horizonH: number | null): void {
	vi.setSystemTime(Date.parse(iso));
	filter.window.mode = 'now';
	filter.window.horizonH = horizonH;
	notamState.tick++;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	notamState.notams = parseNotams(R2724);
});

afterEach(() => {
	vi.useRealTimers();
	notamState.notams = [];
});

describe('the activation hatch', () => {
	it('hatches a zone its NOTAM activates now, in the windows of its D)', () => {
		at('2026-11-20T10:00:00Z', 24); // a Friday
		const a = airspaceActivations();
		expect([a.active.has('LFR174'), a.later.has('LFR174')]).toEqual([true, false]);
	});

	it('outlines a zone its NOTAM activates later in the period, and drops it past the period', () => {
		at('2026-11-21T10:00:00Z', 72); // a Saturday, the period reaching Monday
		const a = airspaceActivations();
		expect([a.active.has('LFR174'), a.later.has('LFR174')]).toEqual([false, true]);
		at('2026-11-21T10:00:00Z', 12);
		const b = airspaceActivations();
		expect([b.active.has('LFR174'), b.later.has('LFR174')]).toEqual([false, false]);
	});

	it('hatches a zone in its published timetable, a zone in force at all times never', () => {
		at('2026-11-23T10:00:00Z', 24);
		const a = airspaceActivations();
		expect([a.active.has('LFR224'), a.active.has('LFR275'), a.later.has('LFR275')]).toEqual([true, false, false]);
		// Outside its hours it waits for its timetable, never outlined.
		at('2026-11-23T03:00:00Z', 24);
		const b = airspaceActivations();
		expect([b.active.has('LFR224'), b.later.has('LFR224')]).toEqual([false, false]);
	});

	it('draws faint a zone inactive on an authority, and only such a zone', () => {
		// Outside LF-R 224's hours, read whole.
		at('2026-11-23T03:00:00Z', 24);
		expect([airspaceFaint().has('LFR224'), airspaceFaint().has('LFR275')]).toEqual([true, false]);
		// The RTBA outside its published slots on a Sunday, before any
		// briefing, except a stretch whose seasonal timetable is unread.
		at('2026-11-22T10:00:00Z', 24);
		expect([airspaceFaint().has('LFR69'), airspaceFaint().has('LFR45C')]).toEqual([true, false]);
		// LF-R 174 on a Saturday, outside the days its hours publish, with
		// its NOTAM's Monday drawn later over it.
		at('2026-11-21T10:00:00Z', 72);
		expect([airspaceFaint().has('LFR174'), airspaceActivations().later.has('LFR174')]).toEqual([true, true]);
	});

	it('keeps a zone that may be active now out of the later outline, drawn whatever its toggle', () => {
		// LF-R 602, "Possible activation H24 by NOTAM with PN 72HR": with no
		// briefing speaking for it, it may be active now, and a NOTAM
		// activates it tomorrow. Its panel's next change says so.
		notamState.notams = parseNotams(`R9602/26 NOTAMN
Q) LFFF/QRRCA/IV/BO/W/000/025/4830N00152E002
A) LFFF B) 2611241000 C) 2611241200
E) RESTRICTED AREA LF-R 602 ACTIVE
F) SFC G) 2500FT AMSL`);
		at('2026-11-23T19:00:00Z', 24);
		const a = airspaceActivations();
		expect([a.active.has('LFR602'), a.later.has('LFR602'), airspaceFaint().has('LFR602')]).toEqual([false, false, false]);
		// The painting draws it whatever its category's toggle, in its chart
		// look, beside its NOTAM's marker.
		expect(airspaceMay().has('LFR602')).toBe(true);
		// A zone that may be active with no NOTAM to come stays the
		// category's to draw.
		expect(airspaceMay().has('LFR151')).toBe(false);
	});

	it("carries the levels its NOTAM's F) and G) state", async () => {
		const { activationPeriods } = await import('$lib/state/activity.svelte');
		const { fromNotamLimit } = await import('$lib/vertical/limits');
		const [p] = activationPeriods(notamState.notams, new Map(), null).get('LFR174') ?? [];
		expect(p?.levels).toEqual({ lower: fromNotamLimit('SFC'), upper: fromNotamLimit('1700FT AMSL') });
	});

	it('keeps the same sets across a tick that changes nothing', () => {
		at('2026-11-20T10:00:00Z', 24);
		const a = airspaceActivations();
		at('2026-11-20T10:01:00Z', 24);
		expect(airspaceActivations()).toBe(a);
	});
});

describe("the supplements' zones", () => {
	const BLOIS = 'metropole-2026-153#0';
	const MAGNAC = 'metropole-2026-154#0';

	it('takes the state each zone is in over the viewed time', () => {
		at('2026-11-23T10:00:00Z', 24);
		expect([supStates().get(BLOIS), supStates().get(MAGNAC)]).toEqual(['may', 'active']);
		// A NOTAM activating the zone hatches it whatever the toggle.
		notamState.notams = parseNotams(`R0900/26 NOTAMN
Q) LFFF/QRTCA/IV/BO/W/000/055/4735N00125E005
A) LFFF B) 2611230800 C) 2611231200
E) AIP SUP 153/2026 ZRT 'BLOIS' ACTIVATED`);
		at('2026-11-23T10:00:00Z', 24);
		expect(supStates().get(BLOIS)).toBe('activated');
		notamState.notams = parseNotams(R2724);
		// Before sunrise its period begins later in the day.
		at('2026-11-23T03:00:00Z', 24);
		expect(supStates().get(BLOIS)).toBe('later');
	});

	it('leaves the zones active on their own period, that may be active or later to the layer', () => {
		at('2026-11-23T10:00:00Z', 24);
		expect([supHatchZones().has(MAGNAC), supHatchZones().has(BLOIS)]).toEqual([false, false]);
		const state = (key: string) => supLayerZones().find((z) => `${z.sup.id}#${z.zoneIndex}` === key)?.state;
		expect([state(MAGNAC), state(BLOIS)]).toEqual(['active', 'may']);
		// A click reaches what is drawn: nothing of them with the layer off.
		layers.supaip = false;
		try {
			expect([supZoneDrawn(MAGNAC), supZoneDrawn(BLOIS)]).toEqual([false, false]);
		} finally {
			layers.supaip = true;
		}
		expect([supZoneDrawn(MAGNAC), supZoneDrawn(BLOIS)]).toEqual([true, true]);
	});

	it('draws, the layer off, a zone a NOTAM activates later, beside its marker', () => {
		// ZRT 'BLOIS' may be active now, and R0901/26 activates it tomorrow.
		notamState.notams = parseNotams(`R0901/26 NOTAMN
Q) LFFF/QRTCA/IV/BO/W/000/055/4735N00125E005
A) LFFF B) 2611240800 C) 2611241200
E) AIP SUP 153/2026 ZRT 'BLOIS' ACTIVATED`);
		at('2026-11-23T10:00:00Z', 48);
		expect([supStates().get(BLOIS), supNotamComing().has(BLOIS), supNotamComing().has(MAGNAC)]).toEqual(['may', true, false]);
		layers.supaip = false;
		try {
			expect(supNotamZones().map((z) => `${z.sup.id}#${z.zoneIndex}`)).toContain(BLOIS);
			expect([supZoneDrawn(BLOIS), supZoneDrawn(MAGNAC)]).toEqual([true, false]);
		} finally {
			layers.supaip = true;
		}
	});
});

/** A restricted area a NOTAM creates over the Somme, valid all week. */
const zone = (id: string, words: string, d?: string) =>
	`${id} NOTAMN
Q) LFFF/QRTCA/IV/BO/W/000/015/5013N00137E005
A) LFFF B) 2611230000 C) 2611292359
${d ? `D) ${d}\n` : ''}E) ZONE REGLEMENTEE TEMPORAIRE (ZRT) 'ZRT SOMME 2' :
${words}
LIMITES LATERALES :
501654N 0013537E
501457N 0014121E
501012N 0014150E
501040N 0013207E
501654N 0013537E
F) SFC G) 1500FT AMSL`;

describe('the zones NOTAMs create', () => {
	it('draws each by its state over the viewed time', () => {
		notamState.notams = parseNotams(
			[
				zone('R0001/26', 'ZRT ACTIVE'),
				zone('R0002/26', 'ZRT ACTIVABLE H24 AVEC UN PREAVIS DE 24 HEURES'),
				zone('R0003/26', 'ZRT ACTIVE', '1400-1600'),
				zone('R0004/26', 'ZRT ACTIVE', '0600-0800'),
			].join('\n\n'),
		);
		at('2026-11-23T10:00:00Z', 12);
		const s = notamStates();
		expect(['R0001/26', 'R0002/26', 'R0003/26', 'R0004/26'].map((id) => s.get(id))).toEqual([
			'active',
			'may',
			// Its window later in the day, and the morning's past for the
			// rest of a 12 h period.
			'later',
			'inactive',
		]);
	});
});

describe('the zones list', () => {
	it('lists the period zones by state, a NOTAM zone by the name its text quotes', async () => {
		const { otherSupplements, periodZones } = await import('$lib/state/zoneList.svelte');
		notamState.notams = parseNotams(zone('R0002/26', 'ZRT ACTIVABLE H24 AVEC UN PREAVIS DE 24 HEURES'));
		at('2026-11-23T10:00:00Z', 24);
		const listed = periodZones();
		const byKey = new Map(listed.map((z) => [z.key, z]));
		expect([byKey.get('sup:metropole-2026-153#0')?.state, byKey.get('sup:metropole-2026-154#0')?.state]).toEqual([
			'may',
			'active',
		]);
		expect(byKey.get('notam:R0002/26')).toMatchObject({ state: 'may', family: 'notam', name: 'ZRT SOMME 2' });
		// The supplements left to read are those no listed zone draws.
		expect(otherSupplements(listed).some((s) => s.id === 'metropole-2026-153')).toBe(false);
	});

	it('lists a zone the France-wide answer alone creates, as the map draws it, opening by its negative index', async () => {
		const { periodZones } = await import('$lib/state/zoneList.svelte');
		const { applyZoneAnswer, zoneNotamState } = await import('$lib/state/zoneNotams.svelte');
		notamState.notams = [];
		at('2026-11-23T10:00:00Z', 24);
		const t = Date.parse('2026-11-23T10:00:00Z') / 1000;
		// R3338/26 (LFFF, 2026-11-22), ZRT 'EXTEL 14', a zone its own text draws.
		applyZoneAnswer(t * 1000, [
			{
				series: 'R',
				number: 3338,
				year: 26,
				code23: 'RT',
				code45: 'CA',
				itema: 'LFFF',
				iteme: "TEMPORARY RESTRICTED AREA (ZRT) 'EXTEL 14' FOR MICRODRONE ACT :\n1/ LATERAL LIMITS :\n483527N 0041354E\n483819N 0042619E\n483207N 0043448E\n482512N 0041658E\n483527N 0041354E",
				startvalidity: t - 3600,
				endvalidity: t + 86_400,
				fir: 'LFFF',
				traffic: 'IV',
				purpose: 'BO',
				scope: 'W',
				lower: 0,
				upper: 15,
				lat: 48.5,
				lon: 4.4,
				radius: 9,
			},
		]);
		try {
			const z = periodZones().find((x) => x.key === 'notam:R3338/26');
			expect(z?.family).toBe('notam');
			expect(z?.opens.kind === 'notam' && z.opens.index < 0).toBe(true);
		} finally {
			zoneNotamState.notams = [];
			zoneNotamState.at = null;
		}
	});
});

describe("a supplement's selection", () => {
	it('adds the zone a click names alone, every zone of a supplement selected whole, each in its state', () => {
		at('2026-11-23T10:00:00Z', 24);
		const sups = getSupaips() ?? [];
		// 053/2026, 52 zones activated by NOTAM: a click on one of them.
		const sup = sups.find((x) => x.id === 'metropole-2026-053');
		const lift = sup?.zones.findIndex((z) => z.name === 'ZRT LIFT ÉVREUX') ?? -1;
		expect(sup && lift >= 0).toBe(true);
		if (!sup) {
			return;
		}
		expect(supSelectionZones(sup, lift, []).map((it) => it.zoneIndex)).toEqual([lift]);
		const whole = supSelectionZones(sup, undefined, []);
		expect(whole.length).toBe(sup.zones.filter((z) => z.geometry !== null).length);
		// A zone the layer draws stays the layer's.
		expect(supSelectionZones(sup, lift, whole)).toEqual([]);
		// Each comes in the state the map gives it: ZRT 'BLOIS' may be active.
		const blois = sups.find((x) => x.id === 'metropole-2026-153');
		expect(blois && supSelectionZones(blois, 0, [])).toEqual(blois && [{ sup: blois, zoneIndex: 0, zone: blois.zones[0], state: 'may' }]);
	});
});

describe("a zone's Activated by", () => {
	it("names the France-wide answer's NOTAM, under its negative index", async () => {
		const { applyZoneAnswer, zoneNotamState } = await import('$lib/state/zoneNotams.svelte');
		const { activatedAirspaceLinks } = await import('$lib/state/notamLinks.svelte');
		notamState.notams = [];
		at('2026-11-20T10:00:00Z', 24);
		const t = Date.parse('2026-11-20T10:00:00Z') / 1000;
		// R2724/26 as autorouter rows it, in the answer alone.
		applyZoneAnswer(t * 1000, [
			{
				series: 'R',
				number: 2724,
				year: 26,
				code23: 'RT',
				code45: 'CA',
				itema: 'LFEE',
				itemd: 'MON-FRI H24',
				iteme: "RESTRICTED AREA LF-R 174 'MEYENHEIM' ACTIVE",
				startvalidity: t - 86_400,
				endvalidity: t + 7 * 86_400,
				fir: 'LFEE',
				traffic: 'IV',
				purpose: 'BO',
				scope: 'W',
				lower: 0,
				upper: 17,
				lat: 47.92,
				lon: 7.4,
				radius: 2,
			},
		]);
		try {
			const items = activatedAirspaceLinks().get('LFR174') ?? [];
			expect(items.map((it) => [it.notam.id, it.index < 0])).toEqual([['R2724/26', true]]);
		} finally {
			zoneNotamState.notams = [];
			zoneNotamState.at = null;
		}
	});

	it("lists the answer's change NOTAM, which makes the zone read amended, beside the briefing's", async () => {
		const { applyZoneAnswer, zoneNotamState } = await import('$lib/state/zoneNotams.svelte');
		const { answerNotamsForAirspace, notamsForAirspace } = await import('$lib/state/notamLinks.svelte');
		notamState.notams = [];
		at('2026-11-20T10:00:00Z', 24);
		const t = Date.parse('2026-11-20T10:00:00Z') / 1000;
		applyZoneAnswer(t * 1000, [
			{
				series: 'R',
				number: 9174,
				year: 26,
				code23: 'RR',
				code45: 'CH',
				itema: 'LFEE',
				iteme: "RESTRICTED AREA LF-R 174 'MEYENHEIM' VERTICAL LIMITS AMENDED : SFC/2500FT AMSL",
				startvalidity: t - 86_400,
				endvalidity: t + 7 * 86_400,
				fir: 'LFEE',
				traffic: 'IV',
				purpose: 'BO',
				scope: 'W',
				lower: 0,
				upper: 25,
				lat: 47.92,
				lon: 7.4,
				radius: 2,
			},
		]);
		try {
			const r174 = getAirspaces()?.find((a) => a.id === 'LFR174');
			expect(r174).toBeDefined();
			if (!r174) {
				return;
			}
			expect(notamsForAirspace(r174)).toEqual([]);
			expect(answerNotamsForAirspace(r174).map((it) => [it.notam.id, it.index < 0])).toEqual([['R9174/26', true]]);
		} finally {
			zoneNotamState.notams = [];
			zoneNotamState.at = null;
		}
	});
});

