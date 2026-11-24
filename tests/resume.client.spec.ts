/* The record read before its first write and kept current
 * (state/resume.svelte.ts installResume): a page the shell rebuilt, or one
 * Chrome discarded, comes back where the stored record says, a fresh start
 * opens as it always did and writes over it, and a change of panel is
 * written. The shell's answer is faked (native/resume.ts). */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/storage';

const env = vi.hoisted(() => ({ native: true, restored: true }));
vi.mock('$lib/native/platform', () => ({ isNativeApp: () => env.native }));
vi.mock('$lib/native/resume', () => ({ shellRestored: () => Promise.resolve(env.restored) }));

const KEY = 'loxodrome:resume';
const STATION = { kind: 'station', id: 'LFPO', lat: 48.72, lon: 2.38, name: 'Paris Orly' };
const KEPT = { page: 'brief', pageSection: { brief: 'supaip' }, activeTab: 'notams', detail: STATION };

async function boot(seed: Record<string, string>, document?: { wasDiscarded: boolean }) {
	const storage = memoryStorage(seed);
	vi.stubGlobal('localStorage', storage);
	vi.resetModules();
	const { flushSync } = await import('svelte');
	const { installResume } = await import('$lib/state/resume.svelte');
	const { ui } = await import('$lib/state/ui.svelte');
	// After the imports, which read no such document: only the install asks.
	if (document) {
		vi.stubGlobal('document', document);
	}
	const stop = installResume();
	const stored = () => JSON.parse(storage.getItem(KEY) ?? 'null') as unknown;
	return { flushSync, ui, stop, stored };
}

afterEach(() => {
	env.native = true;
	env.restored = true;
	vi.unstubAllGlobals();
});

describe('installResume', () => {
	it('brings a page the shell rebuilt back where the record says', async () => {
		const { flushSync, ui, stop, stored } = await boot({ [KEY]: JSON.stringify(KEPT) });
		await vi.waitFor(() => expect(ui.detail).toEqual(STATION));
		flushSync();
		expect([ui.page, ui.pageSection.brief, ui.activeTab]).toEqual(['brief', 'supaip', 'notams']);
		expect(stored()).toEqual(KEPT);
		stop();
	});

	it('opens a fresh start as it always did, and writes over the record', async () => {
		env.restored = false;
		const { flushSync, ui, stop, stored } = await boot({ [KEY]: JSON.stringify(KEPT) });
		await vi.waitFor(() => expect(stored()).toMatchObject({ page: null, detail: null }));
		expect(ui.page).toBeNull();
		expect(ui.detail).toBeNull();
		ui.detail = { kind: 'place', id: 'fr:91223', lat: 48.43, lon: 2.16, name: 'Étampes' };
		flushSync();
		expect(stored()).toMatchObject({ detail: { kind: 'place', id: 'fr:91223' } });
		stop();
	});

	it('brings a tab Chrome discarded back, on the web', async () => {
		env.native = false;
		const { ui, stop } = await boot({ [KEY]: JSON.stringify(KEPT) }, { wasDiscarded: true });
		await vi.waitFor(() => expect(ui.detail).toEqual(STATION));
		stop();
	});
});
