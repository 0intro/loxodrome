/* The nav log's lines at the route's aerodromes over the real data.
 *
 * Every leg flies flat at its level, so an aerodrome's CTR wholly below the
 * last leg was never crossed: arriving at Toulouse-Blagnac at 3000 ft, the
 * walk met TMA TOULOUSE 1.1 and never CTR BLAGNAC (surface to 2000 ft),
 * whose BLAGNAC Approche 121.105 the descent works.
 *
 * An aerodrome printed its whole AD 2.18: LFPM's SEINE Approche and SEINE
 * Information on all six of their sectors' channels, where the airspace
 * lines name the one of the sector crossed. It keeps its own stations, and
 * the publishers' codes cannot say which those are (the DFS files
 * Heringsdorf's own "Radio" as FIS, Lappeenranta files its tower as APP).
 *
 * The rows are read from the datasets, so a cycle that moves them still
 * tests the rule, and each premise is asserted first. Pure functions only
 * (no NOTAM or hours resolution), so no clock enters. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rowToAirspace, type Airspace } from '$lib/data/airspaces';
import type { Publisher } from '$lib/data/publishers';
import { aerodromeRadioLines, ownStationRadios, type Radio } from '$lib/format/radio';
import {
	airspaceCallsAt,
	computeAirspaceSchedule,
	endpointColumns,
	endpointFreqLines,
	enrouteFreqsByLeg,
	enrouteLineId,
	type EnrouteFreqLine,
} from '$lib/route/airspaces';
import { computeNavLog } from '$lib/route/navlog';
import type { Waypoint } from '$lib/state/route.svelte';

function airspacesOf(cc: Publisher): Airspace[] {
	const doc = JSON.parse(readFileSync(`public/data/${cc}-airspaces.json`, 'utf8')) as { rows: unknown[][] };
	return doc.rows.map((r) => rowToAirspace(r, cc)).filter((a): a is Airspace => a != null);
}
const airspaces = airspacesOf('fr');

/** An aerodrome row of a publisher's dataset: its position and radios. */
function airportOf(cc: string, ident: string): { lat: number; lon: number; radios: Radio[] } {
	const doc = JSON.parse(readFileSync(`public/data/${cc}-airports.json`, 'utf8')) as {
		fields: string[];
		rows: unknown[][];
	};
	const f = doc.fields;
	const r = doc.rows.find((x) => x[f.indexOf('ident')] === ident);
	if (!r) {
		throw new Error(`${cc}-airports has no ${ident}`);
	}
	const radios = (r[f.indexOf('frequencies')] as string[][]).map(([freq, unit, call]) => ({ freq, unit, call }));
	return { lat: r[f.indexOf('lat')] as number, lon: r[f.indexOf('lon')] as number, radios };
}
const airportAt = (ident: string) => airportOf('fr', ident);

/** The lines an aerodrome prints beside the airspace lines. */
function ownLines(ap: { lat: number; lon: number; radios: Radio[] }, over: Airspace[]) {
	return aerodromeRadioLines(ownStationRadios(ap.radios, airspaceCallsAt(ap.lat, ap.lon, over)));
}
const channels = (lines: { freq: string }[]) => lines.flatMap((l) => l.freq.split(' / '));

function ctr(name: string): Airspace {
	const a = airspaces.find((x) => x.type === 'CTR' && x.name === name);
	if (!a) {
		throw new Error(`fr-airspaces has no CTR ${name}`);
	}
	return a;
}

const lfbo = airportAt('LFBO');
/** From west of Toulouse to Blagnac, both legs' level `alt`. */
function arrival(alt: number): Waypoint[] {
	return [
		{ id: 'west', lat: 43.75, lon: 1.0, kind: 'free', alt, altAuto: false },
		{ id: 'lfbo', lat: lfbo.lat, lon: lfbo.lon, kind: 'airport', ident: 'LFBO', alt, altAuto: false },
	];
}

/** The last leg's lines and the destination's descent lines, `block` the
 *  channels the aerodrome's own lines print. */
function descent(alt: number, block: string[] = []): { leg: EnrouteFreqLine[]; lines: EnrouteFreqLine[] } {
	const wps = arrival(alt);
	const schedule = computeAirspaceSchedule(wps, airspaces, 100, alt);
	const leg = enrouteFreqsByLeg(schedule, computeNavLog(wps, 100).legs.map((l) => l.cumNM), false)[0];
	const col = endpointColumns(wps, airspaces, alt).destination;
	return { leg, lines: endpointFreqLines(col, false, leg, block) };
}

const view = (ls: EnrouteFreqLine[]) => ls.map((l) => `${l.label}: ${l.freq}`);

describe('the descent into Toulouse-Blagnac', () => {
	const blagnac = ctr('BLAGNAC');

	it('crosses CTR BLAGNAC, worked by its tower and its approach, below 3000 ft', () => {
		expect(blagnac.vUpper).toMatchObject({ ft: 2000, ref: 'AMSL' });
		expect(blagnac.radio.map((r) => `${r.call} ${r.freq}`)).toEqual(
			expect.arrayContaining(['BLAGNAC - TOUR 118.105', 'BLAGNAC - APPROCHE 121.105']),
		);
	});

	it('names the CTR the last leg flies over at 3000 ft', () => {
		const { leg, lines } = descent(3000);
		expect(leg.some((l) => l.keys.includes(blagnac.key))).toBe(false);
		expect(view(lines)).toEqual(
			expect.arrayContaining(['BLAGNAC - TOUR: 118.105', 'BLAGNAC - APPROCHE: 121.105']),
		);
		expect(endpointColumns(arrival(3000), airspaces, 3000).departure).toEqual([]);
	});

	it('leaves to the last leg the CTR it flies in at 2000 ft', () => {
		// The ceiling counts as inside, as the walk reads it.
		const { leg, lines } = descent(2000);
		expect(leg.some((l) => l.keys.includes(blagnac.key))).toBe(true);
		expect(lines.some((l) => l.keys.includes(blagnac.key))).toBe(false);
	});

	it('repeats no channel of the last leg or of the aerodrome block', () => {
		for (const alt of [2000, 3000, 4500]) {
			const { leg, lines } = descent(alt);
			const legIds = new Set(leg.map(enrouteLineId));
			expect(lines.filter((l) => legIds.has(enrouteLineId(l))), `${alt} ft`).toEqual([]);
		}
		// The tower channel the aerodrome prints is left to it.
		expect(view(descent(3000, ['118.105']).lines)).not.toContain('BLAGNAC - TOUR: 118.105');
	});
});

