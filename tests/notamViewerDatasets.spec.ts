/* What the NOTAM Viewer READS, against what it can ask for.
 *
 * The manifest stopped being a copy list when the app moved inside Loxodrome's
 * site: its dataset paths are root-absolute, so at /notam/ they read the
 * surrounding site's own /data/ and nothing is duplicated. What the list still
 * states, and what this file still guards, is which datasets the app reaches
 * for; tests/notamViewerSite.spec.ts checks the built site ships each of them.
 *
 * The failure guarded here is silent and total. Roughly fifteen of the sidecar
 * loaders in src/lib/data/meta.ts are metaLoader rather than optionalMetaLoader,
 * and those THROW on a 404 instead of degrading; a dataset the app fetches and
 * the site does not carry takes the surface that fetched it with it. So the
 * test is behavioural, not structural: serve exactly what the manifest names,
 * 404 everything else, and drive the real ensure* functions.
 *
 * The complement matters just as much. A dataset the viewer deliberately does
 * NOT read (obstacles, navaids) must never be asked for, although the site it
 * is published in carries it: served the whole site, the shared NOTAM panel
 * once fetched 22 files the manifest does not name over Zurich and listed
 * obstacles from registers the About credits nowhere. And served nothing, it
 * must leave its lists empty, never crash the boot, because "no obstacle links
 * here" is an honest answer and a blank app is not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
	AD_CHART_CREDITS,
	AIP_CREDITS,
	NOTAM_VIEWER_DATASETS,
	viewerAdChartPrefixes,
	viewerDatasetPrefixes,
	viewerNationalPublishers,
} from '../src/notam/datasets';
import { en } from '../src/lib/i18n/en';
import { fr } from '../src/lib/i18n/fr';

const DATA_DIR = new URL('../public/data/', import.meta.url);

/** How each of the cold boot's five ensures settles with nothing served:
 *  airports, airspaces and SUP AIP refuse (their callers catch it and the
 *  shell mounts without them), obstacles and navaids degrade to empty. */
const COLD_BOOT: readonly PromiseSettledResult<unknown>['status'][] = [
	'rejected',
	'rejected',
	'rejected',
	'fulfilled',
	'fulfilled',
];

/** Serve the named paths off disk with a JSON content-type (which the loaders
 *  check), and 404 everything else. The content-type matters: without it
 *  fetchJSON throws "not JSON" and fetchOptionalJSON quietly answers null,
 *  which would make this file pass for the wrong reason. */
function serveOnly(paths: readonly string[]): void {
	const allow = new Set(paths);
	vi.stubGlobal('fetch', (input: string | URL): Promise<Response> => {
		const path = typeof input === 'string' ? input : input.pathname;
		if (!allow.has(path)) {
			return Promise.resolve(new Response('not found', { status: 404 }));
		}
		const body = readFileSync(new URL(path.replace('/data/', ''), DATA_DIR), 'utf8');
		return Promise.resolve(
			new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
		);
	});
}

/** Serve the whole data directory, as loxodrome.fr does to the viewer
 *  published inside it, recording every path asked for. */
