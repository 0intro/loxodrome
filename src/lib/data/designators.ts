/* Loader and types for the FAA aircraft type designator catalog
 * (public/data/faa-designators.json), built by cmd/designators from FAA
 * Order JO 7360.1 ("Aircraft Type Designators"; a US Government work, so
 * public domain, unlike ICAO Doc 8643 itself, which is not
 * redistributable). Backs the aircraft editor's icaoType suggestions and
 * the soft unknown-designator warnings. The order covers the types
 * commonly receiving ATC services, a SUBSET of Doc 8643, so absence from
 * this catalog is advisory, never an error. */

export interface DesignatorType {
	/** ICAO type designator, e.g. "DR40". */
	code: string;
	/** Manufacturer as the order prints it, e.g. "ROBIN"; the generic
	 *  designators (GLID, ULAC, ZZZZ, ...) carry "(any manufacturer)". */
	manufacturer: string;
	/** Model name, e.g. "DR-400 2+2". */
	model: string;
}

// Positional tuple layout, matching Artifact.Types in
// cmd/designators/build.go. Keep the two in lockstep.
type FaaDesignatorRow = readonly [code: string, manufacturer: string, model: string];

interface RawFaaDesignators {
	designators: string[];
	types: readonly FaaDesignatorRow[];
}

export interface FaaDesignators {
	/** Sorted unique designator codes: the validation set. A code can lack
	 *  model rows (centre-wrapped source lines); it is still valid. */
	designators: string[];
	/** One row per (designator, manufacturer, model): the suggestion source. */
	types: DesignatorType[];
}

export const FAA_DESIGNATORS_URL = '/data/faa-designators.json';

/** Load the FAA designator catalog. Throws on a missing / non-JSON file;
 *  the state layer resets its cache so a later editor open retries. */
export async function loadFaaDesignators(
	url: string = FAA_DESIGNATORS_URL,
): Promise<FaaDesignators> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`${url}: HTTP ${res.status}`);
	}
	const ct = res.headers.get('content-type') ?? '';
	if (!ct.includes('json')) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error(`${url}: not JSON (got ${ct || 'no content-type'})`);
	}
	const data = (await res.json()) as RawFaaDesignators;
	return {
		designators: data.designators,
		types: data.types.map((r) => ({ code: r[0], manufacturer: r[1], model: r[2] })),
	};
}
