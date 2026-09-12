/* What the Flights surface writes out (docs/flights-library.md).
 *
 * Four artefacts and one bundle that is their union. They live together
 * because the bundle MUST be assembled from the very recipes the individual
 * exports use: a bundle whose logbook resolved its registrations differently
 * from the CSV button, or whose traces were named differently from the row
 * downloads, would be a second implementation of the library's own output and
 * would drift from it.
 *
 * The bundle is deliberately NOT a format. It carries no manifest and no
 * version: it is a ZIP of files this application already writes, and the
 * batch importer already reads every one of them by sniffing its content. So
 * there is nothing to keep in step on the way back in, and a bundle opened by
 * a tool that is not this application is just a folder of traces, YAML and a
 * CSV.
 *
 * What each member is for:
 *
 *  - the traces: the flights themselves, each in ITS OWN format
 *    (state/traceFile.ts). Everything the library derives from them - block
 *    times, landings, night, places - is thrown away on import and rebuilt,
 *    so none of it is carried.
 *  - logbook.csv: the one member that is not redundant. It carries the rows
 *    with no trace behind them (an imported club logbook's history and its
 *    pilot-DECLARED cells, which this application may not invent), and the
 *    per-row registration, which lands back on the trace rows through the
 *    importer's own overlap backfill, whatever format the traces are in.
 *  - plans/: without them the importer matches nothing and every restored
 *    flight arrives with an empty Route cell.
 *  - aircraft/: USER-authored sheets only. The library fleet ships with the
 *    application, and a sheet takes real work to get right.
 *
 * Everything here reads the STORE, never the surface's listings
 * (`flightLibrary.rows`, `planCatalog.rows`). Those fill lazily and per view -
 * the plan listing only runs while the Plans view is up - so an export driven
 * off them wrote a bundle with no plans in it at all. Kicking the listings
 * first is not a fix either: both coalesce, so awaiting one that is already
 * in flight returns at once and hands back exactly the rows that were not
 * ready. Reading the store is race-free by construction, and it makes the
 * bundle independent of which view happened to be open.
 */

import { aircraftFileName, stringifyAircraftYaml } from '$lib/aircraft/schema';
import { buildLogbookCsv } from '$lib/nav/logbook';
import { uniqueEntryName, type ZipEntry } from '$lib/files/zip';
import { APP_SUBJECT, fileName, fileStampUtc, fileStem } from '$lib/files/fileName';
import { aircraftByKey, aircraftState } from './aircraft.svelte';
import { ensureAirports, ensureNavaids } from './data.svelte';
import { getMetas, getStoredPlans, type OutingMeta } from './flightsDb';
import { ensureFaaDesignators, searchDesignators } from './referenceData.svelte';
import { flightLinks } from './flightLinks.svelte';
import { flightPrep } from './flightPrep.svelte';
import { libraryLogbookRows } from './flightRows';
import { derivePlanRow, nextPlanName } from './planRows';
import { resolveWaypointToken } from './waypointSearch.svelte';
import { traceFileFor } from './traceFile';

/** Every filed trace as its own archive member, each in the format it is
 *  actually stored as, so one archive mixes GPX, IGC and KML freely. Names
 *  come from the files themselves and are deduped IN the archive: two
 *  imports called "track.gpx" are two different flights. */
export async function buildTraceEntries(prefix = ''): Promise<ZipEntry[]> {
	const entries: ZipEntry[] = [];
	const taken: string[] = [];
	for (const meta of await libraryMetas()) {
		const file = await traceFileFor(meta);
		if (!file) {
			continue; // a logbook row, or points that are gone
		}
		const name = uniqueEntryName(file.filename, taken);
		taken.push(name);
		entries.push({ name: prefix + name, data: file.data, mtimeMs: meta.id });
	}
	return entries;
}

/** The AMC CSV over every flight in the library, decorated at export time
 *  (the library stores no record semantics: make / registration / pilot are
 *  resolved now, docs/logbook.md). Null when there is nothing to write.
 *  `atMs` is the FIRST listed flight's block-off, which is what the standalone
 *  download names the file after. */
