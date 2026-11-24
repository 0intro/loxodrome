/* The SUP AIP list the verdict reads a briefing's French trigger NOTAMs
 * against loads with the briefing (state/briefing.svelte.ts
 * ensureSupaipForTriggers, run from BriefingHost's effect): its layer is off
 * by default, and an activation in the period was the one part of a
 * briefing that asked for it. Its sidecar's date comes with it. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failAlways, serve, serveCoverageSite, untilReal } from './helpers/coverageSite';

const BUILT = '2026-11-19T10:50:31.632Z';
const notam = (id: string, q: string, e: string) =>
	[`${id} NOTAMN`, `Q) LFFF/${q}/IV/BO/W/000/065/4838N00150E010`, 'A) LFFF B) 2611200000 C) 2612312359', `E) ${e}`].join('\n');
const PJE = notam('W0001/26', 'QWPLW', 'PJE WI 3NM ETAMPES.');
const TRIGGER = notam('R1234/26', 'QRTTT', 'TRIGGER NOTAM - AIP SUP 247/26 ZRT TEST.');

beforeEach(() => {
	vi.resetModules();
	serveCoverageSite();
	serve('/data/fr-supaip.meta.json', { generatedAt: BUILT });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the SUP AIP list behind the verdict', () => {
	it('loads once the briefing holds a French trigger NOTAM, with its date', async () => {
		const { flushSync } = await import('svelte');
		const data = await import('$lib/state/data.svelte');
		const state = await import('$lib/state/notam.svelte');
		const brief = await import('$lib/state/briefing.svelte');
		const host = await import('./helpers/derivedHost.svelte');
		const effect = host.mountEffect(() => brief.ensureSupaipForTriggers());
		state.commitBriefing(PJE, { source: 'sofia', kind: 'route', briefed: null });
		flushSync();
		expect(data.dataState.supaipLoading || data.dataState.supaipLoaded).toBe(false);
		state.commitBriefing(TRIGGER, { source: 'sofia', kind: 'route', briefed: null });
		flushSync();
		await untilReal(() => data.frSupaipList() !== null);
		expect(data.frSupaipList()).toEqual({ at: Date.parse(BUILT) });
		effect.stop();
	});

	it('judges the briefing against the list when its date fails to load', async () => {
		failAlways('/data/fr-supaip.meta.json', 500);
		const { flushSync } = await import('svelte');
		const data = await import('$lib/state/data.svelte');
		const state = await import('$lib/state/notam.svelte');
		const brief = await import('$lib/state/briefing.svelte');
		const { routes } = await import('$lib/state/route.svelte');
		const host = await import('./helpers/derivedHost.svelte');
		// A route for the verdict to judge: Toussus to Orléans, no time stated.
		const wp = (id: string, lat: number, lon: number) => ({ id, lat, lon, kind: 'free', alt: 2500, altAuto: true });
		routes.list = [
			{
				id: 'r1',
				name: null,
				waypoints: [wp('a', 48.75194, 2.10611), wp('b', 47.89694, 2.16333)],
				selectedWaypointId: null,
			} as unknown as (typeof routes.list)[number],
		];
		const effect = host.mountEffect(() => brief.ensureSupaipForTriggers());
		state.commitBriefing(TRIGGER, { source: 'sofia', kind: 'route', briefed: null });
		flushSync();
		await untilReal(() => data.frSupaipList() !== null);
		expect(data.frSupaipList()).toEqual({ at: null });
		const supaip = brief.briefingVerdictNow().reasons.find((r) => r.code === 'supaip');
		expect(supaip).toEqual({ code: 'supaip', listAt: null, sups: [{ ref: 'AIP SUP 247/26', notam: 'R1234/26' }] });
		effect.stop();
	});
});
