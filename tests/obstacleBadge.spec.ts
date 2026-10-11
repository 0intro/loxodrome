/* The obstacle panel's source badge (ObstacleDetail.svelte) reads the row's
 * own publisher, which data/obstacles.ts derives once from the id. The panel
 * used to work it out again from the text before the id's colon, with a list
 * of its own: cmd/fr addresses the two obstacles the SIA filed under one mid
 * as mid:txtName, their prefix a number the list did not know, and they lost
 * their FR badge. Rendered on the server. */

import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { Obstacle } from '$lib/data/obstacles';
import { installLeafletNode } from './helpers/leafletNode';

vi.mock('$lib/state/notamObstacleLinks.svelte', () => ({
	activeNotamsByObstacle: () => new Map(),
}));

// The panel's import graph reaches the map layers, which extend Leaflet's
// classes as they load.
installLeafletNode();
const { default: ObstacleDetail } = await import('$lib/components/detail/ObstacleDetail.svelte');

function obstacle(id: string, source: Obstacle['source']): Obstacle {
	return { id, type: 'mast', name: 'MAST', lat: 48.5, lon: 2.5, elev: 900, hgt: 300, lit: true, group: false, rmk: '', source };
}

const badge = (html: string): string | null => /tag--source[^>]*>([^<]*)</.exec(html)?.[1] ?? null;

describe('the obstacle panel badge', () => {
	it("badges the row's own publisher, a French mid:txtName included", () => {
		expect(badge(render(ObstacleDetail, { props: { obstacle: obstacle('1234567:PYLONE A', 'fr') } }).body)).toBe('FR');
		expect(badge(render(ObstacleDetail, { props: { obstacle: obstacle('1234567', 'fr') } }).body)).toBe('FR');
		expect(badge(render(ObstacleDetail, { props: { obstacle: obstacle('uk:abc', 'uk') } }).body)).toBe('UK');
	});

	it('shows no badge for a publisher no tooltip names', () => {
		expect(badge(render(ObstacleDetail, { props: { obstacle: obstacle('pruatlas:x', 'pruatlas') } }).body)).toBeNull();
	});
});
