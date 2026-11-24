/* What a print about the plan is stamped with (state/printName.ts). The
 * flight app stamps its documents with the dossier's flight date. The NOTAM
 * Viewer, at loxodrome.fr/notam/, shares the flight app's origin and so its
 * stored flight prep, but it has no plan (planScope.flight is null there):
 * its bulletin takes the day it is printed, never the date of a dossier the
 * flight app saved months ago. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planPrintStem } from '$lib/state/printName';
import { flightPrep } from '$lib/state/flightPrep.svelte';
import { planScope, type PlanFlight } from '$lib/state/planScope.svelte';

const FLIGHT: PlanFlight = {
	window: () => null,
	flyable: () => true,
	etdStated: () => false,
	timed: () => false,
	briefingWindow: () => null,
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-17T10:00:00Z'));
	flightPrep.dossier.flightDate = '2026-04-12';
});

afterEach(() => {
	planScope.flight = null;
	vi.useRealTimers();
});

describe('a plan document’s stamp', () => {
	it('is the flight date where there is a plan', () => {
		planScope.flight = FLIGHT;
		expect(planPrintStem('notam')).toBe('notam_20260412');
	});

	it('is the day it is printed in an app with no plan', () => {
		expect(planPrintStem('notam')).toBe('notam_20261117');
	});
});
