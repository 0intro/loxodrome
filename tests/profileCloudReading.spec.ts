/* What the route profile shows of the clouds under the pointer
 * (docs/route-profile.md, "Cursor readout"), rendered on the server:
 *
 * - the readout's Clouds row prints one line per layer, the one under the
 *   pointer alone in bold, and its notes sit under the rows, before the
 *   hint; a readout given no notes (the trace profile's) prints none;
 * - the stack menu lists the clouds under the airspace stack, after the
 *   empty row as after the band rows, as read-only lines (a cloud has no
 *   panel to open), and a menu given none (the trace profile's, or the
 *   Clouds layer off) shows no such section. */

import { render } from 'svelte/server';
import { beforeEach, describe, expect, it } from 'vitest';
import ProfileReadout from '$lib/components/ProfileReadout.svelte';
import ProfileStackMenu from '$lib/components/ProfileStackMenu.svelte';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import type { AirspaceCorridorBand } from '$lib/route/airspaces';
import { i18n } from '$lib/state/i18n.svelte';

beforeEach(() => {
	i18n.locale = 'en';
});

/** The markup's text, tags stripped (Svelte's hydration comments too). */
const text = (html: string): string =>
	html
		.replace(/<!--[^>]*-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

const LAYERS = [
	{ text: 'BKN 1000–3000 ft', strong: true },
	{ text: 'SCT 4100–5900 ft', strong: false },
];

const noop = (): void => {};
const menuProps = {
	bands: [] as AirspaceCorridorBand[],
	belowCharted: false,
	x: 10,
	y: 10,
	onSelectBand: noop,
	onHoverBand: noop,
	onClose: noop,
};

const band: AirspaceCorridorBand = {
	key: 'LFR1|R 1',
	id: 'LFR1',
	name: 'R 1',
	type: 'R',
	category: 'restricted',
	vLower: null,
	vUpper: null,
	airClass: '',
	entry: NO_ENTRY,
	badge: null,
	spans: [{ enterNM: 0, leaveNM: 10 }],
};

describe('the readout', () => {
	it('prints a line per layer, only the one under the pointer in bold', () => {
		const html = render(ProfileReadout, {
			props: {
				rows: [
					{ label: 'Distance', value: '12.0 NM' },
					{ label: 'Clouds', value: LAYERS },
				],
			},
		}).body;
		expect(html).toMatch(/<dd[^>]*>12\.0 NM<\/dd>/);
		const spans = [...html.matchAll(/<span([^>]*)>([^<]*)<\/span>/g)].map((m) => ({
			text: m[2],
			strong: /\bstrong\b/.test(m[1]),
		}));
		expect(spans).toEqual(LAYERS);
	});

	it('sets its notes under the rows, before the hint', () => {
		const html = render(ProfileReadout, {
			props: {
				rows: [{ label: 'Clouds', value: LAYERS }],
				notes: ['Valid 14:05Z 7 Oct'],
				hint: 'Right-click or long-press: airspaces and clouds',
			},
		}).body;
		const at = (s: string): number => html.indexOf(s);
		expect(at('SCT 4100–5900 ft')).toBeGreaterThan(-1);
		expect(at('Valid 14:05Z 7 Oct')).toBeGreaterThan(at('SCT 4100–5900 ft'));
		expect(at('Right-click or long-press')).toBeGreaterThan(at('Valid 14:05Z 7 Oct'));
	});

	it('prints no notes when given none', () => {
		const html = render(ProfileReadout, {
			props: { rows: [{ label: 'Distance', value: '12.0 NM' }], hint: 'Right-click or long-press: airspaces' },
		}).body;
		expect(html).not.toMatch(/class="note/);
	});
});

describe('the stack menu', () => {
	const clouds = { lines: LAYERS, notes: ['Forecast AROME 06:00Z 7 Oct', 'Valid 14:05Z 7 Oct'] };

	it('lists the clouds after the empty stack, read-only', () => {
		const html = render(ProfileStackMenu, { props: { ...menuProps, clouds } }).body;
		// The section closes just before the menu does.
		const section =
			/<div class="ctx-clouds[^"]*">([\s\S]*)<\/div>\s*<\/div>/.exec(html.replace(/<!--[^>]*-->/g, ''))?.[1] ?? '';
		expect(text(section)).toBe(
			'Clouds BKN 1000–3000 ft SCT 4100–5900 ft Forecast AROME 06:00Z 7 Oct Valid 14:05Z 7 Oct',
		);
		expect(section).not.toMatch(/<button/);
		expect(html.indexOf('No airspace here')).toBeGreaterThan(-1);
		expect(html.indexOf('ctx-clouds')).toBeGreaterThan(html.indexOf('No airspace here'));
		// Only the layer at the click's altitude is set apart.
		expect([...section.matchAll(/class="ctx-cloud([^"]*)"/g)].map((m) => /\bstrong\b/.test(m[1]))).toEqual([
			true,
			false,
		]);
	});

	it('lists them after the band rows too', () => {
		const html = render(ProfileStackMenu, { props: { ...menuProps, bands: [band], clouds } }).body;
		expect(html.indexOf('R 1')).toBeGreaterThan(-1);
		expect(html.indexOf('ctx-clouds')).toBeGreaterThan(html.lastIndexOf('ctx-item'));
	});

	it('shows no clouds section when given none', () => {
		expect(render(ProfileStackMenu, { props: menuProps }).body).not.toMatch(/ctx-clouds/);
		expect(render(ProfileStackMenu, { props: { ...menuProps, clouds: null } }).body).not.toMatch(/ctx-clouds/);
	});
});
