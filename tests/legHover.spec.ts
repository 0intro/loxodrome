/* The pointed-at route leg (state/legHover.svelte): the map and the Route tab
 * both write this ONE state, which is what lets each surface mark what the
 * other is pointing at. The rule that keeps them from fighting is that a clear
 * NAMES the leg it clears, because the two pointers interleave: a focusin on
 * another row's altitude field points at that leg BEFORE the mouse leaves the
 * row it was resting on, and an unnamed clear would then drop the newer hover
 * and leave the map pointing at nothing. */

import { afterEach, describe, expect, it } from 'vitest';
import { hoverLeg, legHover, releasePanelLeg, unhoverLeg } from '$lib/state/legHover.svelte';
import { componentCode, run } from './helpers/componentCode';

afterEach(() => {
	legHover.leg = null;
});

describe('leg hover', () => {
	it('records the leg and the surface pointing at it', () => {
		hoverLeg('route-1', 'wp-3', 'map');
		expect(legHover.leg).toEqual({ routeId: 'route-1', fromId: 'wp-3', source: 'map' });
	});

	it('clears when the pointer leaves the leg it was on', () => {
		hoverLeg('route-1', 'wp-3', 'panel');
		unhoverLeg('wp-3');
		expect(legHover.leg).toBeNull();
	});

	it('a clear names its leg, so a late leave cannot drop a newer hover', () => {
		// The mouse rests on one row; the keyboard reaches the next row's
		// altitude field; only then does the mouse leave the first row.
		hoverLeg('route-1', 'wp-3', 'panel');
		hoverLeg('route-1', 'wp-4', 'panel');
		unhoverLeg('wp-3');
		expect(legHover.leg?.fromId).toBe('wp-4');
	});

	it('the other surface takes over without a clear in between', () => {
		hoverLeg('route-1', 'wp-3', 'panel');
		hoverLeg('route-1', 'wp-3', 'map');
		expect(legHover.leg?.source).toBe('map');
	});
});

// A Route-tab row torn down under a still pointer, or with its altitude box
// focused (the tab switched by a dropped file), gets no mouseleave and, in
// Firefox, no focusout: the leg stayed drawn heavy while its waypoint lived.
describe('a leg row torn down', () => {
	it('lets go of the panel hover of its leg', async () => {
		hoverLeg('route-1', 'wp-3', 'panel');
		releasePanelLeg('wp-3');
		await Promise.resolve();
		expect(legHover.leg).toBeNull();
	});

	it('leaves the map pointing at its leg, and another row pointing at another', async () => {
		hoverLeg('route-1', 'wp-3', 'map');
		releasePanelLeg('wp-3');
		await Promise.resolve();
		expect(legHover.leg?.source).toBe('map');
		hoverLeg('route-1', 'wp-4', 'panel');
		releasePanelLeg('wp-3');
		await Promise.resolve();
		expect(legHover.leg?.fromId).toBe('wp-4');
	});

	it('is what the row hands its leg to as it goes', () => {
		const row = componentCode('src/lib/components/tabs/route/WaypointRow.svelte');
		const released: string[] = [];
		const teardown = run<() => void>(
			{ releasePanelLeg: (id: string) => released.push(id), wp: { id: 'wp-3' } },
			`return ${row.callback('onDestroy', 'releasePanelLeg')};`,
		);
		teardown();
		expect(released).toEqual(['wp-3']);
	});
});
