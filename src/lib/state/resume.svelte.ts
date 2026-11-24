/* Where the pilot was, so a page rebuilt behind their back comes back there
 * (docs/android.md "Coming back where the pilot was"): the phone page, the
 * section each page was left on, the desktop tab, and the panel open. One
 * record under one key of the view class, written whenever one of them
 * changes. It is read once at boot, before the first write, and applied
 * only when the page was REBUILT rather than opened: the Android shell says
 * so when it built the activity from saved state (after the WebView's
 * renderer died, or after Android ended the process behind another app),
 * and Chrome when it had discarded the tab. A launch from the icon opens as
 * it always did. A NOTAM's panel is kept by its entry's identity, never its
 * index, and waits for the kept briefing. A SIGMET's is left out: it is
 * live data, which comes back with the next fetch. */

import { isNativeApp } from '$lib/native/platform';
import { shellRestored } from '$lib/native/resume';
import {
	airportByIdent,
	airspaceByKey,
	ensureAirports,
	ensureAirspaces,
	ensureNature,
	ensureNavaids,
	ensureObstacles,
	ensureSupaip,
	natureById,
	navaidById,
	obstacleById,
	supaipById,
} from './data.svelte';
import { notamEntryIndex, notamEntryKey } from './notam.svelte';
import { ensureZsm, zsmById } from './zsm.svelte';
import { readJson, writeJson } from './persist';
import { ui, type DetailTarget, type PhonePage, type SidebarTab } from './ui.svelte';

const KEY = 'loxodrome:resume';
/** How long a NOTAM's panel waits for the kept briefing to bring its entry
 *  back, and how often it looks. */
const NOTAM_WAIT_MS = 10_000;
const NOTAM_POLL_MS = 250;

// Records rather than lists, so the compiler holds them to the unions.
const PAGES: Record<PhonePage, true> = { airports: true, brief: true, plan: true, flight: true, layers: true, settings: true };
const TABS: Record<SidebarTab, true> = {
	notams: true,
	airports: true,
	route: true,
	aircraft: true,
	navigation: true,
	weather: true,
	layers: true,
	settings: true,
};

/** A panel as kept: a NOTAM's by its entry's identity, the rest as targeted. */
export type KeptDetail = Exclude<DetailTarget, { kind: 'notam' } | { kind: 'sigmet' }> | { kind: 'notam'; entry: string };

export interface ResumeRecord {
	page: PhonePage | null;
	pageSection: Partial<Record<PhonePage, string>>;
	activeTab: SidebarTab;
	detail: KeptDetail | null;
}

const isPage = (v: unknown): v is PhonePage => typeof v === 'string' && Object.hasOwn(PAGES, v);
const isTab = (v: unknown): v is SidebarTab => typeof v === 'string' && Object.hasOwn(TABS, v);

function isKeptDetail(v: unknown): v is KeptDetail {
	if (typeof v !== 'object' || v === null) {
		return false;
	}
	const d = v as Record<string, unknown>;
	const text = (k: string): boolean => typeof d[k] === 'string';
	const at = (): boolean => Number.isFinite(d.lat) && Number.isFinite(d.lon);
	switch (d.kind) {
		case 'notam':
			return text('entry');
		case 'airport':
		case 'obstacle':
		case 'navaid':
		case 'nature':
		case 'zsm':
			return text('id');
		case 'airspace':
			return text('key');
		case 'supaip':
			return text('id') && (d.zone === undefined || Number.isInteger(d.zone));
		case 'station':
		case 'place':
			return text('id') && at();
		default:
			return false;
	}
}

/** The stored record, or null for none or one this version cannot read. */
export function parseRecord(v: unknown): ResumeRecord | null {
	if (typeof v !== 'object' || v === null) {
		return null;
	}
	const r = v as Record<string, unknown>;
	if (!(r.page === null || isPage(r.page)) || !isTab(r.activeTab) || !(r.detail === null || isKeptDetail(r.detail))) {
		return null;
	}
	const pageSection: Partial<Record<PhonePage, string>> = {};
	if (typeof r.pageSection === 'object' && r.pageSection !== null) {
		for (const [page, section] of Object.entries(r.pageSection)) {
			if (isPage(page) && typeof section === 'string') {
				pageSection[page] = section;
			}
		}
	}
	return { page: r.page, pageSection, activeTab: r.activeTab, detail: r.detail };
}

