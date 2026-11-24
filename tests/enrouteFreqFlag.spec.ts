/* A frequency change the resolver cannot tie to a published row is a flag
 * (docs/notam-relationships.md), and the nav log is where the pilot reads
 * the channel to set, on screen and on the kneeboard. "SIV SEINE 3
 * FREQUENCIES CHANGED, REFER AIP" marks SEINE 3's line and its schedule
 * cells, and a value-less change at the departure marks the aerodrome's
 * first line, each mark naming its NOTAM beside the published channel.
 *
 * The NOTAM state and the by-name link are mocked (the freqOverride.spec
 * idiom): a NOTAM names a sector when its E) carries the sector's name, and
 * the planned flight's span is wide open, the date gate having its own
 * contract. Rendered on the server over two SIV sectors and two fields. */

import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import type { Airspace } from '$lib/data/airspaces';
import { parseNotams } from '$lib/notam/parser';
import type { Notam } from '$lib/notam/types';
import { enrouteFreqsByLeg, type RouteAirspaceEvent } from '$lib/route/airspaces';
import { fromTriple } from '$lib/vertical/limits';
import { installLeafletNode } from './helpers/leafletNode';

/** A SIV sector over a ring, surface to FL115, on one channel. */
function siv(name: string, ring: [number, number][], freq: string): Airspace {
	const lats = ring.map(([lat]) => lat);
	const lons = ring.map(([, lon]) => lon);
	return {
		id: name,
		key: `${name}|${name}`,
		type: 'SIV',
		name,
		airClass: 'G',
		upper: ['STD', '115', 'FL'],
		lower: ['HEI', '0', 'FT'],
		vUpper: fromTriple(['STD', '115', 'FL']),
		vLower: fromTriple(['HEI', '0', 'FT']),
		vMax: null,
		vMnm: null,
		workHr: '',
		rmkWorkHr: '',
		rmk: '',
		entry: NO_ENTRY,
		radio: [{ freq, unit: 'INFO', call: 'SEINE - INFORMATION' }],
		ring,
		subtype: '',
		category: 'siv',
		source: 'fr',
		area: 1,
		bbox: { minLat: Math.min(...lats), minLon: Math.min(...lons), maxLat: Math.max(...lats), maxLon: Math.max(...lons) },
	} as unknown as Airspace;
}

const AIRSPACES = [
	siv('SEINE 3', [[48, 1.9], [49, 1.9], [49, 2.5], [48, 2.5]], '134.300'),
	siv('SEINE 4', [[48, 2.5], [49, 2.5], [49, 3.1], [48, 3.1]], '120.330'),
];

const AIRPORTS: Record<string, unknown> = {
	LFDA: { ident: 'LFDA', type: 'small_airport', name: 'DEPART', lat: 48.2, lon: 2.2, radios: [{ freq: '118.100', unit: 'TWR', call: 'LFDA - TOUR' }] },
	LFDB: { ident: 'LFDB', type: 'small_airport', name: 'ARRIVEE', lat: 48.2, lon: 2.8, radios: [{ freq: '119.000', unit: 'TWR', call: 'LFDB - TOUR' }] },
};

const m = vi.hoisted(() => ({ items: [] as { notam: Notam; index: number }[] }));

vi.mock('$lib/state/notam.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/notam.svelte')>();
	return {
		...actual,
		filteredNotams: () => m.items,
		notamsByIdent: () => {
			const map = new Map<string, { notam: Notam; index: number }[]>();
			for (const it of m.items) {
				for (const code of it.notam.icaoCodes) {
					map.set(code.toUpperCase(), [...(map.get(code.toUpperCase()) ?? []), it]);
				}
			}
			return map;
		},
		activeEvalWindow: () => ({ from: -8.64e15, to: 8.64e15 }),
		drawnStateAt: () => ({ fromMs: -8.64e15, toMs: 8.64e15 }),
	};
});
vi.mock('$lib/state/notamLinks.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/notamLinks.svelte')>();
	const names = (n: Notam, a: { name: string }): boolean => n.fullContent.includes(a.name);
	return {
		...actual,
		notamNamesAnyAirspace: (n: Notam) => AIRSPACES.some((a) => names(n, a)),
		notamNamesAirspace: names,
		notamsForAirspace: () => m.items,
	};
});
vi.mock('$lib/state/timeWindow.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/timeWindow.svelte')>();
	return { ...actual, plannedFlightAt: () => ({ fromMs: -8.64e15, toMs: 8.64e15 }) };
});
vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/data.svelte')>();
	return {
		...actual,
		getAirspaces: () => AIRSPACES,
		airportByIdent: (ident: string) => AIRPORTS[ident.toUpperCase()] ?? null,
		dataState: { ...actual.dataState, airspacesLoaded: true, airspacesError: null, airportsLoaded: true },
	};
});

installLeafletNode();
const { routeSettings } = await import('$lib/state/route.svelte');
const { default: NavLogSheet } = await import('$lib/components/NavLogSheet.svelte');
const { default: NavLogSchedule } = await import('$lib/components/NavLogSchedule.svelte');

type Route = import('$lib/state/route.svelte').Route;

const route: Route = {
	id: 'enroute-freq-flag',
	name: null,
	selectedWaypointId: null,
	waypoints: [
		{ id: 'lfda', lat: 48.2, lon: 2.2, kind: 'airport', ident: 'LFDA', alt: 3000, altAuto: false },
		{ id: 'lfdb', lat: 48.2, lon: 2.8, kind: 'airport', ident: 'LFDB', alt: 3000, altAuto: false },
	],
};