function serveSite(asked: string[]): void {
	vi.stubGlobal('fetch', (input: string | URL): Promise<Response> => {
		const path = typeof input === 'string' ? input : input.pathname;
		asked.push(path);
		const file = new URL(path.replace('/data/', ''), DATA_DIR);
		if (!path.startsWith('/data/') || !existsSync(file)) {
			return Promise.resolve(new Response('not found', { status: 404 }));
		}
		return Promise.resolve(
			new Response(readFileSync(file, 'utf8'), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		);
	});
}

/** Let fire-and-forget loads run to their end. */
async function drain(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
}

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the shipped manifest', () => {
	it('names one AIRAC slot, not two', () => {
		// The pre-release tier is reached through optionalMetaLoader, which
		// answers null on a 404 rather than throwing, so it is not something
		// the app REQUIRES and has no business in a list of what must exist.
		// Note the consequence of the move: the surrounding site does ship both
		// slots, so pickActiveDataset now really does see the pre-release and
		// the viewer follows the cycle instead of waiting for a republish.
		expect(NOTAM_VIEWER_DATASETS.filter((p) => p.includes('.next.'))).toEqual([]);
	});

	it('ships a sidecar for every dataset', () => {
		// The sidecar carries the effective date AND the bbox the coverage gate
		// reads. Without it the dataset loads everywhere, which is a different
		// app from the one that loads by area.
		const missing = NOTAM_VIEWER_DATASETS.filter(
			(p) => !p.endsWith('.meta.json') && !NOTAM_VIEWER_DATASETS.includes(p.replace('.json', '.meta.json')),
		);
		expect(missing).toEqual([]);
	});

	it('credits every publisher it reads from', () => {
		// The About page names viewerNationalPublishers() and, beside them,
		// OurAirports and EUROCONTROL's pruatlas, and lists every source's own
		// terms. This pins the derivation, so a dataset added above cannot ship
		// uncredited. It has been missed once already: the first About named
		// neither of those two.
		const national = viewerNationalPublishers();
		const unknown = national.filter((k) => !(k in en.layers.publisherNames));
		expect(unknown).toEqual([]);

		// Nothing falls between the groups. A prefix that is neither a
		// publisher key nor one of the named exceptions would vanish from the
		// credits silently, which is the failure that matters.
		const accounted = new Set<string>([...national, 'airports', 'pruatlas', 'it']);
		expect(viewerDatasetPrefixes().filter((p) => !accounted.has(p))).toEqual([]);

		// And the exceptions really are read, or the About credits sources
		// this app does not carry, which is the mirror failure.
		expect(viewerDatasetPrefixes()).toContain('airports');
		expect(viewerDatasetPrefixes()).toContain('pruatlas');
	});

	it('never counts open flightmaps among the national services', () => {
		// Italy's files are community data, not the Italian AIP: named among the
		// national services, the page said ENAV published them.
		expect(viewerDatasetPrefixes()).toContain('it');
		expect(viewerNationalPublishers()).not.toContain('it');
		expect(en.about[AIP_CREDITS.it.license]).toContain('not published by ENAV');
	});

	it("has each source's own terms to print", () => {
		// The Licence Ouverte asks for the SIA and the edition date, GeoNutzV
		// for "(modified)", LVNL for CC BY 4.0 and Austro Control for its
		// permission: a list of countries passed on none of them. Every AIP
		// source but the two credited in their own sentence, and every chart
		// catalog, has a credit, whose lines exist in both catalogs.
		const aip = viewerDatasetPrefixes().filter((p) => p !== 'airports' && p !== 'pruatlas');
		expect(aip.filter((p) => !AIP_CREDITS[p])).toEqual([]);
		expect(viewerAdChartPrefixes().sort()).toEqual(['at', 'de', 'fr', 'uk', 'us']);
		expect(viewerAdChartPrefixes().filter((p) => !AD_CHART_CREDITS[p])).toEqual([]);
		for (const c of [...Object.values(AIP_CREDITS), ...Object.values(AD_CHART_CREDITS)]) {
			for (const key of [c.head, c.license]) {
				expect(typeof en.about[key], key).toBe('string');
				expect(typeof fr.about[key], key).toBe('string');
			}
			expect(c.href).toMatch(/^https:\/\//);
		}
		expect(en.about[AIP_CREDITS.fr.license]).toContain('Licence Ouverte');
		expect(en.about[AIP_CREDITS.de.license]).toContain('(modified)');
		expect(en.about[AIP_CREDITS.nl.license]).toContain('CC BY 4.0');
		expect(en.about[AIP_CREDITS.at.license]).toContain('permission');
	});

	it('names only files that exist', () => {
		const absent = NOTAM_VIEWER_DATASETS.filter(
			(p) => !statSync(new URL(p.replace('/data/', ''), DATA_DIR), { throwIfNoEntry: false }),
		);
		expect(absent).toEqual([]);
	});

	it('stays the size it was measured at', () => {
		// 32.6 MB when this was written, 34 MB with the chart catalogs the
		// airport panel links from. No longer a download the app makes up
		// front, since these are the surrounding site's files and load on
		// demand by area; kept because the number is still what a phone pays
		// for a continental briefing, and a quietly added dataset is worth
		// seeing.
		const bytes = NOTAM_VIEWER_DATASETS.reduce(
			(n, p) => n + statSync(new URL(p.replace('/data/', ''), DATA_DIR)).size,
			0,
		);
		expect(bytes / 1048576).toBeLessThan(36);
		// And the list itself: 41 datasets and their sidecars.
		expect(NOTAM_VIEWER_DATASETS).toHaveLength(82);
	});
});

