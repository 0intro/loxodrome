import { describe, it, expect } from 'vitest';
import {
	fromTriple,
	fromNotamLimit,
	floorMinFt,
	ceilingMaxFt,
	exactFt,
	bandIntersects,
	groundBandAtPoint,
	notamBandFt,
	formatVLimit,
	vExtent,
} from '$lib/vertical/limits';
import type { VerticalLimit, VLimit } from '$lib/vertical/limits';

function t(code: string, val: string, uom: string): VerticalLimit {
	return [code, val, uom];
}

describe('fromTriple', () => {
	it('maps the AIXM datum codes', () => {
		expect(fromTriple(t('ALT', '2500', 'FT'))).toEqual({
			ft: 2500, ref: 'AMSL', value: 2500, unit: 'ft',
		});
		expect(fromTriple(t('HEI', '800', 'FT'))).toEqual({
			ft: 800, ref: 'AGL', value: 800, unit: 'ft',
		});
		expect(fromTriple(t('STD', '085', 'FL'))).toEqual({
			ft: 8500, ref: 'STD', value: 85, unit: 'FL',
		});
	});

	it('keeps an STD-referenced feet value in feet (FAA R-4001B form)', () => {
		expect(fromTriple(t('STD', '10000', 'FT'))).toEqual({
			ft: 10000, ref: 'STD', value: 10000, unit: 'ft',
		});
	});

	it('marks a dropped reference UNKNOWN (ES OTHER:* rows)', () => {
		expect(fromTriple(t('', '12500', 'FT'))).toEqual({
			ft: 12500, ref: 'UNKNOWN', value: 12500, unit: 'ft',
		});
	});

	it('converts metres to feet for comparison, keeps metres for display', () => {
		const l = fromTriple(t('', '11000', 'M'))!;
		expect(l.ft).toBeCloseTo(36089.2, 0);
		expect(l.value).toBe(11000);
		expect(l.unit).toBe('m');
		expect(fromTriple(t('HEI', '300', 'M'))!.ft).toBeCloseTo(984.3, 1);
	});

	it('normalizes the surface forms to the SFC sentinel', () => {
		for (const triple of [t('SFC', '', ''), t('HEI', '0', 'FT'), t('HEI', '', 'FT'), t('HEI', '0', 'M')]) {
			const l = fromTriple(triple)!;
			expect(l.sfc).toBe(true);
			expect(l.ft).toBe(0);
			expect(l.ref).toBe('AGL');
		}
	});

	it('0 ft AMSL is sea level, not the surface', () => {
		const l = fromTriple(t('ALT', '0', 'FT'))!;
		expect(l.sfc).toBeUndefined();
		expect(l.ft).toBe(0);
		expect(l.ref).toBe('AMSL');
	});

	it('parses the explicit UNL triple', () => {
		const l = fromTriple(t('UNL', '', ''))!;
		expect(l.unl).toBe(true);
		expect(l.ft).toBe(Infinity);
	});

	it('normalizes legacy STD 999/9999 FL to UNL only when asked', () => {
		expect(fromTriple(t('STD', '999', 'FL'), { legacyFl999Unl: true })!.unl).toBe(true);
		expect(fromTriple(t('STD', '9999', 'FL'), { legacyFl999Unl: true })!.unl).toBe(true);
		// supaip's fabricated FL660 and any genuine FL stay numeric.
		const kept = fromTriple(t('STD', '999', 'FL'))!;
		expect(kept.unl).toBeUndefined();
		expect(kept.ft).toBe(99900);
		expect(fromTriple(t('STD', '660', 'FL'), { legacyFl999Unl: true })!.ft).toBe(66000);
	});

	it('keeps genuine sub-sea-level AMSL altitudes', () => {
		expect(fromTriple(t('ALT', '-1200', 'FT'))!.ft).toBe(-1200);
	});

	it('returns null for missing or unparseable limits', () => {
		expect(fromTriple(null)).toBeNull();
		expect(fromTriple(undefined)).toBeNull();
		expect(fromTriple(t('ALT', '', 'FT'))).toBeNull();
		expect(fromTriple(t('', '', ''))).toBeNull();
	});
});

