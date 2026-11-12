/* A runway pick no longer published says so (flightprep/PerformancePage).
 * The page falls back to the automatic into-wind choice when the stored
 * pick resolves to nothing (a dataset release dropping the runway it was
 * made at: LIAF's glider strip withdrawn), which may be the opposite end,
 * and the select showed it as the pilot's own, with no note on screen or
 * on paper. Pinned by its source, the page's idiom (closureInstantSurfaces):
 * it needs a DOM and a flight preparation to render. The fallback itself is
 * pickedRunwayEnd's, pinned in aircraftAerodromes.spec. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { flightprep as en } from '$lib/i18n/en/flightprep';
import { flightprep as fr } from '$lib/i18n/fr/flightprep';

const page = readFileSync('src/lib/components/flightprep/PerformancePage.svelte', 'utf8');

describe('a runway pick no longer published', () => {
	it('is told apart from one that holds, by resolving the stored pick', () => {
		expect(page).toContain(
			'return cell.block.runwayEnd != null && pickedRunwayEnd(cell.ends, cell.block.runwayEnd) != null;',
		);
	});

	it('says so in the select title and marks the select', () => {
		expect(page).toContain(
			'const auto = cell.block.runwayEnd != null ? t.flightprep.rwyPickLostTip : t.flightprep.rwyAutoTip;',
		);
		expect(page).toContain('class:lost={cell.block.runwayEnd != null && !pickHolds(cell)}');
		expect(page).toMatch(/\.rwy\.lost \{\s*color: var\(--workbook-orange\);/);
	});

	it('is worded in both languages', () => {
		expect(en.rwyPickLostTip).toMatch(/no longer published/);
		expect(fr.rwyPickLostTip).toMatch(/n’est plus publiée/);
	});
});
