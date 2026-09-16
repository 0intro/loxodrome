/* What is on the way in and what is on the way out. */

import { describe, expect, it } from 'vitest';

import { mergeFades, stepFades, type FadeEntry } from '$lib/map/panelFade';

type Draw = { canvas: unknown; tag: string };
const draw = (tag: string, canvas: unknown = {}): Draw => ({ canvas, tag });
const want = (tag: string, canvas: unknown = {}) => ({ key: tag, item: draw(tag, canvas) });
const shown = (es: FadeEntry<Draw>[]) => es.map((e) => `${e.key}@${e.alpha.toFixed(2)}`);

describe('mergeFades', () => {
	it('starts an arriving panel at nothing and aims it at full', () => {
		const out = mergeFades<Draw>([], [want('a'), want('b')]);
		expect(shown(out)).toEqual(['a@0.00', 'b@0.00']);
		expect(out.every((e) => e.target === 1)).toBe(true);
	});

	it('does not start a panel that has no bitmap yet', () => {
		// Absent, not arriving: its alpha rises the moment there is
		// something to show, so a panel does not fade in over nothing.
		const out = mergeFades<Draw>([], [want('a', null)]);
		expect(out[0].target).toBe(0);
	});

	it('keeps a departing panel at its place in the stack', () => {
		// It is on its way out; sliding under its neighbours on the way
		// would be a glitch of its own.
		const current: FadeEntry<Draw>[] = [
			{ key: 'a', item: draw('a'), alpha: 1, target: 1 },
			{ key: 'gone', item: draw('gone'), alpha: 1, target: 1 },
			{ key: 'b', item: draw('b'), alpha: 1, target: 1 },
		];
		const out = mergeFades(current, [want('a'), want('b')]);
		expect(out.map((e) => e.key)).toEqual(['a', 'gone', 'b']);
		expect(out[1].target).toBe(0);
		expect(out[1].alpha).toBe(1);
	});

	it('swaps outright when motion is not wanted', () => {
		const current: FadeEntry<Draw>[] = [{ key: 'gone', item: draw('gone'), alpha: 1, target: 1 }];
		const out = mergeFades(current, [want('a')], true);
		expect(shown(out)).toEqual(['a@1.00']);
	});
});

describe('stepFades', () => {
	it('reaches full in the stated time and then stops moving', () => {
		const es = mergeFades<Draw>([], [want('a')]);
		let r = stepFades(es, 90, 180);
		expect(r.entries[0].alpha).toBeCloseTo(0.5, 6);
		expect(r.moving).toBe(true);
		r = stepFades(r.entries, 90, 180);
		expect(r.entries[0].alpha).toBe(1);
		expect(r.moving).toBe(false);
	});

	it('drops a panel once it has finished leaving', () => {
		const es: FadeEntry<Draw>[] = [{ key: 'gone', item: draw('gone'), alpha: 0.5, target: 0 }];
		const half = stepFades(es, 45, 180);
		expect(half.entries).toHaveLength(1);
		expect(stepFades(half.entries, 180, 180).entries).toEqual([]);
	});

	it('is instant at a duration of zero', () => {
		const es: FadeEntry<Draw>[] = [
			{ key: 'a', item: draw('a'), alpha: 0, target: 1 },
			{ key: 'gone', item: draw('gone'), alpha: 1, target: 0 },
		];
		const r = stepFades(es, 16, 0);
		expect(shown(r.entries)).toEqual(['a@1.00']);
		expect(r.moving).toBe(false);
	});
});