export async function buildLibraryCsv(): Promise<{ text: string; atMs: number } | null> {
	const metas = await libraryMetas();
	try {
		await ensureFaaDesignators();
	} catch {
		/* the make cells stay blank */
	}
	const make = (key: string | null): string => {
		const icao = key ? aircraftByKey(key)?.identity.icaoType?.toUpperCase() : undefined;
		const row = icao ? searchDesignators(icao, 12).find((r) => r.code === icao) : undefined;
		return row && !row.manufacturer.startsWith('(') ? row.manufacturer : '';
	};
	const rows = libraryLogbookRows(metas, {
		make,
		model: (key) => (key ? (aircraftByKey(key)?.identity.type ?? '') : ''),
		registration: (key) => (key ? (aircraftByKey(key)?.identity.registration ?? key) : ''),
		picName: flightPrep.dossier.pilot.name.trim() || 'SELF',
		labelsFor: (id) => flightLinks.byOuting[id]?.labels ?? null,
	});
	const first = rows[0];
	return first ? { text: buildLogbookCsv(rows), atMs: first.slice.blockOffMs } : null;
}

/** The library's meta rows, newest first (the listing's own order), read from
 *  the store. */
async function libraryMetas(): Promise<OutingMeta[]> {
	const metas = await getMetas();
	metas.sort((a, b) => b.id - a.id);
	return metas;
}

/** Every remembered plan, read from the store. File names are GENERATED from
 *  each plan's route (its identity) through the catalog's own derivation,
 *  deduped inside the archive.
 *
 *  The datasets are warmed first because the name comes from RESOLVED
 *  waypoints; if they refuse, only the NAME degrades to a bare "plan.yaml"
 *  (the subject field falls away, docs/file-names.md). The yaml is copied
 *  verbatim either way, so an offline export still carries every plan
 *  intact. */
export async function buildPlanEntries(prefix = ''): Promise<ZipEntry[]> {
	try {
		await Promise.all([ensureAirports(), ensureNavaids()]);
	} catch {
		/* the names degrade; the plans themselves do not */
	}
	const stored = await getStoredPlans();
	stored.sort((a, b) => b.savedAtMs - a.savedAtMs);
	const taken: string[] = [];
	return stored.map((p) => {
		const { baseName } = derivePlanRow(p.yaml, resolveWaypointToken);
		const name = nextPlanName(fileStem([baseName, 'plan']), taken);
		taken.push(name);
		return { name: prefix + name, data: p.yaml, mtimeMs: p.savedAtMs };
	});
}

/** The USER's own data sheets, named as the Aircraft tab names them. */
export function buildAircraftEntries(prefix = ''): ZipEntry[] {
	const taken: string[] = [];
	return Object.entries(aircraftState.user).map(([key, a]) => {
		// Deduped like every other member: two user keys differing only in
		// punctuation slug to the same name, and one would silently replace
		// the other in the archive.
		const name = uniqueEntryName(aircraftFileName(key), taken);
		taken.push(name);
		return { name: prefix + name, data: stringifyAircraftYaml(a) };
	});
}


/** The whole library as one archive's worth of entries. Empty when the
 *  library holds nothing to write, which the caller reports rather than
 *  producing a file with nothing in it. */
export async function buildFlightBundle(): Promise<ZipEntry[]> {
	const traces = await buildTraceEntries();
	const csv = await buildLibraryCsv();
	const entries: ZipEntry[] = [...traces];
	if (csv) {
		entries.push({ name: 'logbook.csv', data: csv.text });
	}
	entries.push(...(await buildPlanEntries('plans/')), ...buildAircraftEntries('aircraft/'));
	return entries;
}

/** The bundle's own file name. The whole library rather than one flight, so
 *  the subject is the application itself (docs/file-names.md). */
export function bundleFileName(atMs: number): string {
	return fileName([APP_SUBJECT, 'flights', fileStampUtc(atMs)], 'zip');
}
