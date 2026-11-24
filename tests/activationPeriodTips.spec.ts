/* The ACTIVE tag on an "Activated by" card and on a SUP AIP zone reads the
 * evaluation window (supZoneActivations, activatedAirspaceLinks), which runs
 * from now on by default: a NOTAM activating a zone next week wears it
 * today. Its tooltip therefore names the period, in both languages, and
 * never the present ("right now", "en ce moment"). */

import { describe, expect, it } from 'vitest';
import { detail as en } from '$lib/i18n/en/detail';
import { detail as fr } from '$lib/i18n/fr/detail';

const KEYS = ['activatesAirspaceInPeriodTip', 'activatesSupInPeriodTip', 'zoneActiveInPeriodTip'] as const;

describe('the activation tooltips', () => {
	it('name the period', () => {
		for (const k of KEYS) {
			expect(en[k], k).toMatch(/\bin the period$/);
			expect(fr[k], k).toMatch(/\bsur la période$/);
		}
	});
});
