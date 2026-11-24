/* The SUP AIP list against the briefing (notam/briefingVerdict.ts
 * supsMissing and the supaip reason). A French trigger NOTAM announces an
 * AIP SUP in force, so a list built before it lacks the zones the briefing
 * activates, and the APK carries the list it was built with. Over the 116
 * French trigger NOTAMs of the June 2026 corpus: a list holding every
 * supplement they cite raises nothing, and one lacking a supplement names
 * it with the first trigger citing it. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNotams } from '$lib/notam';
import { extractAipSupsFor, notamSupPublisher } from '$lib/notam/aipSup';
import { fetchCures } from '$lib/notam/briefingRefresh';
import { briefingVerdict, supsMissing, type VerdictInput } from '$lib/notam/briefingVerdict';
import { isTriggerNotam } from '$lib/notam/relations';

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 24, 15, 0);

const corpus = parseNotams(readFileSync(new URL('./fixtures/world-en-20260610.txt', import.meta.url), 'utf8'));
const french = corpus.filter((n) => notamSupPublisher(n) === 'fr');
const triggers = new Set(french.filter(isTriggerNotam).map((n) => n.id));
const citedBy = (n: (typeof corpus)[number]) =>
	extractAipSupsFor(n.fullContent, 'fr')
		.filter((r) => r.series === 'A')
		.map((r) => `${r.year}/${r.number}`);
const cited = new Set(french.filter(isTriggerNotam).flatMap(citedBy));

/** The list, lacking `lacks` ('2025/143'). */
const listing =
	(lacks: string[] = []) =>
	(number: number, year: number): boolean =>
		!lacks.includes(`${year}/${number}`);

describe('the trigger NOTAMs against the SUP AIP list', () => {
	it('reads the corpus’s French triggers and the supplements they cite', () => {
		expect(triggers.size).toBe(116);
		expect(cited.size).toBe(81);
	});

	it('raises nothing against a list holding every supplement they cite', () => {
		expect(supsMissing(corpus, listing())).toEqual([]);
	});

	it('names a supplement the list lacks, once, with the first trigger citing it', () => {
		expect(supsMissing(corpus, listing(['2025/143']))).toEqual([{ ref: 'AIP SUP 143/25', notam: 'A2671/26' }]);
	});

	it('reads the triggers alone, each supplement once', () => {
		const missing = supsMissing(corpus, () => false);
		expect(missing).toHaveLength(cited.size);
		expect(missing.every((m) => triggers.has(m.notam))).toBe(true);
		// An activation cites its supplement too, and raises nothing.
		const activations = french.filter((n) => !isTriggerNotam(n) && citedBy(n).some((k) => !cited.has(k)));
		expect(activations.length).toBeGreaterThan(0);
	});
});

describe('the reason', () => {
	const base: VerdictInput = {
		nowMs: NOW,
		loaded: true,
		fetch: { at: NOW - H, briefed: { from: NOW - H, to: NOW + 23 * H }, asked: null },
		byHand: null,
		gaps: null,
		rtbaDays: new Set(),
		plan: { tracks: [{ label: 'LFPN-LFOZ', path: [{ lat: 48.75, lon: 2.1 }, { lat: 47.9, lon: 2.16 }] }], halfWidthNM: 5 },
		span: { from: NOW + H, to: NOW + 3 * H },
		onGround: true,
		crossesRtba: false,
	};
	const supaip = { listAt: Date.UTC(2026, 9, 29, 10), missing: [{ ref: 'AIP SUP 247/26', notam: 'R1234/26' }] };

	it('comes last, and only with a supplement missing from a list read', () => {
		expect(briefingVerdict({ ...base, supaip }).reasons).toEqual([
			{ code: 'supaip', listAt: supaip.listAt, sups: supaip.missing },
		]);
		expect(briefingVerdict({ ...base, nowMs: NOW + 4 * H, supaip }).reasons.map((r) => r.code)).toEqual([
			'age',
			'supaip',
		]);
		expect(briefingVerdict({ ...base, supaip: { ...supaip, missing: [] } }).reasons).toEqual([]);
		expect(briefingVerdict({ ...base, supaip: null }).reasons).toEqual([]);
	});

	it('is no fetch’s to cure', () => {
		expect(fetchCures(briefingVerdict({ ...base, supaip }).reasons, NOW)).toBe(false);
	});
});