describe('fromNotamLimit', () => {
	it('parses the corpus F)/G) forms', () => {
		expect(fromNotamLimit('2500FT AMSL')).toEqual({
			ft: 2500, ref: 'AMSL', value: 2500, unit: 'ft',
		});
		expect(fromNotamLimit('400FT AGL')).toEqual({
			ft: 400, ref: 'AGL', value: 400, unit: 'ft',
		});
		expect(fromNotamLimit('800FT ASFC')).toEqual({
			ft: 800, ref: 'AGL', value: 800, unit: 'ft',
		});
		const m = fromNotamLimit('120M AGL')!;
		expect(m.ref).toBe('AGL');
		expect(m.value).toBe(120);
		expect(m.unit).toBe('m');
		expect(m.ft).toBeCloseTo(393.7, 1);
		expect(fromNotamLimit('600M AMSL')!.ft).toBeCloseTo(1968.5, 1);
		expect(fromNotamLimit('FL095')).toEqual({
			ft: 9500, ref: 'STD', value: 95, unit: 'FL',
		});
		expect(fromNotamLimit('FL 55')!.ft).toBe(5500);
	});

	it('defaults a bare feet value to AMSL (Doc 8126)', () => {
		expect(fromNotamLimit('5000FT')!.ref).toBe('AMSL');
		expect(fromNotamLimit('2500 FT MSL')!.ref).toBe('AMSL');
	});

	it('parses the sentinels', () => {
		expect(fromNotamLimit('SFC')!.sfc).toBe(true);
		expect(fromNotamLimit('GND')!.sfc).toBe(true);
		expect(fromNotamLimit('UNL')!.unl).toBe(true);
		expect(fromNotamLimit('UNLTD')!.unl).toBe(true);
		expect(fromNotamLimit('UNLIMITED')!.unl).toBe(true);
	});

	it('does not read the SFC inside ASFC as a sentinel', () => {
		const l = fromNotamLimit('1500FT ASFC')!;
		expect(l.sfc).toBeUndefined();
		expect(l.ft).toBe(1500);
		expect(l.ref).toBe('AGL');
	});

	it('returns null when no limit grammar matches', () => {
		expect(fromNotamLimit('')).toBeNull();
		expect(fromNotamLimit(null)).toBeNull();
		expect(fromNotamLimit('SEE E) TEXT')).toBeNull();
	});
});

describe('conservative endpoints', () => {
	const aglFloor = fromTriple(t('HEI', '800', 'FT'))!;
	const aglCeil = fromTriple(t('HEI', '2500', 'FT'))!;
	const amsl = fromTriple(t('ALT', '3000', 'FT'))!;
	const fl = fromTriple(t('STD', '195', 'FL'))!;
	const sfc = fromTriple(t('SFC', '', ''))!;
	const unl = fromTriple(t('UNL', '', ''))!;

	it('floorMinFt: AGL floors sit at their height without ground, height + ground with it', () => {
		expect(floorMinFt(aglFloor)).toBe(800);
		expect(floorMinFt(aglFloor, 2500)).toBe(3300);
		expect(floorMinFt(sfc)).toBe(0);
		expect(floorMinFt(sfc, 2500)).toBe(2500);
		expect(floorMinFt(amsl)).toBe(3000);
		expect(floorMinFt(fl)).toBe(19500);
	});

	it('ceilingMaxFt: AGL ceilings are unbounded without ground', () => {
		expect(ceilingMaxFt(aglCeil)).toBe(Infinity);
		expect(ceilingMaxFt(aglCeil, 2500)).toBe(5000);
		expect(ceilingMaxFt(unl)).toBe(Infinity);
		expect(ceilingMaxFt(unl, 100)).toBe(Infinity);
		expect(ceilingMaxFt(amsl)).toBe(3000);
	});

	it('exactFt: null for AGL over unknown ground, resolved otherwise', () => {
		expect(exactFt(aglCeil, null)).toBeNull();
		expect(exactFt(aglCeil, 2500)).toBe(5000);
		expect(exactFt(amsl, null)).toBe(3000);
		expect(exactFt(unl, null)).toBe(Infinity);
	});
});

