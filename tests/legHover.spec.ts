/* The pointed-at route leg (state/legHover.svelte): the map and the Route tab
 * both write this ONE state, which is what lets each surface mark what the
 * other is pointing at. The rule that keeps them from fighting is that a clear
 * NAMES the leg it clears, because the two pointers interleave: a focusin on
 * another row's altitude field points at that leg BEFORE the mouse leaves the
 * row it was resting on, and an unnamed clear would then drop the newer hover
 * and leave the map pointing at nothing. */

import { afterEach, describe, expect, it } from 'vitest';
import { hoverLeg, legHover, unhoverLeg } from '$lib/state/legHover.svelte';

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