function keptDetail(d: DetailTarget | null): KeptDetail | null {
	if (d === null || d.kind === 'sigmet') {
		return null;
	}
	if (d.kind === 'notam') {
		const entry = notamEntryKey(d.index);
		return entry === null ? null : { kind: 'notam', entry };
	}
	return { ...d };
}

/** Where the pilot is now. */
export function currentRecord(): ResumeRecord {
	return { page: ui.page, pageSection: { ...ui.pageSection }, activeTab: ui.activeTab, detail: keptDetail(ui.detail) };
}

async function notamIndexOf(entry: string): Promise<number | null> {
	const end = Date.now() + NOTAM_WAIT_MS;
	for (;;) {
		const index = notamEntryIndex(entry);
		if (index !== null || Date.now() >= end) {
			return index;
		}
		await new Promise((r) => setTimeout(r, NOTAM_POLL_MS));
	}
}

/** The panel's target once its data has loaded, null when it is gone (a
 *  new AIRAC cycle, a briefing replaced) or its data failed. */
async function resolveDetail(d: KeptDetail): Promise<DetailTarget | null> {
	try {
		switch (d.kind) {
			case 'notam': {
				const index = await notamIndexOf(d.entry);
				return index === null ? null : { kind: 'notam', index };
			}
			case 'airport':
				await ensureAirports();
				return airportByIdent(d.id) ? d : null;
			case 'airspace':
				await ensureAirspaces();
				return airspaceByKey(d.key) ? d : null;
			case 'obstacle':
				await ensureObstacles();
				return obstacleById(d.id) ? d : null;
			case 'navaid':
				await ensureNavaids();
				return navaidById(d.id) ? d : null;
			case 'nature':
				await ensureNature();
				return natureById(d.id) ? d : null;
			case 'zsm':
				await ensureZsm();
				return zsmById(d.id) ? d : null;
			case 'supaip':
				await ensureSupaip();
				return supaipById(d.id) ? d : null;
			case 'station':
			case 'place':
				return d;
		}
	} catch {
		return null;
	}
}

/** Put the pilot back where the record says: the page, its section and the
 *  tab at once, the panel once its data is in, unless the pilot has opened
 *  one meanwhile. */
export async function applyRecord(rec: ResumeRecord): Promise<void> {
	ui.activeTab = rec.activeTab;
	ui.pageSection = { ...ui.pageSection, ...rec.pageSection };
	ui.page = rec.page;
	if (rec.detail === null) {
		return;
	}
	const target = await resolveDetail(rec.detail);
	if (target !== null && ui.detail === null) {
		ui.detail = target;
		ui.detailBack = null;
		ui.detailReturn = null;
	}
}

/** Whether this page was rebuilt rather than opened. */
function rebuilt(): Promise<boolean> {
	if (isNativeApp()) {
		return shellRestored();
	}
	return Promise.resolve((document as Document & { wasDiscarded?: boolean }).wasDiscarded === true);
}

/** At boot: come back where the record says when the page was rebuilt,
 *  then keep the record current. Returns the teardown. Mounted by the
 *  flight app alone. */
export function installResume(): () => void {
	const kept = parseRecord(readJson<unknown>(KEY));
	let stop: (() => void) | null = null;
	let gone = false;
	void (async () => {
		if (kept !== null && (await rebuilt())) {
			// The page, its section and the tab land now, the panel once its
			// data is in, written then with its own change.
			void applyRecord(kept);
		}
		if (gone) {
			return;
		}
		let last = '';
		stop = $effect.root(() => {
			$effect(() => {
				const rec = currentRecord();
				const text = JSON.stringify(rec);
				if (text !== last) {
					last = text;
					writeJson(KEY, rec);
				}
			});
		});
	})();
	return () => {
		gone = true;
		stop?.();
	};
}