describe('the app against the manifest', () => {
	it('loads what it ships', async () => {
		serveOnly(NOTAM_VIEWER_DATASETS);
		const data = await import('$lib/state/data.svelte');
		await expect(data.ensureAirports()).resolves.toBeDefined();
		await expect(data.ensureAirspaces()).resolves.toBeDefined();
		await expect(data.ensureSupaip()).resolves.toBeDefined();
		expect(data.dataState.airportsLoaded).toBe(true);
		expect(data.dataState.airspacesLoaded).toBe(true);
		expect(data.dataState.supaipLoaded).toBe(true);
		// The chart catalogs the shared airport panel reads for its links, each
		// answering its own publisher's main aerodrome. The loaders are
		// fail-soft, a missing file reading as an empty catalog, so only an
		// answer shows the file was there.
		await Promise.all([
			data.ensureFrAdCharts(),
			data.ensureUkAdCharts(),
			data.ensureUsAdCharts(),
			data.ensureDeAdCharts(),
			data.ensureAtAdCharts(),
		]);
		expect(data.frAdChartsForIdent('LFPG').length).toBeGreaterThan(0);
		expect(data.ukAdChartsForIdent('EGLL').length).toBeGreaterThan(0);
		expect(data.usAdChartsForIdent('KJFK').length).toBeGreaterThan(0);
		expect(data.deAdLinkForIdent('EDDF')).not.toBeNull();
		expect(data.atAdLinksForIdent('LOWW')).not.toBeNull();
	});

	it('answers empty for what it does not read, rather than failing', async () => {
		serveOnly(NOTAM_VIEWER_DATASETS);
		const data = await import('$lib/state/data.svelte');
		// Obstacles and navaids are the two the relationship mechanisms would
		// use and this app does not read. Asked for anyway, their lists must
		// come back empty.
		await expect(data.ensureObstacles()).resolves.toEqual([]);
		await expect(data.ensureNavaids()).resolves.toEqual([]);
	});

	it('comes up at all with nothing served', async () => {
		// The cold case: a site whose data directory failed to publish. Every
		// ensure must settle so the shell mounts and the paste box works; a
		// briefing with no context is still a briefing.
		serveOnly([]);
		const data = await import('$lib/state/data.svelte');
		const settled = await Promise.allSettled([
			data.ensureAirports(),
			data.ensureAirspaces(),
			data.ensureSupaip(),
			data.ensureObstacles(),
			data.ensureNavaids(),
		]);
		// Each one answers: a refusal is the fetch's own 404, never a hang, and
		// the two point sets degrade to empty.
		expect(settled.map((r) => r.status)).toEqual(COLD_BOOT);
		for (const r of settled.slice(0, 3)) {
			expect(r.status === 'rejected' ? String(r.reason) : '').toMatch(/HTTP 404/);
		}
		const [obstacles, navaids] = settled.slice(3);
		expect(obstacles.status === 'fulfilled' ? obstacles.value : null).toEqual([]);
		expect(navaids.status === 'fulfilled' ? navaids.value : null).toEqual([]);
	});
});

describe('the app against the site it is published in', () => {
	/** The ensures the viewer's own surfaces make, plus the NOTAM panel's
	 *  on-demand load for an obstacle NOTAM and a navaid NOTAM, over an area
	 *  holding every publisher's obstacles and navaids (Zurich and Helsinki
	 *  among them). */
	async function load(viewer: boolean): Promise<string[]> {
		const asked: string[] = [];
		serveSite(asked);
		if (viewer) {
			const { markNotamViewer } = await import('$lib/state/appIdentity');
			markNotamViewer();
		}
		const cov = await import('$lib/state/coverage.svelte');
		cov.setCoverageArea({ minLat: 36, minLon: -10, maxLat: 62, maxLon: 28 });
		const data = await import('$lib/state/data.svelte');
		await Promise.allSettled([
			data.ensureAirports(),
			data.ensureAirspaces(),
			data.ensureSupaip(),
			data.ensureFrAdCharts(),
			data.ensureUkAdCharts(),
			data.ensureUsAdCharts(),
			data.ensureDeAdCharts(),
			data.ensureAtAdCharts(),
		]);
		const { ensureNotamLinkData } = await import('$lib/state/notamLinkData');
		ensureNotamLinkData('QOBCE');
		ensureNotamLinkData('QNVAS');
		await drain();
		return asked;
	}

	it('reads nothing its manifest does not name', async () => {
		// A pre-release slot is the same dataset's other edition.
		const asked = await load(true);
		const unlisted = [...new Set(asked.map((p) => p.replace('.next.', '.')))].filter(
			(p) => !NOTAM_VIEWER_DATASETS.includes(p),
		);
		expect(unlisted).toEqual([]);
	});

	it('leaves the flight app loading them for the same NOTAMs', async () => {
		const asked = await load(false);
		expect(asked).toContain('/data/ch-obstacles.json');
		expect(asked).toContain('/data/fi-obstacles.json');
		expect(asked).toContain('/data/fr-navaids.json');
	});
});