describe("an aerodrome's own stations", () => {
	it("leaves Melun's SEINE units to the sectors' lines", () => {
		const lfpm = airportAt('LFPM');
		const units = new Set(lfpm.radios.map((r) => r.unit));
		expect([...units]).toEqual(expect.arrayContaining(['APP', 'FIS', 'TWR', 'AFIS', 'ATIS']));
		const lines = ownLines(lfpm, airspaces);
		const labels = lines.flatMap((l) => l.label.split(' / '));
		expect(labels).not.toContain('APP');
		expect(labels).not.toContain('FIS');
		// What stays is what its own services print.
		const own = lfpm.radios.filter((r) => ['TWR', 'AFIS', 'A/A', 'ATIS', 'GND', 'DEL'].includes(r.unit));
		expect(lines).toEqual(aerodromeRadioLines(own));
	});

	it("keeps Heringsdorf's own Radio, filed as FIS, and drops Bremen Radar", () => {
		const edah = airportOf('de', 'EDAH');
		expect(edah.radios).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ unit: 'FIS', call: 'HERINGSDORF RADIO' }),
				expect.objectContaining({ unit: 'ACS', call: 'BREMEN RADAR' }),
			]),
		);
		const kept = ownStationRadios(edah.radios, airspaceCallsAt(edah.lat, edah.lon, airspacesOf('de')));
		expect(kept.map((r) => r.call)).toContain('HERINGSDORF RADIO');
		expect(kept.map((r) => r.call)).not.toContain('BREMEN RADAR');
	});

	it("names Lydd's approach on its class G ATZ's line, the departure's climb", () => {
		// An ATZ is a contact whatever its class (UK Rules of the Air 2015
		// rule 11), so the unit its ATZ publishes leaves the field's own
		// lines and the climb through the ATZ names it.
		const uk = airspacesOf('uk');
		const egmd = airportOf('uk', 'EGMD');
		expect(airspaceCallsAt(egmd.lat, egmd.lon, uk)).toContain('LYDD APPROACH');
		const kept = ownStationRadios(egmd.radios, airspaceCallsAt(egmd.lat, egmd.lon, uk));
		expect(kept.map((r) => r.call)).not.toContain('LYDD APPROACH');
		expect(kept.map((r) => r.call)).toContain('LYDD TOWER');
		const wps: Waypoint[] = [
			{ id: 'egmd', lat: egmd.lat, lon: egmd.lon, kind: 'airport', ident: 'EGMD', alt: 3000, altAuto: false },
			{ id: 'east', lat: egmd.lat, lon: 1.4, kind: 'free', alt: 3000, altAuto: false },
		];
		const schedule = computeAirspaceSchedule(wps, uk, 100, 3000);
		const leg = enrouteFreqsByLeg(schedule, computeNavLog(wps, 100).legs.map((l) => l.cumNM), false)[0];
		const climb = endpointFreqLines(endpointColumns(wps, uk, 3000).departure, false, leg, []);
		expect(view(climb)).toContain('LYDD APPROACH: 120.705');
	});

	it('keeps the whole list of a field that files its tower as an approach', () => {
		const eflp = airportOf('fi', 'EFLP');
		expect(eflp.radios.map((r) => r.unit)).not.toContain('TWR');
		expect(ownStationRadios(eflp.radios, airspaceCallsAt(eflp.lat, eflp.lon, airspacesOf('fi')))).toBe(
			eflp.radios,
		);
	});

	it('names the approach the descent into Blagnac works, its tower left to the aerodrome', () => {
		const block = ownLines(lfbo, airspaces);
		expect(channels(block)).toContain('118.105');
		const lines = view(descent(3000, channels(block)).lines);
		expect(lines).toContain('BLAGNAC - APPROCHE: 121.105');
		expect(lines).not.toContain('BLAGNAC - TOUR: 118.105');
	});

	it('names the approach the climb out of Merignac works', () => {
		const lfbd = airportAt('LFBD');
		const wps: Waypoint[] = [
			{ id: 'lfbd', lat: lfbd.lat, lon: lfbd.lon, kind: 'airport', ident: 'LFBD', alt: 3000, altAuto: false },
			{ id: 'east', lat: 44.9, lon: -0.2, kind: 'free', alt: 3000, altAuto: false },
		];
		const schedule = computeAirspaceSchedule(wps, airspaces, 100, 3000);
		const leg = enrouteFreqsByLeg(schedule, computeNavLog(wps, 100).legs.map((l) => l.cumNM), false)[0];
		const col = endpointColumns(wps, airspaces, 3000).departure;
		const block = ownLines(lfbd, airspaces);
		expect(view(endpointFreqLines(col, false, leg, channels(block)))).toContain('MERIGNAC - APPROCHE: 121.205');
	});
});
