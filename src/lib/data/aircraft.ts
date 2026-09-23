/* Loader for the committed aircraft library: aircraft.meta.json (see
 * $lib/data/meta) names the per-plane YAML data sheets under /data/aircraft/,
 * each parsed by $lib/aircraft/schema. The promise is cached (cleared on
 * rejection so a retry is possible); a bad committed file rejects with
 * `<file>: <message>` so the Aircraft tab can surface which sheet broke. */

import { parseAircraftYaml, aircraftKey, type Aircraft } from '$lib/aircraft/schema';
import { loadAircraftMeta } from './meta';

export const AIRCRAFT_DIR_URL = '/data/aircraft/';

export interface CommittedAircraft {
	file: string;
	aircraft: Aircraft;
}

let committedPromise: Promise<CommittedAircraft[]> | null = null;

async function fetchText(path: string): Promise<string> {
	const res = await fetch(path);
	if (!res.ok) {
		throw new Error(`${path}: HTTP ${res.status}`);
	}
	// No content-type check: servers type .yaml inconsistently. A missing file
	// served as the SPA fallback HTML fails the YAML parse with a readable error.
	return res.text();
}

async function loadAll(): Promise<CommittedAircraft[]> {
	const meta = await loadAircraftMeta();
	const out = await Promise.all(
		meta.files.map(async (file) => {
			const text = await fetchText(`${AIRCRAFT_DIR_URL}${file}`);
			try {
				return { file, aircraft: parseAircraftYaml(text) };
			} catch (e) {
				throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
			}
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
