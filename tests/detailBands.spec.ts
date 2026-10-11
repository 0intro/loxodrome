/* The detail panel runs its bands to its edges, the phone's detail sheet's
 * rule (docs/workspace-surfaces.md "A section is flat"): the METAR and the TAF
 * are bands, not cards inside the panel's box, the runway and frequency tables
 * reach both edges, their outer cells inset by the panel's own padding, which
 * the panel publishes as --detail-pad. Raw text (a NOTAM's, a SIGMET's, the
 * text inside a NOTAM card) reads apart by its fill, not by a second stroke.
 * All screen only, paper keeping its cards and strokes. The same components
 * render in the desktop panel (aside.detail) and the phone sheet
 * (.detail-box), so each bleeder carries both in ONE rule. */

import { describe, expect, it } from 'vitest';

import { cssRulesOf } from './helpers/cssRules';

const BLEEDERS = [
	'src/lib/components/detail/AirportDetail.svelte',
	'src/lib/components/detail/FrequencyList.svelte',
	'src/lib/components/detail/SupAipDetail.svelte',
	'src/lib/components/detail/MetarReadout.svelte',
	'src/lib/components/detail/WeatherSection.svelte',
];

describe('the detail panel runs its bands to its edges', () => {
	it('publishes its own inline padding as the bleed, on screen only', () => {
		const rules = cssRulesOf('src/lib/components/DetailPanel.svelte');
		const base = rules.find((r) => r.selectors.includes('.detail-scroll') && r.parents.length === 0 && r.decls.has('padding'));
		const pad = rules.filter((r) => r.selectors.includes('.detail-scroll') && r.decls.has('--detail-pad'));
		expect(pad.length).toBe(1);
		expect(pad[0].parents).toEqual(['@media screen']);
		expect(pad[0].decls.get('--detail-pad')).toBe(base?.decls.get('padding'));
	});

	for (const file of BLEEDERS) {
		it(`${file.split('/').pop()} bleeds in the panel wherever it bleeds in the sheet, in one rule`, () => {
			const sheet = cssRulesOf(file).filter((r) => r.selectors.some((s) => s.startsWith(':global(.detail-box) ')));
			expect(sheet.length).toBeGreaterThan(0);
			for (const r of sheet) {
				expect(r.parents).toEqual(['@media screen']);
				for (const s of r.selectors.filter((x) => x.startsWith(':global(.detail-box) '))) {
					expect(r.selectors, s).toContain(s.replace(':global(.detail-box) ', ':global(aside.detail) '));
				}
			}
		});
	}
});

describe('raw text reads apart by its fill on screen, its stroke on paper', () => {
	const RAW: [string, string][] = [
		['src/lib/components/detail/NotamDetail.svelte', '.raw pre'],
		['src/lib/components/detail/SigmetDetail.svelte', '.raw'],
		['src/lib/components/detail/NotamCardList.svelte', '.notam-raw'],
	];
	for (const [file, sel] of RAW) {
		it(`${file.split('/').pop()}'s ${sel}`, () => {
			const rules = cssRulesOf(file).filter((r) => r.selectors.includes(sel));
			const base = rules.find((r) => r.parents.length === 0);
			expect(base?.decls.get('border')).toBe('1px solid var(--border)');
			expect(base?.decls.has('background')).toBe(true);
			const screen = rules.filter((r) => r.parents.includes('@media screen'));
			expect(screen.length).toBe(1);
			expect(screen[0].decls.get('border-color')).toBe('transparent');
		});
	}
});
