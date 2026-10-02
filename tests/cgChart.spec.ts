/* The CG envelope chart's geometry (src/lib/components/flightprep/cgChart.ts):
 * the scale and the point-label placement. A label used to sit right of its
 * dot whatever the room, so a point near the aft limit at a high mass ran its
 * label off the chart (F-GORQ, 150 kg in front and 105 kg behind). */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAircraftYaml } from '$lib/aircraft/schema';
import { computeMassBalance } from '$lib/aircraft/massBalance';
import { flightprep as en } from '$lib/i18n/en/flightprep';
import { flightprep as fr } from '$lib/i18n/fr/flightprep';
import {
	CG_PAD,
	CG_W,
	cgLabelBox,
	cgLabelWidth,
	cgScale,
	placeCgLabels,
	type CgLabelOut,
} from '../src/lib/components/flightprep/cgChart';

const H = 300;
const box = cgLabelBox(H);

/** The label's horizontal extent at its estimated width. */
function span(out: CgLabelOut, text: string): [number, number] {
	const w = cgLabelWidth(text);
	return out.anchor === 'start' ? [out.x, out.x + w] : [out.x - w, out.x];
}

describe('cgScale', () => {
	const env = [
		{ armM: 0.2, massKg: 500 },
		{ armM: 0.6, massKg: 500 },
		{ armM: 0.6, massKg: 900 },
	];

	it('pads the data 8 % of its span inside the plot', () => {
		const s = cgScale(env, [], H);
		expect(s.innerW).toBe(CG_W - CG_PAD.left - CG_PAD.right);
		expect(s.innerH).toBe(H - CG_PAD.top - CG_PAD.bottom);
		expect(s.x(0.2)).toBeCloseTo(CG_PAD.left + (s.innerW * 0.08) / 1.16, 9);
		expect(s.x(0.6)).toBeCloseTo(CG_PAD.left + (s.innerW * 1.08) / 1.16, 9);
		// Mass grows upward.
		expect(s.y(900)).toBeLessThan(s.y(500));
	});

	it('widens to a point outside the envelope', () => {
		const s = cgScale(env, [{ armM: 0.8, massKg: 950 }], H);
		expect(s.x(0.8)).toBeLessThan(CG_W - CG_PAD.right);
		expect(s.y(950)).toBeGreaterThan(CG_PAD.top);
	});
});

describe('placeCgLabels', () => {
	it('keeps a label with room right of its dot', () => {
		const [out] = placeCgLabels([{ x: 200, y: 100, text: 'Takeoff 850 kg' }], box);
		expect(out).toEqual({ x: 208, y: 104, anchor: 'start' });
	});

	it('flips a label that would run off the right edge', () => {
		const text = 'Atterrissage 1043 kg';
		const [out] = placeCgLabels([{ x: 420, y: 100, text }], box);
		expect(out.anchor).toBe('end');
		expect(out.x).toBe(412);
		const [l, r] = span(out, text);
		expect(l).toBeGreaterThanOrEqual(box.left);
		expect(r).toBeLessThanOrEqual(box.right);
	});

	it('clamps a label that fits neither side whole', () => {
		const narrow = { left: 50, right: 150, top: 12, bottom: 270 };
		const text = 'Atterrissage 1043 kg';
		const [out] = placeCgLabels([{ x: 90, y: 100, text }], narrow);
		const [l, r] = span(out, text);
		// 128 px cannot fit into 100: the roomier side (right, 52 px against
		// 32) takes it, started at the left edge so its beginning reads.
		expect(out.anchor).toBe('start');
		expect(l).toBe(narrow.left);
		expect(r).toBeGreaterThan(narrow.right);
	});

	it('spreads stacked labels at least a line apart, in the dots order', () => {
		const out = placeCgLabels(
			[
				{ x: 200, y: 100, text: 'Zero fuel' },
				{ x: 200, y: 99, text: 'Takeoff 900 kg' },
				{ x: 200, y: 100, text: 'Landing 880 kg' },
			],
			box,
		);
		// The higher dot keeps its line; the two tied ones follow in input order.
		expect(out[1].y).toBe(103);
		expect(out[0].y).toBe(116);
		expect(out[2].y).toBe(129);
	});

	it('keeps a stack near the floor above the arm axis', () => {
		const out = placeCgLabels(
			[
				{ x: 200, y: 265, text: 'Takeoff 900 kg' },
				{ x: 200, y: 266, text: 'Landing 880 kg' },
				{ x: 200, y: 268, text: 'Zero fuel' },
			],
			box,
		);
		const ys = out.map((o) => o.y);
		expect(Math.max(...ys)).toBeLessThanOrEqual(box.bottom - 3);
		const sorted = [...ys].sort((a, b) => a - b);
		for (let i = 1; i < sorted.length; i++) {
			expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(13);
		}
		// The dots' order is kept.
		expect(ys[0]).toBeLessThan(ys[1]);
		expect(ys[1]).toBeLessThan(ys[2]);
	});

	it('keeps a label at the very top inside the plot', () => {
		const [out] = placeCgLabels([{ x: 200, y: box.top - 10, text: 'Takeoff 900 kg' }], box);
		expect(out.y).toBeGreaterThanOrEqual(box.top + 8);
	});
});

describe('the reported case: F-GORQ, front 150 kg, rear 105 kg, full tanks', () => {
	const gorq = parseAircraftYaml(
		readFileSync(new URL('../public/data/aircraft/f-gorq.yaml', import.meta.url), 'utf-8'),
	);
	const mb = gorq.massBalance!;
	const r = computeMassBalance({
		mb,
		stationMassesKg: [150, 105, 0],
		fuelL: 100,
		burnL: 40,
		densityKgPerL: 0.72,
	});

	it('takes off at 897 kg near the aft limit', () => {
		expect(r.takeoff.massKg).toBeCloseTo(897, 9);
		expect(r.takeoff.armM).toBeCloseTo(0.5189, 4);
	});

	for (const [lang, cat] of [
		['en', en],
		['fr', fr],
	] as const) {
		it(`keeps every label inside the chart (${lang})`, () => {
			const points = [
				{ text: cat.pointTakeoff(Math.round(r.takeoff.massKg)), ...r.takeoff },
				{ text: cat.pointLanding(Math.round(r.landing.massKg)), ...r.landing },
				{ text: cat.zeroFuel, ...r.zeroFuel },
			];
			const s = cgScale(mb.envelope, points, H);
			const items = points.map((p) => ({ x: s.x(p.armM), y: s.y(p.massKg), text: p.text }));
			// The old rule (8 px right of the dot) ran the takeoff label off.
			expect(items[0].x + 8 + cgLabelWidth(items[0].text)).toBeGreaterThan(CG_W);
			const out = placeCgLabels(items, box);
			expect(out[0].anchor).toBe('end');
			for (const [i, o] of out.entries()) {
				const [l, rr] = span(o, items[i].text);
				expect(l).toBeGreaterThanOrEqual(box.left);
				expect(rr).toBeLessThanOrEqual(CG_W);
				expect(o.y).toBeGreaterThanOrEqual(box.top + 8);
				expect(o.y).toBeLessThanOrEqual(box.bottom - 3);
			}
		});
	}
});
