/* The profiles' Airspaces popover (ProfileAirspacesPopover.svelte) states
 * the prohibited-area rule as the gate applies it: every row passes a
 * prohibited area, while the level band still hides one the drawn line
 * misses (route/airspaceFilter.ts, pinned in airspaceBandFilter.spec.ts)
 * and, on the column profiles, the map scope too (state/profile.svelte.ts).
 * "Always plotted" asserted more than that, and a pilot could take a chart
 * with no P on it for an area with none. */

import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ProfileAirspacesPopover from '$lib/components/ProfileAirspacesPopover.svelte';
import { AIRSPACE_FILTER_GROUPS } from '$lib/data/airspaces';
import { i18n } from '$lib/state/i18n.svelte';

function popover(locale: 'en' | 'fr'): string {
	i18n.locale = locale;
	const props = { rows: AIRSPACE_FILTER_GROUPS, anchorEl: undefined, onClose: () => {} };
	return render(ProfileAirspacesPopover, { props }).body;
}

const foot = (html: string): string => /class="toggles-foot[^"]*"[^>]*><span>([^<]*)</.exec(html)?.[1] ?? '';

describe('the prohibited-area rule the popover states', () => {
	it('scopes it to the rows, in both languages', () => {
		const en = popover('en');
		expect(foot(en)).toBe('Prohibited areas are exempt from these rows.');
		expect(en).toContain('Prohibited areas (P) are exempt from every row.');
		const fr = popover('fr');
		expect(foot(fr)).toBe('Les zones interdites sont exemptées de ces lignes.');
		expect(fr).toContain('Les zones interdites (P) sont exemptées de toutes les lignes.');
		i18n.locale = 'en';
	});
});
