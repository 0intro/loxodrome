/* The sidebar at its 280 px floor scrolled sideways on two rows: the Route
 * tab's leg row, whose fixed group took 233 px of a 208 px row (the wind chip
 * spilling past the panel, in both languages), and the Aircraft tab's fuel
 * row in French, whose fixed 136 px select left "Carburant" and the kg/L
 * reading no room. What a type checker cannot see: the leg row tightens by
 * the LIST's width alone, never by a value, so nothing in it moves while it is
 * edited (the leg rows' rule), on screen only, its wind chip still wide enough
 * for "360°/999" (measured in Chromium and Firefox at 56 px), and narrower
 * still it gives the track and distance a line of their own rather than hide
 * them; and the fuel select shrinks from a basis, so its width still never
 * follows the grade shown. */

import { describe, expect, it } from 'vitest';

import { cssRulesOf } from './helpers/cssRules';

const ROUTE_TAB = cssRulesOf('src/lib/components/tabs/RouteTab.svelte');
const ROW = cssRulesOf('src/lib/components/tabs/route/WaypointRow.svelte');
const EDITOR = cssRulesOf('src/lib/components/tabs/route/WaypointWindEditor.svelte');
const AIRCRAFT = cssRulesOf('src/lib/components/tabs/AircraftTab.svelte');
const TIGHT = ['@media screen', '@container wp-list (width < 340px)'];

const decls = (rules: ReturnType<typeof cssRulesOf>, sel: string, parents: string[]): Record<string, string> => {
	const r = rules.filter((x) => x.selectors.includes(sel) && JSON.stringify(x.parents) === JSON.stringify(parents));
	expect(r.length, `${sel} under ${parents.join(' ')}`).toBe(1);
	return Object.fromEntries(r[0].decls);
};

describe('the leg rows at a narrow sidebar', () => {
	it('query the list, a container on screen only', () => {
		expect(decls(ROUTE_TAB, '.wp-list', ['@media screen'])).toEqual({ container: 'wp-list / inline-size' });
	});

	it('tighten the fixed group as a whole below 340 px of list', () => {
		expect(decls(ROW, '.leg', TIGHT)).toEqual({ gap: '2px' });
		expect(decls(ROW, '.leg-tail', TIGHT)).toEqual({ gap: '2px' });
		const cues = ROW.filter((r) => JSON.stringify(r.parents) === JSON.stringify(TIGHT) && r.selectors.includes('.leg-warn'));
		expect(cues.map((r) => [r.selectors, Object.fromEntries(r.decls)])).toEqual([[['.leg-warn', '.leg-best'], { padding: '0 1px' }]]);
		expect(decls(ROW, '.leg-wind', TIGHT)).toEqual({ 'min-width': '56px', padding: '2px 1px' });
		// A finger's targets keep to their own slots, the gaps being narrower.
		const fingers = ROW.filter((r) => JSON.stringify(r.parents) === JSON.stringify(TIGHT) && r.selectors.some((s) => s.includes('::after')));
		expect(fingers.length).toBe(1);
		expect(fingers[0].decls.get('inset')).toBe('-10px -1px');
	});

	it('give the track and distance a line of their own below 300 px of list', () => {
		const WRAP = ['@media screen', '@container wp-list (width < 300px)'];
		expect(decls(ROW, '.leg', WRAP)).toEqual({ 'flex-wrap': 'wrap', 'row-gap': '2px' });
		expect(decls(ROW, '.leg-info', WRAP)).toEqual({ 'flex-basis': '100%' });
		expect(decls(ROW, '.leg-alt', WRAP)).toEqual({ 'margin-left': 'auto' });
	});

	it('keep their default chip and spacing at the default width', () => {
		expect(decls(ROW, '.leg', []).gap).toBe('6px');
		expect(decls(ROW, '.leg-wind', [])['min-width']).toBe('62px');
	});
});

/* The wind editor used to replace the 62 px chip with a 126 px editor, so
 * opening it moved the altitude field 64 px over the distance. It now fills
 * the leg's tail (the cue slots and the chip, laid out under it whether
 * shown or not), absolute, so nothing it holds can move the field or grow
 * the row; its boxes fit "360" only with the spinner hidden. */
describe('the wind editor in the leg tail', () => {
	it('fills the tail, the tail sized by its own slots', () => {
		expect(decls(ROW, '.leg-tail', [])).toMatchObject({ position: 'relative', flex: '0 0 auto', 'align-self': 'stretch' });
		expect(decls(ROW, '.leg-tail.editing > button', [])).toEqual({ visibility: 'hidden' });
		expect(decls(EDITOR, '.leg-wind-edit', [])).toMatchObject({ position: 'absolute', inset: '0' });
	});

	it('shares the tail between its boxes, the spinner hidden', () => {
		expect(decls(EDITOR, '.leg-wind-edit input', [])).toMatchObject({ flex: '1 1 0', 'min-width': '0', appearance: 'textfield' });
		expect(decls(EDITOR, '.leg-wind-edit input::-webkit-inner-spin-button', [])).toMatchObject({ appearance: 'none' });
	});
});

/* Firefox always draws a number box's spinner, and in the Flight parameters'
 * Wind row, two boxes to a row, it left the direction 25 px for the 27 of
 * "360" at the 280 px floor (19 in French): "250" read "25". The two boxes
 * hide it, as the leg's W/V editor does. */
describe('the global wind boxes at a narrow sidebar', () => {
	it('hide the spinner, the arrow keys still stepping', () => {
		expect(decls(ROUTE_TAB, '.range-label input.wind-box', [])).toEqual({ appearance: 'textfield' });
		expect(decls(ROUTE_TAB, '.range-label input.wind-box::-webkit-inner-spin-button', [])).toMatchObject({ appearance: 'none' });
	});
});

describe('the fuel row at a narrow sidebar', () => {
	it('lets the grade select shrink from its basis, never follow the grade shown', () => {
		expect(decls(AIRCRAFT, '.field select.fuel-type', [])).toEqual({ flex: '0 1 136px', 'min-width': '0' });
	});

	it('moves the kg/L reading whole under the box where the row cannot hold both', () => {
		expect(decls(AIRCRAFT, '.grade', [])).toMatchObject({ display: 'flex', 'flex-wrap': 'wrap' });
		expect(decls(AIRCRAFT, '.grade .unit', [])).toEqual({ 'white-space': 'nowrap' });
	});
});

/* The Aircraft card's labels sat in a fixed 110 px column, and three French
 * ones wrapped at every sidebar width ("Capacité des réservoirs" is 147 px).
 * The column holds them all from the 400 px default sidebar up, under half the
 * card where it is narrower; the ICAO advisory under its box follows it. */
describe('the Aircraft card’s label column', () => {
	it('holds the longest French label at the default sidebar, under half a narrower card', () => {
		expect(decls(AIRCRAFT, '.card', [])['--label-w']).toBe('clamp(96px, 44%, 150px)');
		expect(decls(AIRCRAFT, '.field > span:first-child', [])).toMatchObject({ flex: '0 0 var(--label-w)' });
		expect(decls(AIRCRAFT, '.icao-unknown', []).margin).toBe('-4px 0 0 calc(var(--label-w) + 8px)');
	});
});
