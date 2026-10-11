import { describe, it, expect } from 'vitest';
import {
	legMidpoints,
	legSegments,
	planForecastFacts,
	windDirText,
	windEditOutcome,
	type LegForecast,
} from '$lib/route/legWind';
import type { Waypoint } from '$lib/state/route.svelte';

const wp = (id: string, lat: number, lon: number) => ({ id, lat, lon }) as Waypoint;

describe('legMidpoints and legSegments across the antimeridian', () => {
	const wps = [wp('a', 0, 179.5), wp('b', 0, -179.5)];

	it('midpoint sits on the dateline, not at 0 longitude', () => {
		const [mid] = legMidpoints(wps);
		expect(Math.abs(Math.abs(mid.lon) - 180)).toBeLessThan(1e-9);
	});

	it('the center segment lands on the legMidpoints point', () => {
		const segs = legSegments(wps);
		const [mid] = legMidpoints(wps);
		const center = segs[Math.floor(segs.length / 2)];
		expect(center.lat).toBe(mid.lat);
		expect(center.lon).toBe(mid.lon);
		for (const s of segs) {
			expect(Math.abs(s.lon)).toBeGreaterThan(179.4);
		}
	});

	it('in-range legs keep the exact arithmetic mean', () => {
		const [mid] = legMidpoints([wp('a', 48.1, 2.5678), wp('b', 48.9, 3.4321)]);
		expect(mid.lon).toBe((2.5678 + 3.4321) / 2);
	});
});

/* The W/V editor's boxes follow the placeholder rule: empty, they show the
 * automatic wind in grey, and only what the pilot types is an override. So
 * opening the editor and leaving changes nothing, a typed pair equal to the
 * automatic wind is automatic, and one box typed alone writes nothing (a live
 * forecast must never freeze into the plan). */
describe('windEditOutcome', () => {
	const auto = { dirDeg: 270, speedKt: 15 };
	const override = { dirDeg: 300, speedKt: 20 };

	it('leaves a leg alone when both boxes are left empty', () => {
		expect(windEditOutcome('', '', auto, null)).toEqual({ kind: 'keep' });
		expect(windEditOutcome('  ', '', null, null)).toEqual({ kind: 'keep' });
	});

	it('hands an overridden leg back when both boxes are emptied', () => {
		expect(windEditOutcome('', '', auto, override)).toEqual({ kind: 'clear' });
	});

	it('writes nothing for one box typed alone', () => {
		expect(windEditOutcome('300', '', auto, null)).toEqual({ kind: 'incomplete' });
		expect(windEditOutcome('', '20', auto, override)).toEqual({ kind: 'incomplete' });
	});

	it('treats the automatic wind typed in full as automatic', () => {
		expect(windEditOutcome('270', '15', auto, null)).toEqual({ kind: 'keep' });
		expect(windEditOutcome('270', '15', auto, override)).toEqual({ kind: 'clear' });
		// North compares mod 360, the speed as shown (rounded).
		expect(windEditOutcome('360', '14.6', { dirDeg: 0, speedKt: 15 }, null)).toEqual({ kind: 'keep' });
	});

	it('records no step for an override left as it was', () => {
		expect(windEditOutcome('300', '20', auto, override)).toEqual({ kind: 'keep' });
	});

	it('sets a new override, the direction whole degrees 0..359', () => {
		expect(windEditOutcome('280', '18', auto, null)).toEqual({ kind: 'set', dirDeg: 280, speedKt: 18 });
		expect(windEditOutcome('360', '10', null, null)).toEqual({ kind: 'set', dirDeg: 0, speedKt: 10 });
		expect(windEditOutcome('-90', '10.4', null, override)).toEqual({ kind: 'set', dirDeg: 270, speedKt: 10 });
	});

	it('ignores what cannot be a wind', () => {
		expect(windEditOutcome('abc', '10', auto, null)).toEqual({ kind: 'keep' });
		expect(windEditOutcome('270', '-5', auto, override)).toEqual({ kind: 'keep' });
	});
});

describe('windDirText', () => {
	it('reads as the chip does: three digits, north 360', () => {
		expect(windDirText(0)).toBe('360');
		expect(windDirText(360)).toBe('360');
		expect(windDirText(79)).toBe('079');
		expect(windDirText(279.6)).toBe('280');
		expect(windDirText(-10)).toBe('350');
	});
});