describe('GroundBand', () => {
	it('reads the floor off the low ground and the ceiling off the high', () => {
		// A zone 500 ft ASFC to 1500 ft ASFC over a corridor whose ground runs
		// 1000..3000 ft: it can reach from 1500 ft up to 4500 ft, and BOTH
		// ends have to come from their own side of the ground.
		const asfcLow = fromTriple(t('HEI', '500', 'FT'))!;
		const asfcHigh = fromTriple(t('HEI', '1500', 'FT'))!;
		const ground = { minFt: 1000, maxFt: 3000 };
		expect(floorMinFt(asfcLow, ground.minFt)).toBe(1500);
		expect(ceilingMaxFt(asfcHigh, ground.maxFt)).toBe(4500);
		// Flying at 2000 ft is inside it, which one scalar could hide: the
		// high ground alone would put the floor at 3500 ft.
		expect(bandIntersects(asfcLow, asfcHigh, { floor: 2000, ceiling: 2000 }, ground)).toBe(true);
		expect(
			bandIntersects(asfcLow, asfcHigh, { floor: 2000, ceiling: 2000 }, groundBandAtPoint(3000)),
		).toBe(false);
	});

	it('makes both ends of a point query the same reading', () => {
		expect(groundBandAtPoint(1200)).toEqual({ minFt: 1200, maxFt: 1200 });
		expect(groundBandAtPoint(null)).toEqual({ minFt: null, maxFt: null });
		expect(groundBandAtPoint(undefined)).toEqual({ minFt: null, maxFt: null });
	});
});

describe('bandIntersects', () => {
	const sfc = fromTriple(t('SFC', '', ''))!;
	const asfc2500 = fromTriple(t('HEI', '2500', 'FT'))!;

	it('never hides an AGL-ceiling zone on a raised floor without terrain (LFR108B)', () => {
		// SFC - 2500 ft ASFC vs filter 4000..60000: the true top over
		// 2500 ft terrain is 5000 ft AMSL, so the zone must stay.
		expect(bandIntersects(sfc, asfc2500, { floor: 4000, ceiling: 60000 })).toBe(true);
	});

	it('resolves exactly when the ground is known', () => {
		expect(bandIntersects(sfc, asfc2500, { floor: 4000, ceiling: 60000 }, groundBandAtPoint(2500))).toBe(true);
		expect(bandIntersects(sfc, asfc2500, { floor: 4000, ceiling: 60000 }, groundBandAtPoint(0))).toBe(false);
	});

	it('treats missing sides as unbounded', () => {
		const amsl = fromTriple(t('ALT', '3000', 'FT'))!;
		expect(bandIntersects(null, amsl, { floor: 0, ceiling: 1000 })).toBe(true);
		expect(bandIntersects(amsl, null, { floor: 10000, ceiling: 20000 })).toBe(true);
		expect(bandIntersects(null, null, { floor: 0, ceiling: 0 })).toBe(true);
		expect(bandIntersects(amsl, null, { floor: 0, ceiling: 2999 })).toBe(false);
	});
});

