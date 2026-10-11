/* Types for gen-aircraft-meta.js, so tests/aircraftMeta.spec.ts can rebuild
 * the aircraft library's index and compare it with the committed one without
 * linting `any`. The script itself stays plain JS: it is repo tooling and
 * lives outside the app tsconfig, like scripts/gen-privacy.js. */

/** A data sheet, by its path in the index (`f-gorq.yaml`,
 *  `generic/c172s.yaml`), and its text. */
export interface Sheet {
	path: string;
	text: string;
}

/** public/data/aircraft.meta.json as the script writes it. */
export interface AircraftIndex {
	generatedAt: string;
	digest: string;
	source?: string;
	aircraftCount: number;
	files: string[];
	counts: Record<string, number>;
	generic?: {
		source?: string;
		files: string[];
		counts: Record<string, number>;
	};
}

/** The sheets under the library's directory (by default the repo's), sorted
 *  by path; throws on anything there that is no sheet. */
export function readSheets(dir?: string): Sheet[];

/** The index the sheets make, the previous one's prose kept, and its
 *  `generatedAt` while the sheets' values are the same; throws, naming the
 *  sheet, on a sheet out of its place. */
export function buildMeta(sheets: Sheet[], previous: Partial<AircraftIndex> | null, now: Date | number | string): AircraftIndex;

/** The index's file text, byte for byte. */
export function renderMeta(meta: AircraftIndex): string;

/** The library file name of a plane exported from the app; throws on a
 *  generic sheet or a plane without a registration. */
export function promotionTarget(text: string, source?: string): string;