/* What the Overview states beyond the mean wind: the levels behind it, the
 * ISA deviation over the plan and the lowest freezing level over its legs,
 * each at its leg's own altitude and time. */
describe('planForecastFacts', () => {
	const leg = (
		altitudeFt: number,
		o: { isaDevC?: number | null; fzl?: number | null; atOrBelow?: boolean } = {},
	): LegForecast => ({
		ok: true,
		wind: {
			dirTrueDeg: 250,
			speedKt: 20,
			tempC: 5,
			isaDevC: o.isaDevC === undefined ? 2 : o.isaDevC,
			belowGround: false,
			aboveTop: false,
			validTimeMs: 0,
			altitudeFt,
			freezingLevelFt: o.fzl ?? null,
			freezingAtOrBelow: o.atOrBelow ?? false,
			shearKtPer1000Ft: null,
		},
	});

	it('states one level when every leg flies it, else the range', () => {
		expect(planForecastFacts([leg(3500), leg(3500)], [10, 20])?.levels).toEqual({ lowFt: 3500, highFt: 3500 });
		expect(planForecastFacts([leg(2500), leg(6500), leg(4500)], [10, 20, 5])?.levels).toEqual({
			lowFt: 2500,
			highFt: 6500,
		});
	});

	it('leaves a zero-length leg out, as the mean does', () => {
		const f = planForecastFacts([leg(9500, { isaDevC: 30, fzl: 100 }), leg(3500)], [0, 20]);
		expect(f?.levels).toEqual({ lowFt: 3500, highFt: 3500 });
		expect(f?.isaDevC).toBe(2);
		expect(f?.freezing).toBeNull();
	});

	it('weighs the ISA deviation by leg length, over the legs that have one', () => {
		expect(planForecastFacts([leg(3500, { isaDevC: 2 }), leg(3500, { isaDevC: 6 })], [10, 30])?.isaDevC).toBe(5);
		// A leg above the ladder has no deviation; it still counts for the levels.
		const f = planForecastFacts([leg(3500, { isaDevC: 4 }), leg(19500, { isaDevC: null })], [10, 30]);
		expect(f?.isaDevC).toBe(4);
		expect(f?.levels.highFt).toBe(19500);
		expect(planForecastFacts([leg(19500, { isaDevC: null })], [10])?.isaDevC).toBeNull();
	});

	it('takes the lowest freezing level, rounded down to 100 ft', () => {
		const f = planForecastFacts([leg(3500, { fzl: 6123 }), leg(3500, { fzl: 4891 }), leg(3500)], [10, 10, 10]);
		expect(f?.freezing).toEqual({ lowestFt: 4800, atOrBelow: false, reached: false });
		// None under the ladder top: no freezing level to state.
		expect(planForecastFacts([leg(3500), leg(4500)], [10, 10])?.freezing).toBeNull();
	});

	it('says whether a leg flies at or above its own freezing level', () => {
		// The second leg flies above its freezing level, the lowest is
		// another leg's: reached all the same.
		const f = planForecastFacts([leg(3500, { fzl: 4000 }), leg(7500, { fzl: 7000 })], [10, 10]);
		expect(f?.freezing).toEqual({ lowestFt: 4000, atOrBelow: false, reached: true });
		// A level at or below the lowest temperature is reached wherever the
		// leg flies.
		const g = planForecastFacts([leg(2500, { fzl: 2625, atOrBelow: true })], [10]);
		expect(g?.freezing).toEqual({ lowestFt: 2600, atOrBelow: true, reached: true });
	});

	it('states nothing unless every leg has a forecast', () => {
		const failed: LegForecast = { ok: false, reason: 'beyond-horizon', validTimeMs: 0, altitudeFt: 3500 };
		expect(planForecastFacts([leg(3500), failed], [10, 10])).toBeNull();
		expect(planForecastFacts([leg(3500)], [10, 10])).toBeNull();
		expect(planForecastFacts([leg(3500)], [0])).toBeNull();
		expect(planForecastFacts(null, [])).toBeNull();
	});
});
