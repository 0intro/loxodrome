/* The flight plan buffer zone (FBZ): the airspace an IFR flight plan keeps
 * clear of around a reserved or restricted area while it is active (ERNIP
 * Part 3 4.6.2.3.2), "For flight planning purposes only." in AIP France ENR
 * 5.1 and 5.2. It is named for what it is in both languages, its panel says
 * so, and airspaceVolumes passes over it, over the shipped French rows. The
 * map's half (left out of the painting and the hit-test):
 * tests/airspaceSelection.spec.ts. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AIRSPACE_TYPE_LABELS, isFlightPlanBuffer, rowToAirspace, type Airspace } from '$lib/data/airspaces';
import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';
import { airspaceVolumes } from '$lib/nav/alertVolumes';

function rows(file: string): Airspace[] {
	const d = JSON.parse(readFileSync(`public/data/${file}`, 'utf8')) as { rows: unknown[][] };
	return d.rows.map((r) => rowToAirspace(r, 'fr')).filter((a): a is Airspace => a !== null);
}

describe('a flight plan buffer zone', () => {
	const all = rows('fr-airspaces.json');
	const buffers = all.filter(isFlightPlanBuffer);

	it('is the FBZ type, named in both languages after GEN 2.2 and ERNIP', () => {
		expect(isFlightPlanBuffer({ type: 'FBZ' })).toBe(true);
		expect(isFlightPlanBuffer({ type: 'D' })).toBe(false);
		expect(AIRSPACE_TYPE_LABELS.FBZ).toBe('Flight Plan Buffer Zone');
		expect(fr.data.airspaceTypes.FBZ).toBe('Zone tampon pour plan de vol (FBZ)');
		expect(en.detail.flightPlanBuffer).toMatch(/^For flight planning purposes only\./);
		expect(fr.detail.flightPlanBuffer).toMatch(/^Pour les besoins de dépôt de plan de vol uniquement\./);
	});

	it('builds no alert volume, where its zone builds one', () => {
		expect(buffers.length).toBeGreaterThan(100);
		expect(airspaceVolumes(buffers)).toEqual([]);
		// LF-R 45 S2's buffer flies from 800 ft ASFC, its zone under it.
		const zone = all.find((a) => a.id === 'LFR45S2');
		expect(zone, 'LFR45S2').toBeDefined();
		expect(airspaceVolumes([zone!])).toHaveLength(1);
	});
});
