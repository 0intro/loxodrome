/* Regression tests for the NOTAM marker selection highlight in notamLayer.ts.
 *
 * Colocated NOTAMs collapse to ONE stack marker shared by all their indexes
 * (markersByIndex maps every member index to the same L.Marker), so
 * applyHighlight must toggle the selected pin class per UNIQUE marker, by
 * membership: the old per-index toggle let a later index of the same stack
 * clear the class the highlighted index had just set, so selecting any but
 * the stack's last member never showed the selected pin (the
 * selection-always-highlights invariant).
 *
 * Also covers clearNotamLayer: the module-level group must be dropped on
 * teardown so a rebuilt map gets its own LayerGroup instead of one attached
 * to the destroyed map.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type L from 'leaflet';

interface FakeEl {
	classes: Set<string>;
	attrs: Map<string, string>;
	setAttribute: (name: string, value: string) => void;
	classList: {
		toggle: (name: string, force?: boolean) => boolean;
		add: (name: string) => void;
		remove: (name: string) => void;
	};
}

function makeEl(): FakeEl {
	const classes = new Set<string>();
	const attrs = new Map<string, string>();
	return {
		classes,
		attrs,
		setAttribute: (name: string, value: string) => {
			attrs.set(name, value);
		},
		classList: {
			toggle: (name: string, force?: boolean) => {
				const on = force ?? !classes.has(name);
				if (on) {
					classes.add(name);
				} else {
					classes.delete(name);
				}
				return on;
			},
			add: (name: string) => {
				classes.add(name);
			},
			remove: (name: string) => {
				classes.delete(name);
			},
		},
	};
}

// One element per constructed marker, in construction order.
let markerEls: FakeEl[] = [];
let groupConstructions = 0;

vi.mock('leaflet', () => {
	const makeChainable = <T>(extra: Partial<T> = {}): T => {
		const obj: Record<string, unknown> = {
			addTo: () => obj,
			on: () => obj,
			off: () => obj,
			remove: () => obj,
			setStyle: () => obj,
			getElement: () => null,
			...extra,
		};
		return obj as T;
	};
	const L = {
		layerGroup: () => {
			groupConstructions++;
			return makeChainable({
				addLayer: () => {},
				removeLayer: () => {},
				clearLayers: () => {},
			});
		},
		circle: () => makeChainable(),
		polygon: () => makeChainable(),
		marker: () => {
			const el = makeEl();
			markerEls.push(el);
			return makeChainable({ getElement: () => el });
		},
		divIcon: () => makeChainable(),
		DomEvent: { stopPropagation: () => {} },
	};
	return { default: L };
});

import { renderNotams, highlightNotam, clearNotamLayer } from '$lib/map/notamLayer';
import type { Notam } from '$lib/notam/types';
import type { IndexedNotam } from '$lib/state/notam.svelte';

function stubMap(): L.Map {
	return {
		getPane: () => ({}) as HTMLElement,
		createPane: () => ({ style: {} }) as unknown as HTMLElement,
	} as unknown as L.Map;
}

/** A position NOTAM at a fixed spot; several of these colocate into one pin. */
function psnNotam(id: string, index: number): IndexedNotam {
	const n = {
		id,
		isPolygon: false,
		coordinates: [{ lat: 45, lon: 3, type: 'psn' }],
		obstacleType: '',
		serviceStatus: '',
		qualifier: null,
	} as unknown as Notam;
	return { notam: n, index };
}

const SELECTED = 'notam-pin--selected';

describe('colocated-stack marker highlight', () => {
	beforeEach(() => {
		clearNotamLayer();
		markerEls = [];
		groupConstructions = 0;
	});

	it('collapses colocated NOTAMs to one marker and highlights it for EVERY member', () => {
		const map = stubMap();
		renderNotams(map, [psnNotam('A0001/26', 0), psnNotam('A0002/26', 1)], false, true);
		expect(markerEls.length).toBe(1);
		const el = markerEls[0];

		// Selecting the FIRST member of the stack (not the last) must light
		// the shared pin: the per-index toggle bug cleared it again on the
		// second index's iteration.
		highlightNotam(0);
		expect(el.classes.has(SELECTED)).toBe(true);

		highlightNotam(null);
		expect(el.classes.has(SELECTED)).toBe(false);

		// The last member works too (the only case the old code got right).
		highlightNotam(1);
		expect(el.classes.has(SELECTED)).toBe(true);
	});

	it('keeps distinct-position markers independent', () => {
		const map = stubMap();
		const far = psnNotam('B0001/26', 1);
		(far.notam.coordinates[0] as { lat: number }).lat = 46;
		renderNotams(map, [psnNotam('A0001/26', 0), far], false, true);
		expect(markerEls.length).toBe(2);
		highlightNotam(0);
		expect(markerEls.filter((e) => e.classes.has(SELECTED)).length).toBe(1);
	});
});

describe('clearNotamLayer', () => {
	beforeEach(() => {
		clearNotamLayer();
		markerEls = [];
		groupConstructions = 0;
	});

	it('drops the module group so a rebuilt map gets its own', () => {
		renderNotams(stubMap(), [psnNotam('A0001/26', 0)], false, true);
		expect(groupConstructions).toBe(1);
		// Same session, second render: the group is reused.
		renderNotams(stubMap(), [psnNotam('A0001/26', 0)], false, true);
		expect(groupConstructions).toBe(1);
		// After teardown a rebuild constructs a fresh group.
		clearNotamLayer();
		renderNotams(stubMap(), [psnNotam('A0001/26', 0)], false, true);
		expect(groupConstructions).toBe(2);
	});
});
