/* Coming back where the pilot was (state/resume.svelte.ts): the record a
 * rebuilt page reads, what it keeps of the panel (a NOTAM's by its entry's
 * identity, a SIGMET's never), and the order of the restore: the page, its
 * section and the tab at once, the panel once its data is in, unless the
 * pilot opened one meanwhile. And the shell's half, which says the page was
 * rebuilt (ResumePlugin.java). */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResumeRecord } from '$lib/state/resume.svelte';

const data = vi.hoisted(() => ({ supaips: new Set<string>(), gate: Promise.resolve() }));
vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/data.svelte')>();
	return {
		...actual,
		ensureSupaip: async () => {
			await data.gate;
			return [];
		},
		supaipById: (id: string) => (data.supaips.has(id) ? { id } : null),
	};
});

const { parseNotams } = await import('$lib/notam');
const { notamState } = await import('$lib/state/notam.svelte');
const { ui } = await import('$lib/state/ui.svelte');
const { applyRecord, currentRecord, parseRecord } = await import('$lib/state/resume.svelte');

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

/** A restricted area a NOTAM creates over the Somme. */
const zone = (id: string) =>
	`${id} NOTAMN
Q) LFFF/QRTCA/IV/BO/W/000/015/5013N00137E005
A) LFFF B) 2611230000 C) 2611292359
E) ZONE REGLEMENTEE TEMPORAIRE (ZRT) 'ZRT SOMME 2' :
LIMITES LATERALES :
501654N 0013537E
501457N 0014121E
501012N 0014150E
501040N 0013207E
501654N 0013537E
F) SFC G) 1500FT AMSL`;

const BLOIS: ResumeRecord = {
	page: 'brief',
	pageSection: { brief: 'supaip' },
	activeTab: 'notams',
	detail: { kind: 'supaip', id: 'metropole-2026-153', zone: 0 },
};

/** A promise and the hand that settles it. */
function gate(): { promise: Promise<void>; open: () => void } {
	let open = () => {};
	const promise = new Promise<void>((resolve) => (open = resolve));
	return { promise, open };
}

beforeEach(() => {
	ui.page = null;
	ui.pageSection = {};
	ui.activeTab = 'route';
	ui.detail = null;
	notamState.notams = [];
	data.supaips = new Set(['metropole-2026-153']);
	data.gate = Promise.resolve();
});

describe('the record', () => {
	it('reads back what was written, and nothing this version cannot read', () => {
		expect(parseRecord(JSON.parse(JSON.stringify(BLOIS)))).toEqual(BLOIS);
		expect(parseRecord(null)).toBeNull();
		expect(parseRecord('brief')).toBeNull();
		expect(parseRecord({ ...BLOIS, page: 'cockpit' })).toBeNull();
		expect(parseRecord({ ...BLOIS, activeTab: 'radar' })).toBeNull();
		expect(parseRecord({ ...BLOIS, detail: { kind: 'sigmet', id: 'LFFF-1' } })).toBeNull();
		expect(parseRecord({ ...BLOIS, detail: { kind: 'notam', index: 3 } })).toBeNull();
		expect(parseRecord({ ...BLOIS, detail: { kind: 'station', id: 'LFPO' } })).toBeNull();
		expect(parseRecord({ ...BLOIS, pageSection: { brief: 'supaip', cockpit: 'x', plan: 3 } })?.pageSection).toEqual({ brief: 'supaip' });
	});

	it('keeps a NOTAM by its entry, so the panel follows it to a new index', async () => {
		notamState.notams = parseNotams(`${zone('R0001/26')}\n\n${zone('R0002/26')}`);
		ui.detail = { kind: 'notam', index: 1, fromList: true };
		const rec = currentRecord();
		expect(rec.detail).toMatchObject({ kind: 'notam' });
		// The briefing comes back with a NOTAM ahead of it.
		notamState.notams = parseNotams(`${zone('R0009/26')}\n\n${zone('R0001/26')}\n\n${zone('R0002/26')}`);
		ui.detail = null;
		await applyRecord(rec);
		expect(ui.detail).toEqual({ kind: 'notam', index: 2 });
		expect(notamState.notams[2]?.id).toBe('R0002/26');
	});

	it('keeps a station and a place whole, a SIGMET not at all', () => {
		ui.detail = { kind: 'station', id: 'LFPO', lat: 48.72, lon: 2.38, name: 'Paris Orly' };
		expect(currentRecord().detail).toEqual({ kind: 'station', id: 'LFPO', lat: 48.72, lon: 2.38, name: 'Paris Orly' });
		ui.detail = { kind: 'place', id: 'fr:91223', lat: 48.43, lon: 2.16, name: 'Étampes', commune: true };
		expect(currentRecord().detail).toEqual({ kind: 'place', id: 'fr:91223', lat: 48.43, lon: 2.16, name: 'Étampes', commune: true });
		ui.detail = { kind: 'sigmet', id: 'LFFF-1' };
		expect(currentRecord().detail).toBeNull();
	});
});

describe('the restore', () => {
	it('puts the page, its section and the tab back at once, the panel once its data is in', async () => {
		const g = gate();
		data.gate = g.promise;
		const done = applyRecord(BLOIS);
		expect([ui.page, ui.pageSection.brief, ui.activeTab, ui.detail]).toEqual(['brief', 'supaip', 'notams', null]);
		g.open();
		await done;
		expect(ui.detail).toEqual({ kind: 'supaip', id: 'metropole-2026-153', zone: 0 });
	});

	it('leaves the panel closed when its subject is gone', async () => {
		data.supaips = new Set();
		await applyRecord(BLOIS);
		expect(ui.page).toBe('brief');
		expect(ui.detail).toBeNull();
	});

	it('leaves the panel the pilot opened meanwhile', async () => {
		const g = gate();
		data.gate = g.promise;
		const done = applyRecord(BLOIS);
		ui.detail = { kind: 'airport', id: 'LFPN' };
		g.open();
		await done;
		expect(ui.detail).toEqual({ kind: 'airport', id: 'LFPN' });
	});

	it('waits for the kept briefing to bring a NOTAM back', async () => {
		notamState.notams = parseNotams(zone('R0002/26'));
		ui.detail = { kind: 'notam', index: 0 };
		const rec = currentRecord();
		notamState.notams = [];
		ui.detail = null;
		const done = applyRecord(rec);
		setTimeout(() => (notamState.notams = parseNotams(zone('R0002/26'))), 300);
		await done;
		expect(ui.detail).toEqual({ kind: 'notam', index: 0 });
	});
});

describe("the shell's half", () => {
	it('answers whether the activity was built from saved state', () => {
		const activity = read('android/app/src/main/java/fr/loxodrome/app/MainActivity.java');
		expect(activity).toMatch(/public void onCreate\(Bundle savedInstanceState\) \{\s*restored = savedInstanceState != null;/);
		expect(activity).toContain('registerPlugin(ResumePlugin.class);');
		const plugin = read('android/app/src/main/java/fr/loxodrome/app/ResumePlugin.java');
		expect(plugin).toContain('@CapacitorPlugin(name = "Resume")');
		expect(plugin).toContain('ret.put("restored", getActivity() instanceof MainActivity && ((MainActivity) getActivity()).restored);');
		expect(read('src/lib/native/resume.ts')).toContain("registerPlugin<ResumePlugin>('Resume')");
		expect(read('src/App.svelte')).toContain('onMount(() => installResume());');
	});
});
