/* Unit tests for the Q-line radius circles in notamLayer.ts.
 *
 * Mocks Leaflet's L.circle / L.polygon / L.marker / L.layerGroup / L.divIcon
 * just enough to observe addLayer / removeLayer calls on the LayerGroup, then
 * exercises the two independent triggers:
 *   - blue Q-line-fallback NOTAMs auto-show on selection, gated by the global
 *     Display toggle (setQlineRadiusVisible + highlightNotam);
 *   - position / area NOTAMs show only via the detail-panel index toggle
 *     (setPanelQRadiusIndex), sourced from notam.qualifier.
 * Also covers that the two paths never cross, and the qlineMarkers deferral.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type L from 'leaflet';

// Track every layer addition / removal on the LayerGroup. The real Leaflet
// group calls addLayer when something is .addTo(group); here we just record.
let layersInGroup = new Set<unknown>();
let circleConstructions = 0;
let markerConstructions = 0;

// Hoisted Leaflet mock. Returns just enough surface for notamLayer.ts to
// run end-to-end without a DOM. The objects returned are stable so we can
// identify them in the group's Set.
vi.mock('leaflet', () => {
	const makeChainable = <T>(extra: Partial<T> = {}): T => {
		const obj: Record<string, unknown> = {
			addTo: (target: unknown) => {
				if (
					target &&
					typeof (target as { addLayer?: unknown }).addLayer === 'function'
				) {
					(target as { addLayer: (l: unknown) => void }).addLayer(obj);
				}
				return obj;
			},
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
			const group = makeChainable<{
				addLayer: (l: unknown) => void;
				removeLayer: (l: unknown) => void;
				clearLayers: () => void;
			}>({
				addLayer: (l: unknown) => {
					layersInGroup.add(l);
				},
				removeLayer: (l: unknown) => {
					layersInGroup.delete(l);
				},
				clearLayers: () => {
					layersInGroup.clear();
				},
			});
			return group;
		},
		circle: () => {
			circleConstructions++;
			return makeChainable();
		},
		polygon: () => makeChainable(),
		marker: () => {
			markerConstructions++;
			return makeChainable();
		},
		divIcon: () => makeChainable(),
		DomEvent: { stopPropagation: () => {} },
	};
	return { default: L };
});

import {
	renderNotams,
	highlightNotam,
	setQlineRadiusVisible,
	setPanelQRadiusIndex,
} from '$lib/map/notamLayer';
import type { Notam } from '$lib/notam/types';
import type { IndexedNotam } from '$lib/state/notam.svelte';

function stubMap(): L.Map {
	return {
		getPane: () => ({}) as HTMLElement,
		createPane: () => ({ style: {} }) as unknown as HTMLElement,
	} as unknown as L.Map;
}

// A blue (Q-line-fallback) NOTAM: its sole coordinate is the qualifierLine
// pin, which carries the radius.
function qlineNotam(): IndexedNotam {
	const n = {
		id: 'TEST/26',
		isPolygon: false,
		coordinates: [
			{ lat: 45, lon: 3, type: 'qualifierLine', radius: 10, radiusUnit: 'NM' },
		],
		obstacleType: '',
		serviceStatus: '',
		qualifier: null,
	} as unknown as Notam;
	return { notam: n, index: 0 };
}

// A red (position) NOTAM: a plotted PSN coordinate plus a Q) line that carries
// the Q-line centre + radius separately. The circle must come from qualifier.
function positionNotam(): IndexedNotam {
	const n = {
		id: 'POS/26',
		isPolygon: false,
		coordinates: [{ lat: 45, lon: 3, type: 'psn' }],
		obstacleType: '',
		serviceStatus: '',
		qualifier: { lat: 45.1, lon: 3.1, radius: 5 },
	} as unknown as Notam;
	return { notam: n, index: 0 };
}

describe('blue Q-line-fallback circle (selection + global toggle)', () => {
	beforeEach(() => {
		layersInGroup = new Set();
		circleConstructions = 0;
		markerConstructions = 0;
		// Reset module-level state so tests don't leak.
		highlightNotam(null);
		setQlineRadiusVisible(true);
		setPanelQRadiusIndex(null);
	});

	it('auto-shows on selection when the global toggle is on', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, true);
		const before = circleConstructions;
		highlightNotam(0);
		expect(circleConstructions).toBe(before + 1);
	});

	it('stays hidden on selection when the global toggle is off', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, true);
		setQlineRadiusVisible(false);
		const before = circleConstructions;
		highlightNotam(0);
		expect(circleConstructions).toBe(before);
	});

	it('removes synchronously when the toggle flips off while selected', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, true);
		highlightNotam(0);
		const before = layersInGroup.size;
		setQlineRadiusVisible(false);
		expect(layersInGroup.size).toBe(before - 1);
	});

	it('re-adds when the toggle flips back on', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, true);
		highlightNotam(0);
		setQlineRadiusVisible(false);
		const sizeBefore = layersInGroup.size;
		const ctorsBefore = circleConstructions;
		setQlineRadiusVisible(true);
		expect(layersInGroup.size).toBe(sizeBefore + 1);
		expect(circleConstructions).toBe(ctorsBefore + 1);
	});

	it('draws nothing when no NOTAM is selected', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, true);
		const before = circleConstructions;
		setQlineRadiusVisible(false);
		setQlineRadiusVisible(true);
		expect(circleConstructions).toBe(before);
	});

	it('ignores the panel toggle (blue never uses the qualifier track)', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, true);
		const before = circleConstructions;
		setPanelQRadiusIndex(0);
		expect(circleConstructions).toBe(before);
	});
});

describe('position / area Q-radius (detail-panel toggle)', () => {
	beforeEach(() => {
		layersInGroup = new Set();
		circleConstructions = 0;
		markerConstructions = 0;
		highlightNotam(null);
		setQlineRadiusVisible(true);
		setPanelQRadiusIndex(null);
	});

	it('shows the qualifier circle when the panel index is toggled on', () => {
		const map = stubMap();
		renderNotams(map, [positionNotam()], false, true);
		const before = circleConstructions;
		setPanelQRadiusIndex(0);
		expect(circleConstructions).toBe(before + 1);
	});

	it('does not auto-show on selection (panel toggle only)', () => {
		const map = stubMap();
		renderNotams(map, [positionNotam()], false, true);
		const before = circleConstructions;
		highlightNotam(0);
		expect(circleConstructions).toBe(before);
	});

	it('removes synchronously when toggled off', () => {
		const map = stubMap();
		renderNotams(map, [positionNotam()], false, true);
		setPanelQRadiusIndex(0);
		const before = layersInGroup.size;
		setPanelQRadiusIndex(null);
		expect(layersInGroup.size).toBe(before - 1);
	});

	it('re-adds a fresh circle when toggled back on', () => {
		const map = stubMap();
		renderNotams(map, [positionNotam()], false, true);
		setPanelQRadiusIndex(0);
		setPanelQRadiusIndex(null);
		const sizeBefore = layersInGroup.size;
		const ctorsBefore = circleConstructions;
		setPanelQRadiusIndex(0);
		expect(layersInGroup.size).toBe(sizeBefore + 1);
		expect(circleConstructions).toBe(ctorsBefore + 1);
	});

	it('is a no-op for a NOTAM whose Q) line carries no radius', () => {
		const map = stubMap();
		const n = {
			id: 'NOQ/26',
			isPolygon: false,
			coordinates: [{ lat: 1, lon: 2, type: 'psn' }],
			obstacleType: '',
			serviceStatus: '',
			qualifier: null,
		} as unknown as Notam;
		renderNotams(map, [{ notam: n, index: 0 }], false, true);
		const before = layersInGroup.size;
		setPanelQRadiusIndex(0);
		expect(layersInGroup.size).toBe(before);
	});
});

describe('renderNotams qlineMarkers flag', () => {
	beforeEach(() => {
		layersInGroup = new Set();
		circleConstructions = 0;
		markerConstructions = 0;
		highlightNotam(null);
		setQlineRadiusVisible(true);
		setPanelQRadiusIndex(null);
	});

	it('creates a marker for a Q-line NOTAM when qlineMarkers is true', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, true);
		expect(markerConstructions).toBe(1);
	});

	it('skips the Q-line marker when qlineMarkers is false', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, false);
		expect(markerConstructions).toBe(0);
	});

	it('still defers the Q-line circle when qlineMarkers is false, shown on selection', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, false);
		expect(markerConstructions).toBe(0);
		const before = circleConstructions;
		highlightNotam(0);
		expect(circleConstructions).toBe(before + 1);
	});
});

describe('renderNotams hideQlineMarkerIdx (airport blue-marker suppression)', () => {
	beforeEach(() => {
		layersInGroup = new Set();
		circleConstructions = 0;
		markerConstructions = 0;
		highlightNotam(null);
		setQlineRadiusVisible(true);
		setPanelQRadiusIndex(null);
	});

	it('suppresses the blue Q-line marker when its index is in the set', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, true, new Set([0]));
		expect(markerConstructions).toBe(0);
	});

	it('draws the blue Q-line marker when its index is not in the set', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, true, new Set([1]));
		expect(markerConstructions).toBe(1);
	});

	it('leaves a red PSN marker untouched even when its index is in the set', () => {
		const map = stubMap();
		renderNotams(map, [positionNotam()], false, true, new Set([0]));
		expect(markerConstructions).toBe(1);
	});

	it('still defers the Q-line circle when the marker is suppressed, shown on selection', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, true, new Set([0]));
		expect(markerConstructions).toBe(0);
		const before = circleConstructions;
		highlightNotam(0);
		expect(circleConstructions).toBe(before + 1);
	});

	it('reveals one blue marker when the suppressed NOTAM is selected, removes it on deselect', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, true, new Set([0]));
		expect(markerConstructions).toBe(0);
		const sizeBefore = layersInGroup.size;
		highlightNotam(0);
		expect(markerConstructions).toBe(1); // the revealed marker is built
		highlightNotam(null);
		expect(layersInGroup.size).toBe(sizeBefore); // revealed marker removed again
	});

	it('does not reveal an extra marker for a non-suppressed Q-line NOTAM', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, true); // drawn normally
		const before = markerConstructions; // 1
		highlightNotam(0);
		expect(markerConstructions).toBe(before); // no reveal marker
	});

	it('keeps the revealed marker across a re-render of the same set', () => {
		const map = stubMap();
		const notam = qlineNotam();
		renderNotams(map, [notam], false, true, new Set([0]));
		highlightNotam(0);
		const afterReveal = markerConstructions; // 1, the revealed marker
		const live = layersInGroup.size;
		renderNotams(map, [notam], false, true, new Set([0])); // same set
		// The unchanged set is a no-op, so the revealed marker is neither torn
		// down nor rebuilt: it survives at zero cost.
		expect(markerConstructions).toBe(afterReveal);
		expect(layersInGroup.size).toBe(live);
	});

	it('re-reveals the suppressed marker when the set actually changes', () => {
		const map = stubMap();
		renderNotams(map, [qlineNotam()], false, true, new Set([0]));
		highlightNotam(0);
		const afterReveal = markerConstructions; // 1
		// A fresh parse hands out a new Notam object at the same index, so the
		// layer redraws and re-reveals at end-of-render.
		renderNotams(map, [qlineNotam()], false, true, new Set([0]));
		// Only the reveal: index 0 is suppressed, so the marker pass builds none.
		expect(markerConstructions).toBe(afterReveal + 1);
	});
});
