/* The nav log's enroute lines over the real French airspace, on the leg that
 * showed the unit merge dropping a channel: Guédelon to Auxerre-Branches
 * (LFLA), which leaves SIV SEINE 3 for SIV SEINE 4 about six miles out. Both
 * sectors answer as "SEINE - INFORMATION" on different channels, and the leg
 * printed only the first. The channels are read from the rows, so a cycle that
 * moves either one still tests the rule, and the premise is asserted first. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rowToAirspace, type Airspace } from '$lib/data/airspaces';
import { contactLines } from '$lib/format/radio';
import {
	buildContactSpans,
	computeAirspaceSchedule,
	contactStateAt,
	enrouteFreqsByLeg,
} from '$lib/route/airspaces';
import { computeNavLog } from '$lib/route/navlog';
import type { Waypoint } from '$lib/state/route.svelte';

const raw = JSON.parse(readFileSync('public/data/fr-airspaces.json', 'utf8')) as {
	rows: unknown[][];
};
const airspaces = raw.rows
	.map((r) => rowToAirspace(r, 'fr'))
	.filter((a): a is Airspace => a != null);

function row(key: string): Airspace {
	const a = airspaces.find((x) => x.key === key);
	if (!a) {
		throw new Error(`fr-airspaces has no row ${key}`);
	}
	return a;
}

/** The channel the band would set in one sector. */
function channel(a: Airspace): string {
	const line = contactLines(a.radio, 'airspace')[0];
	if (!line) {
		throw new Error(`${a.key} publishes no channel`);
	}
	return line.freq;
}

const leg: Waypoint[] = [
	{ id: 'guedelon', lat: 47.58366, lon: 3.15548, kind: 'free', alt: 3500, altAuto: false },
	{ id: 'lfla', lat: 47.84633, lon: 3.49658, kind: 'free', alt: 3500, altAuto: false },
];

describe('the enroute lines from Guédelon to Auxerre-Branches', () => {
	const seine3 = row('LFPMFS3|SEINE 3');
	const seine4 = row('LFPMFS4|SEINE 4');
	const schedule = computeAirspaceSchedule(leg, airspaces, 110, 3500);
	const lines = enrouteFreqsByLeg(
		schedule,
		computeNavLog(leg, 110).legs.map((l) => l.cumNM),
		false,
	)[0];

	it('crosses two sectors of one unit on two channels', () => {
		expect(seine3.radio.map((r) => r.call)).toContain('SEINE - INFORMATION');
		expect(seine4.radio.map((r) => r.call)).toContain('SEINE - INFORMATION');
		expect(channel(seine3)).not.toBe(channel(seine4));
	});

	it('gives each sector its own channel, in the order they are flown', () => {
		// FIC PARIS SUD cedes to the SIV cover over the whole leg, and TMA
		// SEINE 3 (class E) is a contact under IFR only.
		expect(lines.map((l) => [`${l.label}: ${l.freq}`, l.keys])).toEqual([
			[`SEINE - INFORMATION: ${channel(seine3)}`, [seine3.key]],
			[`SEINE - INFORMATION: ${channel(seine4)}`, [seine4.key]],
		]);
	});

	it('has a line for the contact in force at every mile, on its channel', () => {
		// The live nav log bolds the line whose keys hold the contact in
		// force; the band names that contact's own channel. Both must agree
		// all the way along.
		const spans = buildContactSpans(schedule, false);
		const total = computeNavLog(leg, 110).totalNM;
		const seen = new Set<string>();
		for (let d = 0; d < total; d += 0.5) {
			const current = contactStateAt(spans, d).current;
			expect(current, `contact at ${d} NM`).not.toBeNull();
			const own = contactLines(current!.ev.radio, 'airspace')[0]?.freq;
			expect(
				lines.some((l) => l.keys.includes(current!.ev.key) && l.freq === own),
				`${current!.ev.key} on ${own} at ${d} NM`,
			).toBe(true);
			seen.add(current!.ev.key);
		}
		expect([...seen]).toEqual([seine3.key, seine4.key]);
	});
});
