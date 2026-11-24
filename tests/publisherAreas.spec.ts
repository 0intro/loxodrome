/* Every publisher's own territory holds every piece its committed datasets
 * occupy ($lib/data/publishers.ts PublisherSpec.area).
 *
 * The area is what the coverage gate judges a country on when its sidecar
 * did not answer (state/coverage.svelte.ts publisherInCoverage): the country
 * still loads, and whether its failure is named and counted, by the banner,
 * the alert caveats, the prints and the detail panel, is read from where the
 * publisher is. Before it, such a failure was never counted: a blip that
 * took France's sidecar and its data file together left the alerts over
 * Paris with no caveat. An area narrower than the data would put that blind
 * spot back for the piece it misses, so a dataset that grows past its
 * publisher's area fails here until the area is widened. */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUBLISHER_TABLE, isPublisher, publisherArea } from '$lib/data/publishers';

const DIR = new URL('../public/data/', import.meta.url);

type Box = readonly [number, number, number, number];

function inside(piece: Box, area: Box): boolean {
	return piece[0] >= area[0] && piece[1] >= area[1] && piece[2] <= area[2] && piece[3] <= area[3];
}

const sidecars = readdirSync(DIR).filter((f) => f.endsWith('.meta.json'));

describe('the publishers areas', () => {
	it('are stated for every publisher', () => {
		for (const row of PUBLISHER_TABLE) {
			expect(row.area.length, row.id).toBeGreaterThan(0);
			for (const b of row.area) {
				expect(b[0] <= b[2] && b[1] <= b[3], `${row.id} ${String(b)}`).toBe(true);
			}
		}
	});

	it('hold every piece of every committed sidecar', () => {
		let checked = 0;
		for (const file of sidecars) {
			const id = file.split('-')[0];
			if (!isPublisher(id)) {
				continue;
			}
			const meta = JSON.parse(readFileSync(new URL(file, DIR), 'utf8')) as {
				bbox?: Box;
				bboxes?: Box[];
			};
			const pieces = meta.bboxes && meta.bboxes.length > 0 ? meta.bboxes : meta.bbox ? [meta.bbox] : [];
			for (const piece of pieces) {
				checked++;
				expect(
					publisherArea(id).some((a) => inside(piece, a)),
					`${file}: ${JSON.stringify(piece)} outside ${id}'s area`,
				).toBe(true);
			}
		}
		// The check reads the committed data, never nothing.
		expect(checked).toBeGreaterThan(100);
	});
});
