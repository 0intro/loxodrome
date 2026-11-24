/* An aerodrome with no published elevation still has ground under its
 * altitude profile. About 1,700 baseline rows and the DFS rows the merge
 * cannot fill carry none, and AirportDetail passed the elevation alone: the
 * model never read the terrain, so the "airspace above" line was suppressed
 * and no AGL limit could be placed over those fields. The panel hands its
 * position over too, a known elevation still winning in the model
 * (detail/altitudeProfileModel, pinned in profileGround.client.spec).
 * Pinned by its source, the page's idiom (closureInstantSurfaces): it needs
 * a DOM and an aerodrome to render. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/lib/components/detail/AirportDetail.svelte', 'utf8');

describe('the aerodrome panel altitude profile', () => {
	it('reads the terrain at the field when no elevation is published', () => {
		const tag = /<AltitudeProfile\b[^>]*>/s.exec(page)?.[0] ?? '';
		expect(tag).toContain('groundFt={airport.elevFt}');
		expect(tag).toContain('lat={airport.lat}');
		expect(tag).toContain('lon={airport.lon}');
	});
});
