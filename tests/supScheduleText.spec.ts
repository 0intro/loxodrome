/* A supplement's schedule as its panel prints it
 * (components/supScheduleText.ts): each line says how its period holds, a
 * standing rule reads over the whole validity, and the line in force at the
 * time the map shows is the one whose period reaches it, as the panel asks
 * (rulePeriods, zoneStanding). The supplements are the shipped ones. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { rulePeriods } from '$lib/data/activity';
import { loadSupAip, SUPAIP_URL, supZoneSun, zoneSchedule, type SupAip } from '$lib/data/supaip';
import { activationText, standingText } from '$lib/components/supScheduleText';
import { zoneStanding } from '$lib/nav/alertVolumes';
import { i18n } from '$lib/state/i18n.svelte';

let SUPS: SupAip[] = [];
const sup = (title: string) => SUPS.find((s) => s.title === title && s.region === 'metropole') as SupAip;

describe('a supplement schedule on its panel', () => {
	beforeAll(async () => {
		vi.stubGlobal('fetch', (url: string) =>
			Promise.resolve(
				new Response(readFileSync(new URL(`../public${url}`, import.meta.url), 'utf-8'), {
					headers: { 'content-type': 'application/json' },
				}),
			),
		);
		try {
			SUPS = await loadSupAip(SUPAIP_URL);
		} finally {
			vi.unstubAllGlobals();
		}
	});
	afterEach(() => {
		i18n.locale = 'en';
	});

	it('reads a standing rule over the validity, by NOTAM at its notice', () => {
		// 191/2025: "ZRT activable par NOTAM avec un préavis minimum de 48
		// heures : 2030-0530 (ETE : -1HR)".
		const s = sup('191/2025');
		expect(s.zones[0].standing.map(standingText)).toEqual([
			'Throughout the validity: 20:30 - 05:30, activated by NOTAM, 48 h notice (summer: 1 h earlier)',
		]);
		i18n.locale = 'fr';
		expect(standingText(s.zones[0].standing[0])).toBe(
			'Pendant toute la validité : 20:30 - 05:30, activée par NOTAM, préavis 48 h (été : 1 h plus tôt)',
		);
		// The night is in force at 22:00Z and not at noon.
		const [rule] = zoneStanding(s, s.zones[0]);
		const at = (iso: string) => rulePeriods(rule, Date.parse(iso), Date.parse(iso), supZoneSun(s, s.zones[0]), 1).length > 0;
		expect([at('2026-11-23T22:00:00Z'), at('2026-11-23T12:00:00Z')]).toEqual([true, false]);
	});

	it('says which periods may be activated, and one alone is in force', () => {
		// 153/2026's ZRT BLOIS on a Monday at 08:00Z.
		const s = sup('153/2026');
		const z = s.zones[0];
		const lines = (zoneSchedule(s, z) ?? []).map(activationText);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.every((l) => l.endsWith('may be activated'))).toBe(true);
		const t = Date.parse('2026-11-23T08:00:00Z');
		const inForce = (zoneSchedule(s, z) ?? []).filter(
			(a) => rulePeriods({ ...a, mode: a.mode ?? 'firm' }, t, t, supZoneSun(s, z), 1).length > 0,
		);
		expect(inForce).toHaveLength(1);
	});

	it('leaves a firm period bare', () => {
		expect(activationText({ date: '2026-06-11', from: '12:00', to: '18:00' })).toBe('11 Jun 2026, 12:00 - 18:00');
	});
});
