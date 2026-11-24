import { describe, it, expect } from 'vitest';
import { extractObstacleHeights } from '$lib/notam/obstacleHeights';

// The forms of the world briefing of 2026-11-22 that one language read and
// the other missed. The cases of earlier corpora are in notamProfile.spec.
describe('extractObstacleHeights, November forms', () => {
	it('reads "HAUTEUR AU SOMMET" as a height, as "HAUTEUR DU SOMMET" is', () => {
		// P2594/26
		expect(extractObstacleHeights('HAUTEUR  AU SOMMET :30M')).toEqual({ topFt: null, hgtFt: 98 });
	});

	it('reads the French top in the middle of a line', () => {
		// P4074/26 and P4085/26, where the English says "ELEV".
		expect(extractObstacleHeights('PSN2: 453851N 0055257E, ALTITUDE: 822FT').topFt).toBe(822);
		expect(extractObstacleHeights('- ARBRES ALTITUDE 4746FT PSN').topFt).toBe(4746);
	});

	it('leaves a height above the slope of a take-off surface unread', () => {
		// P4299/26, whose French "HAUTEUR ESTIMEE A 20M DESSUS DU PLAN" reads
		// as nothing too.
		expect(extractObstacleHeights('ESTIMATED HGT : 20M ABOVE SLOPE.').hgtFt).toBeNull();
	});
});
