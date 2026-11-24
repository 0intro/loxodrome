/* A temporary zone's look in each state (components/ZoneSwatch.svelte), the
 * Layers key's and the lists': the hatch when active, the band clipped
 * inside the edge when it may be active, a dashed outline when later, in
 * the supplements' magenta or the NOTAM areas' orange, each state its own
 * (docs/zone-activity.md, "The map"). */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ZoneSwatch from '$lib/components/ZoneSwatch.svelte';

const swatch = (state: 'active' | 'may' | 'later', family?: 'sup' | 'notam'): string =>
	render(ZoneSwatch, { props: family ? { state, family } : { state } }).body;

describe('the zone swatch', () => {
	it('draws each state its own way, in the supplements magenta', () => {
		const active = swatch('active');
		expect(active).toContain('fill="url(#hatch-supaip)"');
		expect(active).not.toContain('stroke-dasharray');
		const may = swatch('may');
		expect(may).toContain('stroke="url(#hatch-supaip-band)"');
		expect(may).toMatch(/clip-path="url\(#[^)]+-inside\)"/);
		const later = swatch('later');
		expect(later).toContain('stroke-dasharray="4 3"');
		expect(later).not.toContain('url(#');
		expect(new Set([active, may, later]).size).toBe(3);
		for (const s of [active, may, later]) {
			expect(s).toContain('#c2185b');
		}
	});

	it('draws a NOTAM zone in the NOTAM areas orange', () => {
		expect(swatch('active', 'notam')).toContain('fill="url(#hatch-notam)"');
		expect(swatch('may', 'notam')).toContain('stroke="url(#hatch-notam-band)"');
		expect(swatch('later', 'notam')).toContain('#ff7800');
	});
});
