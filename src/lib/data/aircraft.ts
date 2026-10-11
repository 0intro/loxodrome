/* Loader for the committed aircraft library: aircraft.meta.json (see
 * $lib/data/meta) names the per-plane YAML data sheets under /data/aircraft/,
 * each parsed by $lib/aircraft/schema: the clubs' aircraft (`files`) and the
 * generic sheets (`generic.files`, listed apart so an older app, which reads
 * `files` alone, never meets one). The promise is cached (cleared on
 * rejection so a retry is possible); a bad committed file rejects with
 * `<file>: <message>` so the Aircraft tab can surface which sheet broke. */

import { parseAircraftYaml, aircraftKey, type Aircraft } from '$lib/aircraft/schema';
import { loadAircraftMeta } from './meta';
import { readDataText } from '$lib/data/fetchData';

export const AIRCRAFT_DIR_URL = '/data/aircraft/';

export interface CommittedAircraft {
	file: string;
	aircraft: Aircraft;
}

let committedPromise: Promise<CommittedAircraft[]> | null = null;

/** One sheet's text. No content-type check: servers type .yaml
 *  inconsistently, and a missing file served as the SPA fallback HTML fails
 *  the YAML parse with a readable error. Rejects on any failure, a
 *  transient one saying so (src/lib/data/fetchData.ts). */
function fetchText(path: string): Promise<string> {
	return readDataText(path);
}

/** A generic sheet's id is its file name: `generic/c172s.yaml` holds
 *  `generic: c172s`, which keeps the ids unique by construction. */
function genericIdOf(file: string): string {
	return file.replace(/^.*\//, '').replace(/\.ya?ml$/, '');
}

async function loadAll(): Promise<CommittedAircraft[]> {
	const meta = await loadAircraftMeta();
	const listed = [
		...meta.files.map((file) => ({ file, generic: false })),
		...(meta.generic?.files ?? []).map((file) => ({ file, generic: true })),
	];
	const out = await Promise.all(
		listed.map(async ({ file, generic }) => {
			const text = await fetchText(`${AIRCRAFT_DIR_URL}${file}`);
			let aircraft: Aircraft;
			try {
				aircraft = parseAircraftYaml(text);
			} catch (e) {
				throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
			}
			// i18n-ignore-start: committed-dataset integrity diagnostics, stay EN (docs/i18n.md rule 7)
			if (generic && aircraft.identity.generic !== genericIdOf(file)) {
				throw new Error(`${file}: a generic sheet states aircraft.generic: ${genericIdOf(file)}`);
			}
			if (!generic && aircraft.identity.generic !== undefined) {
				throw new Error(`${file}: a generic sheet is listed under generic.files, not files`);
			}
			// i18n-ignore-end
			return { file, aircraft };
		}),
	);
	const seen = new Set<string>();
	for (const { file, aircraft } of out) {
		const key = aircraftKey(aircraft);
		if (seen.has(key)) {
			// i18n-ignore: committed-dataset integrity diagnostic, stays EN (docs/i18n.md rule 7)
			throw new Error(`${file}: duplicate aircraft key ${key}`);
		}
		seen.add(key);
	}
	return out;
}

/** Cached fetch + parse of every committed aircraft data sheet. */
export function loadCommittedAircraft(): Promise<CommittedAircraft[]> {
	if (!committedPromise) {
		committedPromise = loadAll().catch((e: unknown) => {
			committedPromise = null;
			throw e;
		});
	}
	return committedPromise;
}
