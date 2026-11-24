/* The corridor SOFIA is asked to brief covers the one the map draws. The
 * request carries a whole mile, and the route's navaids and free points
 * travel as coordinate tokens rounded to the minute, up to 0.7 NM off the
 * drawn centreline: a 7.4 NM corridor went out as 7, and a NOTAM in the
 * sliver between was never fetched while the corridor filter and the fetch
 * view took the drawn width as briefed. SOFIA refuses a half-width over
 * 99 NM. */

import { describe, expect, it, vi } from 'vitest';

const brief = vi.hoisted(() => ({ widths: [] as number[] }));
vi.mock('$lib/sofia/fetch', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/sofia/fetch')>()),
	briefFromSofia: (_tracks: unknown, opts: { widthNM: number }) => {
		brief.widths.push(opts.widthNM);
		return Promise.resolve();
	},
}));
vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	ensureNavaids: () => Promise.resolve([]),
}));

const { fetchRouteNotamsFromSofia, sofiaWidthNM } = await import('$lib/state/routeNotamFetch');
const route = await import('$lib/state/route.svelte');

describe('the corridor SOFIA is asked for', () => {
	it('covers the drawn one, the minute its tokens round to included', () => {
		expect(sofiaWidthNM(15)).toBe(16);
		expect(sofiaWidthNM(7.4)).toBe(9);
		expect(sofiaWidthNM(0.5)).toBe(2);
	});

	it("stays within SOFIA's 99 NM, and is asked as drawn past it", () => {
		expect(sofiaWidthNM(98)).toBe(99);
		expect(sofiaWidthNM(98.5)).toBe(99);
		expect(sofiaWidthNM(99)).toBe(99);
		// Refused by SOFIA, as before, rather than briefed narrower than drawn.
		expect(sofiaWidthNM(150)).toBe(150);
	});

	it('is what the route briefing asks for', async () => {
		route.clearAllRoutes();
		route.addWaypoint(48.5, 2.5);
		route.addWaypoint(49, 3);
		route.routeSettings.corridorRadiusNM = 7.4;
		await fetchRouteNotamsFromSofia();
		expect(brief.widths).toEqual([9]);
	});
});
