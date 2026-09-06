/* Pins the pure resolvers of natureSymbols.ts: every family draws in the
 * one SIA 500k chart red (the SHAPE tells them apart, incl. the Belgian
 * BIRD reuse of the NATURE bullseye), and the fixed glyph half-extent that
 * drives hit-testing. drawNatureSymbol builds Path2D and stays untested
 * here. */

import { describe, expect, it } from 'vitest';
import { NATURE_COLOR, natureSymbolSize } from '$lib/map/natureSymbols';
import { SIA } from '$lib/map/airspaceSymbology';

describe('NATURE_COLOR', () => {
	it('uses the SIA 500k chart red for every family', () => {
		// Legende2026 prints the parc/reserve bullseye in the chart red
		// #E30613 (GEN 2.3 prints magenta #DF0051; the decision for the
		// chart red is recorded in docs/airspace-symbology.md).
		expect(NATURE_COLOR.NATURE).toBe('#E30613');
		expect(NATURE_COLOR.SENSITIVE).toBe('#E30613');
		// BIRD intentionally reuses the NATURE ink (no dedicated chart glyph).
		expect(NATURE_COLOR.BIRD).toBe('#E30613');
		// The same ink as the airspace R / D zone red, by construction.
		expect(NATURE_COLOR.NATURE).toBe(SIA.zone);
	});
});

describe('natureSymbolSize', () => {
	it('is the fixed 8 px half-extent', () => {
		expect(natureSymbolSize()).toBe(8);
	});
});
