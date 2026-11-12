/* Corpus-driven rendering audit: every France NOTAM of the bilingual world
 * fixtures pushed through renderNotams with an argument-capturing Leaflet
 * mock, so the exact shapes the map would draw are asserted against the
 * parsed geometry: one polygon per area entry with the full ring, one circle
 * per radius-bearing psn coordinate at the exact metre radius, pins for the
 * rest, and the Q-line / qualifier circles only on selection (the FIR-wide
 * 999 NM disc included, pinning today's radius-of-influence behaviour). */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface CapturedCircle {
	center: [number, number];
	radius: number;
	interactive: boolean | undefined;
}
let polygons: Array<Array<[number, number]>> = [];
let circles: CapturedCircle[] = [];
let markers = 0;

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
		layerGroup: () =>
			makeChainable({
				addLayer: () => {},
				removeLayer: () => {},
				clearLayers: () => {},
			}),
		circle: (center: [number, number], opts: { radius: number; interactive?: boolean }) => {
			circles.push({
				center,
				radius: opts.radius,
				interactive: opts.interactive,
			});
			return makeChainable();
		},
		polygon: (latlngs: Array<[number, number]>) => {
			polygons.push(latlngs);
			return makeChainable();
		},
		marker: () => {
			markers++;
			return makeChainable();
		},
		divIcon: () => makeChainable(),
		DomEvent: { stopPropagation: () => {} },
	};
	return { default: L };
});

import {
	clearNotamLayer,
	highlightNotam,
	renderNotams,
	setPanelQRadiusIndex,
	setQlineRadiusVisible,
} from '$lib/map/notamLayer';
import { radiusToNM } from '$lib/notam/radius';
import { NM_TO_METERS } from '$lib/notam/units';
import { parseFranceByFir } from './worldFixtures';
import type { Notam } from '$lib/notam/types';
import type L from 'leaflet';

function stubMap(): L.Map {
	return {
		getPane: () => ({}) as HTMLElement,
		createPane: () => ({ style: {} }) as unknown as HTMLElement,
	} as unknown as L.Map;
}

function indexed(notams: Notam[]) {
	return notams.map((notam, index) => ({ notam, index }));
}

function isArea(n: Notam): boolean {
	return n.isPolygon && n.coordinates.length >= 3;
}

beforeEach(() => {
	clearNotamLayer();
	highlightNotam(null);
	setPanelQRadiusIndex(null);
	setQlineRadiusVisible(true);
	polygons = [];
	circles = [];
	markers = 0;
});

describe.each(['world-fr-20260610.txt', 'world-en-20260610.txt'])(
	'corpus rendering: %s',
	(fixture) => {
		it('draws each entry as its parsed shape class', () => {
			const notams = parseFranceByFir(fixture);
			renderNotams(stubMap(), indexed(notams), true, true, new Set());

			// One polygon per area entry, carrying the WHOLE ring.
			const areaEntries = notams.filter(isArea);
			expect(polygons.length).toBe(areaEntries.length);
			const wantRings = areaEntries
				.map((n) => n.coordinates.length)
				.sort((a, b) => a - b);
			const gotRings = polygons.map((p) => p.length).sort((a, b) => a - b);
			expect(gotRings).toEqual(wantRings);

			// One circle per radius-bearing psn coordinate of the non-area
			// entries, at the exact metre radius; Q-line circles are deferred
			// to selection and must NOT be here.
			const wantRadii = notams
				.filter((n) => !isArea(n))
				.flatMap((n) =>
					n.coordinates
						.filter(
							(c) =>
								c.type === 'psn' && c.radius != null && c.radiusUnit != null,
						)
						.map((c) => radiusToNM(c.radius!, c.radiusUnit!) * NM_TO_METERS),
				)
				.sort((a, b) => a - b);
			const gotRadii = circles.map((c) => c.radius).sort((a, b) => a - b);
			expect(gotRadii.length).toBe(wantRadii.length);
			for (let i = 0; i < wantRadii.length; i++) {
				expect(gotRadii[i]).toBeCloseTo(wantRadii[i], 6);
			}

			// Pins exist for the non-area entries (stacking collapses
			// colocated coordinates, so only a lower bound holds).
			expect(markers).toBeGreaterThan(0);
			expect(markers).toBeLessThanOrEqual(
				notams
					.filter((n) => !isArea(n))
					.reduce((s, n) => s + n.coordinates.length, 0),
			);
		});

		it('realises Q-line circles only on selection, the 999 disc included', () => {
			const notams = parseFranceByFir(fixture);
			renderNotams(stubMap(), indexed(notams), true, true, new Set());
			const renderCircles = circles.length;

			// A finite Q-line radius: selecting draws the blue influence
			// circle, non-interactive, at the published NM radius.
			const finite = notams.findIndex(
				(n) =>
					n.coordinates.length === 1 &&
					n.coordinates[0].type === 'qualifierLine' &&
					n.coordinates[0].radius != null &&
					n.coordinates[0].radius < 999,
			);
			expect(finite).toBeGreaterThanOrEqual(0);
			highlightNotam(finite);
			expect(circles.length).toBe(renderCircles + 1);
			const q = circles[circles.length - 1];
			expect(q.interactive).toBe(false);
			expect(q.radius).toBeCloseTo(
				notams[finite].coordinates[0].radius! * NM_TO_METERS,
				6,
			);

			// The FIR-wide sentinel draws its full 1850 km disc on selection
			// (today's radius-of-influence behaviour, pinned deliberately:
			// framing ignores the sentinel, the paint does not). The French
			// world subset happens to carry none, so the English run covers
			// this branch.
			const firWide = notams.findIndex(
				(n) =>
					n.coordinates.length === 1 &&
					n.coordinates[0].type === 'qualifierLine' &&
					n.coordinates[0].radius === 999,
			);
			if (firWide >= 0) {
				highlightNotam(firWide);
				expect(circles[circles.length - 1].radius).toBeCloseTo(
					999 * NM_TO_METERS,
					6,
				);
			}
		});
	},
);
