/* The offline manager (docs/offline-maps.md): the download queue, the chart
 * and AIP document packs, the terrain pinned for a plan, and what all of it
 * occupies on the device. Its own domain rather than a corner of `layers`,
 * because the subject is storage rather than what the map draws, and it is
 * now read from four places (the manager, the Layers tab's chip, the Route
 * tab's terrain row and the toolbar).
 *
 * Locale-invariant and so absent here: the chart product names (from
 * CHART_LAYERS), the AIRAC cycle, and formatPackBytes's GB / MB tokens. */

import { plural } from './plural';

export const offline = {
	// The surface, and the ways in
	title: 'Offline data',
	manage: 'Manage offline data',
	heldSummary: (p: { packs: number; size: string }) =>
		`${p.packs} ${plural(p.packs, 'download', 'downloads')} stored, ${p.size}`,
	nothingHeld: 'Nothing downloaded yet',
	webOnly:
		'Downloads are made in the Android application, which can promise the files will still be there at the aerodrome. A copy already downloaded keeps working here.',
	heldChip: 'Offline',
	heldChipTip: (date: string) => `Drawn from the offline copy of ${date}`,

	// The queue
	queueTotal: (p: { jobs: number; size: string }) =>
		`${p.jobs} ${plural(p.jobs, 'download', 'downloads')} queued, ${p.size} remaining.`,
	queueTotalUnknown: (p: { jobs: number; size: string; unknown: number }) =>
		`${p.jobs} ${plural(p.jobs, 'download', 'downloads')} queued, ${p.size} remaining and ${p.unknown} of unknown size.`,
	queueTotalUnknownOnly: (jobs: number) =>
		`${jobs} ${plural(jobs, 'download', 'downloads')} queued, total size unknown.`,
	queueOverflow: (free: string) =>
		`The queue does not fit: only ${free} free on this device.`,
	queued: 'Waiting',
	queuedAt: (n: number) => `Waiting, ${n} ahead`,
	removeFromQueue: 'Remove',
	stopAll: 'Stop all downloads',
	stopAllConfirm:
		'Stop every download and empty the queue? What has already been downloaded is kept, and a paused download resumes where it stopped.',
	wakeNote: 'Keep the screen on: a download is suspended while the screen is off.',

	// Row actions and states
	download: 'Download',
	update: 'Update',
	delete: 'Delete',
	discard: 'Discard',
	retry: 'Retry',
	pause: 'Pause',
	resume: 'Resume',
	downloading: 'Downloading',
	held: (p: { date: string; size: string }) => `Offline copy ${p.date}, ${p.size}`,
	paused: (p: { pct: number; done: string; total: string }) =>
		`Paused at ${p.pct} %, ${p.done} of ${p.total} kept`,
	figures: (p: { pct: number; done: string; total: string }) =>
		`${p.pct} %, ${p.done} of ${p.total}`,
	progressAria: (name: string) => `Downloading ${name}`,
	updateAvailable: 'New edition available',
	updatesAvailable: (n: number) => `${n} ${plural(n, 'update', 'updates')} available`,
	updateAll: (p: { n: number; size: string }) => `Update all (${p.n}, ${p.size})`,
	deleteConfirm: (p: { name: string; size: string }) =>
		`Delete the offline copy of ${p.name} (${p.size})? It can be downloaded again.`,
	discardConfirm: (p: { name: string; size: string }) =>
		`Discard the ${p.size} already downloaded of ${p.name}? The download would start again from the beginning.`,
	errors: {
		download: 'Download failed. Check the connection and retry.',
		quota: 'Not enough free storage on this device.',
		unpublished: 'Not published on the server yet.',
		unsupported: 'Offline storage is not supported by this browser.',
	},

	// Aeronautical charts
	chartsLegend: 'Aeronautical charts',
	chartsNote: 'A downloaded chart is drawn from this device and needs no connection.',

	// AIP documents
	docsLegend: 'AIP documents',
	docsVac: 'VAC charts',
	docsVacNote: 'Visual approach charts for every French aerodrome and helistation.',
	docsSup: 'AIP Supplements in force',
	docsSupLang: (lang: string) => `in ${lang}`,
	docsNextCycle: (cycle: string) => `Next AIRAC cycle, ${cycle}`,
	docsStored: (p: { files: number; size: string; date: string }) =>
		`${p.files} documents, ${p.size}, ${p.date}`,
	docsStale: (cycle: string) => `AIRAC cycle ${cycle}, superseded`,
	docsMissing: (n: number) =>
		`${n} ${plural(n, 'document', 'documents')} not published by the SIA`,

	// Terrain
	terrainLegend: 'Terrain for this plan',
	terrainSubject: 'Route corridors',
	terrainScope: (p: { routes: number; radius: number; tiles: number; size: string }) =>
		`${p.routes} ${plural(p.routes, 'route', 'routes')}, ${p.radius} NM corridor, ${p.tiles} tiles, about ${p.size}`,
	terrainDownload: 'Download terrain for this plan',
	terrainPinnedLine: (p: { tiles: number; size: string; date: string }) =>
		`Offline terrain: ${p.tiles} tiles, ${p.size}, ${p.date}`,
	terrainTip:
		'Store the elevation tiles of every corridor of this plan, so minimum altitudes, the vertical profile and terrain alerts keep working offline',
	terrainNoRoute: 'Plan a route of at least two waypoints to pin its terrain.',
	terrainRemoveConfirm:
		'Remove the terrain pinned for this plan? Minimum altitudes, the vertical profile and terrain alerts would need a connection again.',

	// Storage
	storageLegend: 'Storage',
	storageUsed: (size: string) => `Used by Loxodrome: ${size}`,
	storageFree: (size: string) => `Free on this device: ${size}`,
	storageUnknown: 'This browser does not report how much storage is in use.',
	storageCharts: 'Aeronautical charts',
	storageDocs: 'AIP documents',
	storageTerrain: 'Terrain',
	storageTiles: 'Cached map tiles',
	storageTilesNote:
		'What you have viewed keeps working offline; cleared automatically when the cache is full.',
	clear: 'Clear',
	clearTilesConfirm: 'Clear the cached map tiles? Downloaded packs are not affected.',
};
