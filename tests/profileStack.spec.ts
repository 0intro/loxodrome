/* The profiles' right-click stack (components/profileStack.ts), shared by
 * the route and trace modals: which bands it lists at a point, and what its
 * empty row says. An empty row under a band the pilot's filter hid says so,
 * since "No airspace here" would assert an absence the filter created, and
 * a FIS sector leaves the class G under a TMA floor class G. */

import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ProfileStackMenu from '$lib/components/ProfileStackMenu.svelte';
import { i18n } from '$lib/state/i18n.svelte';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import { airspaceCategory, type VerticalLimit } from '$lib/data/airspaces';
import type { AirspaceCorridorBand } from '$lib/route/airspaces';
import { fromTriple, type VLimit } from '$lib/vertical/limits';
import { profileStackAt } from '$lib/components/profileStack';

function band(
	key: string,
	type: string,
	airClass: string,
	lower: VerticalLimit,
	upper: VerticalLimit,
	category = airspaceCategory(type),
): AirspaceCorridorBand {
	return {
		key,
		id: key,
		name: key,
		type,
		category,
		vLower: fromTriple(lower),
		vUpper: fromTriple(upper),
		airClass,
		entry: NO_ENTRY,
		badge: null,
		activity: 'permanent',
		spans: [{ enterNM: 0, leaveNM: 20 }],
	};
}

const ft = (n: number): VerticalLimit => ['ALT', String(n), 'FT'] as unknown as VerticalLimit;
const SFC = ['SFC', '', ''] as unknown as VerticalLimit;
const FL = (n: number): VerticalLimit => ['STD', String(n), 'FL'] as unknown as VerticalLimit;
const at = (altFt: number) => ({ distNM: 10, altFt, floorGroundFt: 300, ceilGroundFt: 300 });

describe('profileStackAt', () => {
	const ctr = band('CTR|D', 'CTR', 'D', SFC, ft(2500));
	const tma = band('TMA|D', 'TMA', 'D', ft(3500), FL(65));
	const siv = band('SIV|1', 'SIV', '', SFC, FL(65), 'siv');

	it('lists the drawn bands containing the point', () => {
		const s = profileStackAt(at(1500), [ctr, tma], [ctr, tma], []);
		expect(s.bands.map((b) => b.key)).toEqual(['CTR|D']);
		expect([s.belowCharted, s.hiddenHere]).toEqual([false, false]);
	});

	it('says a filter hid the band containing the point', () => {
		// The class D row off: the chart draws neither, the walk has both.
		const s = profileStackAt(at(1500), [], [ctr, tma], []);
		expect(s.bands).toEqual([]);
		expect([s.belowCharted, s.hiddenHere]).toEqual([false, true]);
	});

	it('reads class G under a TMA floor, a FIS sector there or not', () => {
		// The FIS row ships off: the sector is in the walk, never drawn.
		const s = profileStackAt(at(2000), [tma], [siv, tma], []);
		expect(s.bands).toEqual([]);
		expect([s.belowCharted, s.hiddenHere]).toEqual([true, false]);
	});

	it('leaves a point above every band at this distance plain', () => {
		const s = profileStackAt(at(9000), [ctr, tma], [ctr, tma], []);
		expect([s.bands.length, s.belowCharted, s.hiddenHere]).toEqual([0, false, false]);
	});

	// Each floor resolves against the ground at the point, as the
	// containment test reads it: over 2000 ft ground a 1500 ft ASFC floor
	// sits at 3500 ft, above a 2500 ft AMSL one.
	it('lists the stack floor up over the ground at the point', () => {
		const asfc = band('A|D', 'TMA', 'D', ['HEI', '1500', 'FT'] as unknown as VerticalLimit, FL(65));
		const amsl = band('B|D', 'TMA', 'D', ft(2500), FL(65));
		const high = { distNM: 10, altFt: 4000, floorGroundFt: 2000, ceilGroundFt: 2000 };
		const s = profileStackAt(high, [asfc, amsl], [asfc, amsl], []);
		expect(s.bands.map((b) => b.key)).toEqual(['B|D', 'A|D']);
	});
});

describe('the empty row', () => {
	const noop = (): void => {};
	const props = { bands: [], x: 10, y: 10, onSelectBand: noop, onHoverBand: noop, onClose: noop };
	const row = (belowCharted: boolean, hiddenHere: boolean, locale: 'en' | 'fr'): string => {
		i18n.locale = locale;
		const html = render(ProfileStackMenu, { props: { ...props, belowCharted, hiddenHere } }).body;
		return /class="ctx-empty[^"]*"[^>]*>([^<]*)</.exec(html)?.[1] ?? '';
	};

	it('says a filter hid the airspace, in both languages', () => {
		expect(row(false, true, 'en')).toBe('Airspace hidden here by a filter');
		expect(row(false, true, 'fr')).toBe('Espace aérien masqué ici par un filtre');
		expect(row(false, false, 'en')).toBe('No airspace here');
		expect(row(true, false, 'en')).toBe('Classe G (uncharted)');
		i18n.locale = 'en';
	});
});

// Items F) and G) each state a limit, SFC and UNL written out, so a NOTAM
// row with one of them prints the other as unknown, as an airspace row does.
describe('the NOTAM rows', () => {
	const noop = (): void => {};
	const props = { bands: [], x: 10, y: 10, onSelectBand: noop, onHoverBand: noop, onClose: noop };
	const amsl = (n: number): VLimit => ({ ft: n, ref: 'AMSL', value: n, unit: 'ft' });
	const limits = (vLower: VLimit | null, vUpper: VLimit | null): string => {
		const notams = [{ id: 'R0001/26', index: 0, vLower, vUpper, known: true }];
		const html = render(ProfileStackMenu, {
			props: { ...props, notams, belowCharted: false, hiddenHere: false },
		}).body.replace(/<!--[^>]*-->/g, '');
		return /class="ctx-band[^"]*"[^>]*>([^<]*)</.exec(html)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
	};

	it('prints the side a NOTAM leaves unstated as unknown', () => {
		expect(limits(amsl(1000), null)).toBe('1000 ft AMSL – ?');
		expect(limits(null, amsl(2000))).toBe('? – 2000 ft AMSL');
		expect(limits(amsl(1000), amsl(2000))).toBe('1000 ft AMSL – 2000 ft AMSL');
	});
});
