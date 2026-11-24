/* The name a free point nobody named shows (state/waypointNames.svelte.ts
 * behind route/navlog.ts waypointLabel): the position reading at the point,
 * a placeholder never saved in the plan file, written by the exports as a
 * snapshot (docs/search.md "Waypoint names"). */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { autoWaypointName, setAutoWaypointNamer, waypointLabel } from '$lib/route/navlog';
import { landingLines } from '$lib/route/format';
import { routeExportPoints } from '$lib/route/routePoints';
import { buildRoutesDoc, stringifyRoutesDoc } from '$lib/route/yaml';
import type { Waypoint } from '$lib/state/route.svelte';

function wp(extra: Partial<Waypoint>): Waypoint {
	return { id: 'w', lat: 48.5, lon: 2.2, kind: 'free', alt: 2000, altAuto: true, ...extra };
}

// A namer as the app registers one, answering for one point.
const NAMER = (w: { lat: number; lon: number }): string | null => (w.lat === 48.5 ? 'NW Étampes' : null);

afterEach(() => {
	setAutoWaypointNamer(null);
});

describe('the automatic name', () => {
	it('is a free point\'s name only while nobody named it, and its coordinates where no reference is near', () => {
		expect(waypointLabel(wp({}))).toBe('48.500, 2.200');
		setAutoWaypointNamer(NAMER);
		expect(waypointLabel(wp({}))).toBe('NW Étampes');
		expect(waypointLabel(wp({ label: 'Château' }))).toBe('Château');
		expect(waypointLabel(wp({ kind: 'airport', ident: 'LFOX' }))).toBe('LFOX');
		expect(autoWaypointName(wp({ label: 'Château' }))).toBeNull();
		expect(waypointLabel(wp({ lat: 47 }))).toBe('47.000, 2.200');
	});

	it('names a dragged point nobody named', () => {
		setAutoWaypointNamer(NAMER);
		expect(landingLines({ lat: 48.5, lon: 2.2, snap: null }, { customPoint: 'Custom point' })[0]).toBe('NW Étampes');
		expect(landingLines({ lat: 47, lon: 2.2, snap: null }, { customPoint: 'Custom point' })[0]).toBe('Custom point');
	});

	it('leaves the plan file as it was, and goes into an export as a snapshot', () => {
		setAutoWaypointNamer(NAMER);
		const free = wp({});
		const yaml = stringifyRoutesDoc(buildRoutesDoc([{ name: 'R', waypoints: [free, wp({ lat: 48.6, label: 'B' })] }]));
		expect(yaml).not.toContain('Étampes');
		const points = routeExportPoints([free, wp({ id: 'b', lat: 48.6, label: 'B' })], { autoName: autoWaypointName });
		expect(points[0].name).toBe('NW Étampes');
		// The identifier stays the position's own, never folded from the reading.
		expect(points[0].ident).toBe('WP1');
		expect(routeExportPoints([free, wp({ id: 'b', lat: 48.6, label: 'B' })])[0].name).toBe('48.500, 2.200');
	});

	it('is the name box\'s grey placeholder, the value in force', () => {
		const row = readFileSync('src/lib/components/tabs/route/WaypointRow.svelte', 'utf8');
		expect(row).toContain('placeholder={autoWaypointName(wp) ?? t.route.customPoint}');
	});
});
