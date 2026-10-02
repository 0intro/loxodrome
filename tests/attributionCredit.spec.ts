/* The map corner's credit is a licence obligation with a clock on it, so the
 * clock is pinned here rather than left to a CSS file: the OSM Foundation's
 * attribution guideline allows the credit to collapse "automatically on map
 * interaction such as panning, clicking, or zooming" or "automatically after
 * five seconds", and the whole arrangement only holds if a credit that
 * CHANGES is said again. Leaflet and the DOM are stood in for: the module
 * touches four things (the control's container, its class list, a mutation
 * watch and the map's event bus), and each is a handful of lines.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type L from 'leaflet';

import { armAttributionCredit, CREDIT_HOLD_MS } from '$lib/map/attributionCredit';

/** The credit's box: the two properties the module reads or writes. */
function fakeContainer(): { el: HTMLElement; folded: () => boolean; say: (s: string) => void } {
	const classes = new Set<string>();
	const el = {
		textContent: '',
		classList: {
			add: (c: string) => classes.add(c),
			remove: (c: string) => classes.delete(c),
		},
	};
	return {
		el: el as unknown as HTMLElement,
		folded: () => classes.has('credit-folded'),
		say: (s: string) => {
			el.textContent = s;
		},
	};
}

/** The map's event bus, keyed by the string the module actually asks for. */
function fakeMap(el: HTMLElement): {
	map: L.Map;
	fire: (ev: string) => void;
	listeners: () => number;
} {
	const handlers = new Map<string, () => void>();
	const map = {
		attributionControl: { getContainer: () => el },
		on: (ev: string, fn: () => void) => handlers.set(ev, fn),
		off: (ev: string, fn: () => void) => {
			if (handlers.get(ev) === fn) {
				handlers.delete(ev);
			}
		},
	};
	return {
		map: map as unknown as L.Map,
		fire: (ev: string) => handlers.get(ev)?.(),
		listeners: () => handlers.size,
	};
}

/** The one Leaflet gesture string the module registers. */
const GESTURES = 'dragstart zoomstart click';

let mutate: (() => void) | undefined;
let disconnected = false;

beforeEach(() => {
	vi.useFakeTimers();
	mutate = undefined;
	disconnected = false;
	vi.stubGlobal(
		'MutationObserver',
		class {
			constructor(cb: () => void) {
				mutate = cb;
			}
			observe(): void {
				/* the test fires the callback itself */
			}
			disconnect(): void {
				disconnected = true;
			}
		},
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('armAttributionCredit', () => {
	it('holds the credit for the five seconds the guideline allows', () => {
		expect(CREDIT_HOLD_MS).toBe(5000);

		const box = fakeContainer();
		box.say('© OpenStreetMap contributors');
		const { map } = fakeMap(box.el);

		armAttributionCredit(map);
		expect(box.folded()).toBe(false);

		vi.advanceTimersByTime(CREDIT_HOLD_MS - 1);
		expect(box.folded()).toBe(false);

		vi.advanceTimersByTime(1);
		expect(box.folded()).toBe(true);
	});

	it('folds at the first pan, zoom or click', () => {
		const box = fakeContainer();
		const { map, fire } = fakeMap(box.el);

		armAttributionCredit(map);
		vi.advanceTimersByTime(1000);
		fire(GESTURES);
		expect(box.folded()).toBe(true);
	});

	it('says a credit that changed, and gives it its own five seconds', () => {
		const box = fakeContainer();
		box.say('© OpenStreetMap contributors');
		const { map } = fakeMap(box.el);

		armAttributionCredit(map);
		vi.advanceTimersByTime(CREDIT_HOLD_MS);
		expect(box.folded()).toBe(true);

		// A chart layer attaches: Leaflet rewrites the control.
		box.say('© OpenStreetMap contributors, © SIA');
		mutate?.();
		expect(box.folded()).toBe(false);

		vi.advanceTimersByTime(CREDIT_HOLD_MS);
		expect(box.folded()).toBe(true);
	});

	it('ignores a rewrite that says the same thing', () => {
		const box = fakeContainer();
		box.say('© OpenStreetMap contributors');
		const { map } = fakeMap(box.el);

		armAttributionCredit(map);
		vi.advanceTimersByTime(CREDIT_HOLD_MS);
		expect(box.folded()).toBe(true);

		// A chart re-stack: two layers, one attribution string, rewritten.
		mutate?.();
		expect(box.folded()).toBe(true);
	});

	it('gives the map and the watch back on teardown', () => {
		const box = fakeContainer();
		const { map, listeners } = fakeMap(box.el);

		const disarm = armAttributionCredit(map);
		expect(listeners()).toBe(1);

		disarm();
		expect(listeners()).toBe(0);
		expect(disconnected).toBe(true);

		// The clock went with it: a torn-down map must not fold a credit that
		// a remount has since put back up.
		vi.advanceTimersByTime(CREDIT_HOLD_MS * 2);
		expect(box.folded()).toBe(false);
	});

	it('does nothing when the map carries no attribution control', () => {
		const map = { attributionControl: undefined } as unknown as L.Map;
		expect(() => armAttributionCredit(map)()).not.toThrow();
	});
});
