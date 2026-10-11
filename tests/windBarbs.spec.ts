import { describe, expect, it } from 'vitest';
import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';
import { barbTipLines, gustLabel, placedBarb, svgWindBarb, windBarbElements } from '$lib/weather/windBarbs';
import { isolines, type IsoGrid } from '$lib/weather/isotherm';

describe('windBarbElements', () => {
	it('decomposes per the station model, rounding to the nearest 5 kt', () => {
		expect(windBarbElements(0)).toEqual({ calm: true, pennants: 0, full: 0, half: 0 });
		expect(windBarbElements(2)).toEqual({ calm: true, pennants: 0, full: 0, half: 0 });
		expect(windBarbElements(3)).toEqual({ calm: false, pennants: 0, full: 0, half: 1 });
		expect(windBarbElements(7)).toEqual({ calm: false, pennants: 0, full: 0, half: 1 });
		expect(windBarbElements(10)).toEqual({ calm: false, pennants: 0, full: 1, half: 0 });
		expect(windBarbElements(15)).toEqual({ calm: false, pennants: 0, full: 1, half: 1 });
		expect(windBarbElements(25)).toEqual({ calm: false, pennants: 0, full: 2, half: 1 });
		expect(windBarbElements(48)).toEqual({ calm: false, pennants: 1, full: 0, half: 0 });
		expect(windBarbElements(52)).toEqual({ calm: false, pennants: 1, full: 0, half: 0 });
		expect(windBarbElements(65)).toEqual({ calm: false, pennants: 1, full: 1, half: 1 });
		expect(windBarbElements(103)).toEqual({ calm: false, pennants: 2, full: 0, half: 1 });
	});
});

describe('placedBarb', () => {
	it('points the staff toward the wind source', () => {
		const north = placedBarb(0, 0, 0, 10, 40);
		expect(north.staff![0]).toEqual([0, 0]);
		expect(north.staff![1][0]).toBeCloseTo(0, 6);
		expect(north.staff![1][1]).toBeCloseTo(-40, 6);
		const west = placedBarb(0, 0, 270, 10, 40);
		expect(west.staff![1][0]).toBeCloseTo(-40, 6);
		expect(west.staff![1][1]).toBeCloseTo(0, 6);
	});

	it('puts feathers on the clockwise side of the staff (NH: toward low pressure)', () => {
		// Wind from the north: feathers extend east (+x).
		const north = placedBarb(0, 0, 0, 10, 40);
		expect(north.feathers[0][1][0]).toBeGreaterThan(5);
		// Wind from the west: feathers extend poleward (-y on screen).
		const west = placedBarb(0, 0, 270, 10, 40);
		expect(west.feathers[0][1][1]).toBeLessThan(-5);
	});

	it('rakes feathers outward past the tip', () => {
		const north = placedBarb(0, 0, 0, 10, 40);
		expect(north.feathers[0][0][1]).toBeCloseTo(-40, 6);
		expect(north.feathers[0][1][1]).toBeLessThan(-40);
	});

	it('insets a lone half barb from the tip', () => {
		const b = placedBarb(0, 0, 0, 5, 40);
		expect(b.feathers).toHaveLength(1);
		expect(b.feathers[0][0][1]).toBeCloseTo(-40 + 0.122 * 40, 6);
	});

	it('matches the measured NWS reference ratios', () => {
		// weather.gov/hfo/windbarbinfo tiles: elements 0.122 of the staff
		// apart; full barb reaches 0.375 out and 0.11 past its root.
		const b = placedBarb(0, 0, 0, 25, 40);
		expect(b.feathers).toHaveLength(3);
		expect(b.feathers[1][0][1] - b.feathers[0][0][1]).toBeCloseTo(0.122 * 40, 6);
		expect(b.feathers[2][0][1] - b.feathers[1][0][1]).toBeCloseTo(0.122 * 40, 6);
		expect(b.feathers[0][1][0]).toBeCloseTo(0.375 * 40, 6);
		expect(b.feathers[0][1][1]).toBeCloseTo(-40 - 0.11 * 40, 6);
	});

	it('draws pennants at the tip and a calm circle without a staff', () => {
		const p = placedBarb(0, 0, 0, 50, 40);
		expect(p.pennants).toHaveLength(1);
		// The measured pennant: base 0.23 along the staff from the tip,
		// apex 0.43 out and leaned 0.10 back from the leading edge.
		expect(p.pennants[0][0][1]).toBeCloseTo(-40, 6);
		expect(p.pennants[0][1]).toEqual([0.43 * 40, -40 + 0.1 * 40]);
		expect(p.pennants[0][2][1]).toBeCloseTo(-40 + 0.23 * 40, 6);
		const calm = placedBarb(0, 0, 0, 1, 40);
		expect(calm.staff).toBeNull();
		expect(calm.calmR).toBeCloseTo(8, 6);
	});
});