describe('notamBandFt', () => {
	it('prefers F)/G) over the Q-line band (OPADD)', () => {
		// LFFA-W1334/25: F) 1500FT AGL / G) 4000FT AMSL, Q 015/040.
		const band = notamBandFt(
			fromNotamLimit('1500FT AGL'),
			fromNotamLimit('4000FT AMSL'),
			{ lower: 15, upper: 40 },
		)!;
		expect(band.floor).toBe(1500);
		expect(band.ceiling).toBe(4000);
	});

	it('treats a lone parsed side as half-bounded', () => {
		const band = notamBandFt(null, fromNotamLimit('120M AGL'), { lower: 0, upper: 8 })!;
		expect(band.floor).toBe(-Infinity);
		// AGL ceiling without terrain stays unbounded (conservative).
		expect(band.ceiling).toBe(Infinity);
	});

	it('falls back to the Q-line band with its 999 convention', () => {
		expect(notamBandFt(null, null, { lower: 0, upper: 95 })).toEqual({
			floor: 0, ceiling: 9500,
		});
		expect(notamBandFt(null, null, { lower: 0, upper: 999 })).toEqual({
			floor: 0, ceiling: Infinity,
		});
		expect(notamBandFt(null, null, { lower: 195, upper: 999 })).toEqual({
			floor: 19500, ceiling: Infinity,
		});
		// 999 is "unlimited or unknown" on the LOWER side too: a 999/999
		// Q-line must stay unbounded for matching, not floor at 99 900 ft
		// (which would hide the NOTAM from any low altitude filter).
		expect(notamBandFt(null, null, { lower: 999, upper: 999 })).toEqual({
			floor: -Infinity, ceiling: Infinity,
		});
	});

	it('returns null with no vertical statement at all', () => {
		expect(notamBandFt(null, null, null)).toBeNull();
		expect(notamBandFt(null, null, { lower: NaN, upper: 999 })).toBeNull();
	});
});

describe('formatVLimit', () => {
	const f = (l: VLimit | null) => formatVLimit(l);

	it('renders the SIA vocabulary', () => {
		expect(f(fromTriple(t('ALT', '2500', 'FT')))).toBe('2500 ft AMSL');
		expect(f(fromTriple(t('HEI', '800', 'FT')))).toBe('800 ft ASFC');
		expect(f(fromTriple(t('STD', '085', 'FL')))).toBe('FL 085');
		expect(f(fromTriple(t('SFC', '', '')))).toBe('SFC');
		expect(f(fromTriple(t('HEI', '0', 'FT')))).toBe('SFC');
		expect(f(fromTriple(t('UNL', '', '')))).toBe('UNL');
		expect(f(fromTriple(t('STD', '999', 'FL'), { legacyFl999Unl: true }))).toBe('UNL');
	});

	it('renders unknown references bare and keeps metres', () => {
		expect(f(fromTriple(t('', '12500', 'FT')))).toBe('12500 ft');
		expect(f(fromTriple(t('', '11000', 'M')))).toBe('11000 m');
		expect(f(fromTriple(t('HEI', '120', 'M')))).toBe('120 m ASFC');
		expect(f(fromTriple(t('STD', '10000', 'FT')))).toBe('10000 ft');
	});

	it('renders NOTAM-derived limits identically', () => {
		expect(f(fromNotamLimit('1650FT AMSL'))).toBe('1650 ft AMSL');
		expect(f(fromNotamLimit('FL095'))).toBe('FL 095');
		expect(f(fromNotamLimit('GND'))).toBe('SFC');
	});

	it('returns the empty string for a missing limit', () => {
		expect(f(null)).toBe('');
	});
});

describe('vExtent', () => {
	// Three states, not two: a volume with a floor and no ceiling is a
	// different statement from one with neither, and the app used to
	// disagree with itself about which was which.
	it('separates a fully stated extent from a half and a missing one', () => {
		const ft = (n: number): VLimit => ({ ft: n, ref: 'AMSL', value: n, unit: 'ft' });
		expect(vExtent(ft(1000), ft(3000))).toBe('known');
		expect(vExtent(ft(1000), null)).toBe('open');
		expect(vExtent(null, ft(3000))).toBe('open');
		expect(vExtent(null, null)).toBe('unknown');
	});
});
