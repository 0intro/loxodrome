/* Which time blocks of a run have landed at the publisher: Météo-France's
 * store listed by prefix (ListObjectsV2, one page holds a whole run), ECMWF's
 * open-data directory listed through its HTML index. A block is ready once
 * every file it reads is listed: Météo-France's IP1, the cloud package (IP2
 * for AROME, IP3 for ARPEGE), SP1 and SP2 (whose first group also carries
 * AROME's orography), for its hour group or for each of its hours; ECMWF's
 * index of every step. */

import { mfLabels, type Block, type ModelSpec } from './models.ts';

export const MF_STORE = 'https://meteofrance-pnt.s3.rbx.io.cloud.ovh.net';
export const ECMWF_STORE = 'https://data.ecmwf.int/forecasts';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function isoRun(runMs: number): string {
	return new Date(runMs).toISOString().replace('.000Z', 'Z');
}

/** The keys Météo-France lists for one run of a model. */
export async function listMeteoFrance(spec: ModelSpec, runMs: number, fetcher: Fetcher): Promise<Set<string>> {
	const mf = spec.mf;
	if (!mf) {
		throw new Error(`${spec.id} is not a Météo-France model`);
	}
	const keys = new Set<string>();
	let token = '';
	for (let page = 0; page < 10; page++) {
		const q = new URLSearchParams({ 'list-type': '2', prefix: `pnt/${isoRun(runMs)}/${mf.dir}/` });
		if (token) {
			q.set('continuation-token', token);
		}
		const res = await fetcher(`${MF_STORE}/?${q.toString()}`);
		if (!res.ok) {
			await res.body?.cancel();
			throw new Error(`Météo-France listing: HTTP ${res.status}`);
		}
		const xml = await res.text();
		for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
			keys.add(m[1]);
		}
		const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
		if (!next || !/<IsTruncated>true<\/IsTruncated>/.test(xml)) {
			break;
		}
		token = next[1].replace(/&amp;/g, '&');
	}
	return keys;
}

/** A block's Météo-France source files, label by label, IP1, the cloud
 *  package, SP1 and SP2 within each: the keys internal/nwp's MFBlockFiles
 *  reads, the suite holding the two together through models.json. */
export function mfKeys(spec: ModelSpec, runMs: number, b: Block): string[] {
	const mf = spec.mf;
	if (!mf) {
		return [];
	}
	const r = isoRun(runMs);
	return mfLabels(spec, b).flatMap((label) =>
		['IP1', mf.cloudPkg, 'SP1', 'SP2'].map((pkg) => `pnt/${r}/${mf.dir}/${pkg}/${mf.stem}__${pkg}__${label}__${r}.grib2`),
	);
}

/** The blocks of a Météo-France run whose every file is listed. */
export function readyMeteoFrance(spec: ModelSpec, runMs: number, blocks: Block[], keys: Set<string>): Set<string> {
	if (!spec.mf) {
		return new Set();
	}
	const ready = new Set<string>();
	for (const b of blocks) {
		if (mfKeys(spec, runMs, b).every((k) => keys.has(k))) {
			ready.add(b.name);
		}
	}
	return ready;
}

/** The steps ECMWF lists an index for, for one run. ECMWF posts a run
 *  whole, in one minute (85 files at 07:34 for 2026-10-08 00Z), and the
 *  run's directory answers 404 until then: the page, about 460 KB, is read
 *  about once a run. */
export async function listEcmwf(runMs: number, fetcher: Fetcher): Promise<Set<number>> {
	const d = new Date(runMs);
	const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
	const hh = String(d.getUTCHours()).padStart(2, '0');
	const res = await fetcher(`${ECMWF_STORE}/${ymd}/${hh}z/ifs/0p25/oper/`);
	if (res.status === 404) {
		await res.body?.cancel();
		return new Set();
	}
	if (!res.ok) {
		await res.body?.cancel();
		throw new Error(`ECMWF listing: HTTP ${res.status}`);
	}
	const html = await res.text();
	const steps = new Set<number>();
	const stamp = `${ymd}${hh}0000`;
	for (const m of html.matchAll(/(\d{14})-(\d+)h-oper-fc\.index/g)) {
		if (m[1] === stamp) {
			steps.add(Number(m[2]));
		}
	}
	return steps;
}

/** The IFS steps a block reads. */
export function ifsSteps(b: Block): number[] {
	const out: number[] = [];
	for (let h = b.first; h <= b.last; h++) {
		if ((h <= 144 && h % 3 === 0) || (h > 144 && h % 6 === 0)) {
			out.push(h);
		}
	}
	return out;
}

export function readyEcmwf(blocks: Block[], steps: Set<number>): Set<string> {
	const ready = new Set<string>();
	for (const b of blocks) {
		if (ifsSteps(b).every((s) => steps.has(s))) {
			ready.add(b.name);
		}
	}
	return ready;
}

/** The blocks of a run whose source files are all out. */
export async function readyBlocks(spec: ModelSpec, runMs: number, fetcher: Fetcher): Promise<Set<string>> {
	const blocks = spec.blocks(new Date(runMs).getUTCHours());
	if (spec.source === 'meteofrance') {
		return readyMeteoFrance(spec, runMs, blocks, await listMeteoFrance(spec, runMs, fetcher));
	}
	return readyEcmwf(blocks, await listEcmwf(runMs, fetcher));
}

/** One run's listing: the blocks found out, or why it could not say. */
export interface Listing {
	run: string;
	ready?: Set<string>;
	error?: Error;
}

/** Lists the runs in the order given under one budget, the caller's
 *  signal, which every request carries: once it is spent, the runs left
 *  are not asked about at all. A run that fails leaves the others to be
 *  listed. */
export async function listRuns(spec: ModelSpec, runs: string[], fetcher: Fetcher, signal: AbortSignal): Promise<Listing[]> {
	const out: Listing[] = [];
	for (const run of runs) {
		if (signal.aborted) {
			break;
		}
		try {
			out.push({ run, ready: await readyBlocks(spec, Date.parse(run), (u, init) => fetcher(u, { ...init, signal })) });
		} catch (err) {
			out.push({ run, error: err instanceof Error ? err : new Error(String(err)) });
		}
	}
	return out;
}