describe('svgWindBarb', () => {
	it('emits the same geometry as a path', () => {
		const svg = svgWindBarb(0, 0, 0, 10, 40);
		expect(svg.pathD.startsWith('M0 0L0 -40')).toBe(true);
		expect(svg.calmR).toBeNull();
		const pennant = svgWindBarb(0, 0, 0, 50, 40);
		expect(pennant.pathD).toContain('Z');
		const calm = svgWindBarb(0, 0, 0, 0, 40);
		expect(calm.pathD).toBe('');
		expect(calm.calmR).toBeCloseTo(8, 6);
	});
});

describe('gustLabel', () => {
	it('labels gusts 10 kt or more over the mean', () => {
		expect(gustLabel(10, null)).toBeNull();
		expect(gustLabel(10, 19)).toBeNull();
		expect(gustLabel(10, 20)).toBe('G20');
		expect(gustLabel(10, 20.4)).toBe('G20');
	});
});

describe('barbTipLines', () => {
	it('reads direction, speed in kt and km/h, and the ISA line', () => {
		expect(barbTipLines({ dirTrueDeg: 340, speedKt: 9, tempC: 24, isaDevC: 12.3 }, en.weather.barb)).toEqual([
			'340° true',
			'9 kt (17 km/h)',
			'24 °C (ISA +12)',
		]);
		expect(barbTipLines({ dirTrueDeg: 0, speedKt: 20, tempC: -3.4, isaDevC: -5.6 }, en.weather.barb)).toEqual([
			'360° true',
			'20 kt (37 km/h)',
			'-3 °C (ISA -6)',
		]);
	});

	it('omits the ISA line without a temperature and reads a calm plot as Calm', () => {
		expect(barbTipLines({ dirTrueDeg: 120, speedKt: 8, tempC: null, isaDevC: null }, en.weather.barb)).toEqual([
			'120° true',
			'8 kt (15 km/h)',
		]);
		expect(barbTipLines({ dirTrueDeg: 200, speedKt: 1, tempC: null, isaDevC: null }, en.weather.barb)).toEqual([
			'Calm',
			'1 kt (2 km/h)',
		]);
	});

	it('flags the 10 m fallback on faded barbs', () => {
		expect(
			barbTipLines({ dirTrueDeg: 90, speedKt: 5, tempC: null, isaDevC: null, faded: true }, en.weather.barb),
		).toContain('10 m wind (level below terrain)');
		expect(
			barbTipLines({ dirTrueDeg: 90, speedKt: 5, tempC: null, isaDevC: null, faded: true }, fr.weather.barb),
		).toContain('vent à 10 m (niveau sous le relief)');
	});

	it('flags the above-ladder clamp, winning over the faded note', () => {
		// An above-ladder barb also draws faded; the badge states the clamp,
		// not the 10 m fallback (the two conditions are mutually exclusive
		// at the sampler).
		const tip = barbTipLines(
			{ dirTrueDeg: 90, speedKt: 5, tempC: null, isaDevC: null, faded: true, aboveTop: true },
			en.weather.barb,
		);
		expect(tip).toContain('above the forecast ladder, topmost-level wind shown');
		expect(tip).not.toContain('10 m wind (level below terrain)');
		expect(
			barbTipLines(
				{ dirTrueDeg: 90, speedKt: 5, tempC: null, isaDevC: null, faded: true, aboveTop: true },
				fr.weather.barb,
			),
		).toContain('au-dessus du plafond de la prévision, vent du niveau le plus haut affiché');
	});
});

describe('isolines', () => {
	it('traces a straight isotherm across a gradient field', () => {
		const grid: IsoGrid = {
			xs: [0, 1, 2],
			ys: [0, 1, 2, 3, 4],
			values: [0, 1, 2, 3, 4].map((j) => [j - 2.5, j - 2.5, j - 2.5]),
		};
		const lines = isolines(grid, 0);
		expect(lines).toHaveLength(1);
		for (const [, y] of lines[0]) {
			expect(y).toBeCloseTo(2.5, 6);
		}
		const xsSeen = lines[0].map(([x]) => x);
		expect(Math.min(...xsSeen)).toBe(0);
		expect(Math.max(...xsSeen)).toBe(2);
	});

	it('chains shared endpoints into one polyline', () => {
		const grid: IsoGrid = {
			xs: [0, 1, 2],
			ys: [0, 1],
			values: [
				[-1, -1, -1],
				[1, 1, 1],
			],
		};
		const lines = isolines(grid, 0);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toHaveLength(3);
	});

	it('draws nothing without a crossing and mutes null cells', () => {
		const flat: IsoGrid = { xs: [0, 1], ys: [0, 1], values: [[1, 1], [1, 1]] };
		expect(isolines(flat, 0)).toHaveLength(0);
		const holed: IsoGrid = {
			xs: [0, 1, 2, 3],
			ys: [0, 1],
			values: [
				[-1, -1, -1, -1],
				[1, 1, null, 1],
			],
		};
		const lines = isolines(holed, 0);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toHaveLength(2);
		for (const [, y] of lines[0]) {
			expect(y).toBeCloseTo(0.5, 6);
		}
	});

	it('resolves saddles deterministically', () => {
		const saddle: IsoGrid = {
			xs: [0, 1],
			ys: [0, 1],
			values: [
				[1, -1],
				[-1, 1],
			],
		};
		expect(isolines(saddle, 0)).toHaveLength(2);
	});
});