/** Make these NOTAMs the whole briefing. */
function brief(...texts: string[]): void {
	m.items = texts.flatMap((s) => parseNotams(s)).map((notam, index) => ({ notam, index }));
}

const TOWER_CHANGED = `A0001/26 NOTAMN
Q) LFFF/QCACF/IV/BO/A/000/999/4812N00212E005
A) LFDA B) 2602190000 C) PERM
E) FREQUENCIES CHANGED, REFER AIP AD 2.18`;

const SEINE_CHANGED = `A0002/26 NOTAMN
Q) LFFF/QCACF/IV/BO/E/000/195/4836N00222E025
A) LFFF B) 2602190000 C) PERM
E) SIV SEINE 3 FREQUENCIES CHANGED, REFER AIP`;

/** Each line the sheet prints, with the NOTAMs its mark names ('' unmarked). */
function sheetLines(props: Record<string, unknown> = {}): string[] {
	const { body } = render(NavLogSheet, { props: { route, ...props } });
	return body
		.split(/class="rep-freq(?=[\s"])/)
		.slice(1)
		.map((chunk) => {
			// The line's own markup: its text, then the mark when it has one,
			// whose opening tag comes before the first close.
			const own = chunk.slice(0, chunk.indexOf('</span>'));
			const rest = own.slice(own.indexOf('>') + 1);
			const text = (rest.includes('<') ? rest.slice(0, rest.indexOf('<')) : rest).trim();
			const tip = /class="freq-flag[^"]*" title="([^"]*)"/.exec(own);
			return tip ? `${text} [${tip[1]}]` : text;
		});
}

/** Each schedule row's airspace and frequency cells, with its mark's tip. */
function scheduleRows(): string[] {
	const { body } = render(NavLogSchedule, { props: { route } });
	return [...body.matchAll(/<tr class="ev[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)].map((row) => {
		const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
		const text = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
		const freq = cells[cells.length - 1] ?? '';
		const tip = /class="freq-flag[^"]*" title="([^"]*)"/.exec(freq);
		const name = text(cells[3] ?? '');
		return tip ? `${name} | ${text(freq)} [${tip[1]}]` : `${name} | ${text(freq)}`;
	});
}

const tip = (id: string) => `A frequency change in NOTAM ${id} could not be matched to a published service`;

describe('a frequency change the resolver cannot place', () => {
	routeSettings.enrouteFreqsInNavlog = true;
	routeSettings.airportFreqsInNavlog = true;

	it('leaves every line unmarked while the briefing holds none', () => {
		brief();
		expect(sheetLines()).toEqual([
			'TWR: 118.100',
			'SEINE - INFORMATION: 134.300',
			'SEINE - INFORMATION: 120.330',
			'TWR: 119.000',
		]);
	});

	it('marks the line of the sector it names, and that line alone', () => {
		brief(SEINE_CHANGED);
		expect(sheetLines()).toEqual([
			'TWR: 118.100',
			`SEINE - INFORMATION: 134.300 [${tip('A0002/26')}]`,
			'SEINE - INFORMATION: 120.330',
			'TWR: 119.000',
		]);
	});

	it("marks the aerodrome's lines on their first", () => {
		brief(TOWER_CHANGED);
		expect(sheetLines()).toEqual([
			`TWR: 118.100 [${tip('A0001/26')}]`,
			'SEINE - INFORMATION: 134.300',
			'SEINE - INFORMATION: 120.330',
			'TWR: 119.000',
		]);
	});

	it('prints the mark on the kneeboard card', () => {
		brief(SEINE_CHANGED, TOWER_CHANGED);
		expect(sheetLines({ kneeboard: true })).toEqual([
			`TWR: 118.100 [${tip('A0001/26')}]`,
			`SEINE - INFORMATION: 134.300 [${tip('A0002/26')}]`,
			'SEINE - INFORMATION: 120.330',
			'TWR: 119.000',
		]);
	});

	it("marks the schedule's frequency cell of the sector's rows", () => {
		brief(SEINE_CHANGED);
		const rows = scheduleRows();
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows) {
			expect(row).toMatch(
				row.startsWith('SIV SEINE 3')
					? `SEINE - INFORMATION: 134.300 [${tip('A0002/26')}]`
					: /SEINE - INFORMATION: 120\.330$/,
			);
		}
	});

	it('gathers on one line the NOTAMs of every sector served on its channel', () => {
		const ev = (key: string, atNM: number, freqFlaggedBy?: string[]): RouteAirspaceEvent => ({
			kind: 'enter',
			atNM,
			eteMin: null,
			key,
			name: key,
			type: 'SIV',
			airClass: 'G',
			category: 'siv',
			vLower: null,
			vUpper: null,
			radio: [{ freq: '134.300', unit: 'INFO', call: 'SEINE - INFORMATION' }],
			workHr: '',
			rmkWorkHr: '',
			...(freqFlaggedBy ? { freqFlaggedBy } : {}),
		});
		const lines = enrouteFreqsByLeg(
			[ev('SEINE 1', 0, ['A0002/26']), ev('SEINE 2', 2), ev('SEINE 3', 4, ['A0003/26', 'A0002/26'])],
			[10],
			false,
		);
		expect(lines[0]).toEqual([
			{
				label: 'SEINE - INFORMATION',
				freq: '134.300',
				keys: ['SEINE 1', 'SEINE 2', 'SEINE 3'],
				flaggedBy: ['A0002/26', 'A0003/26'],
			},
		]);
	});
});
