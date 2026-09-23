/* A detail panel's own altitude chart (state/airspaceProfileModal.svelte.ts):
 * who may close it, and who may move it.
 *
 * MAXIMISED. On a desktop the placement switcher's "page" (or a divider
 * dragged past the dock's ceiling) closes the detail panel, a page evicting
 * the detail, and the panel's teardown released the chart and closed it: the
 * chart vanished, and the page placement being remembered, every later tap on
 * an inline chart closed the panel and showed nothing. A maximised chart now
 * outlives its panel; a docked one still goes with it.
 *
 * FOLLOWED. A column clicked in a docked chart navigates the detail panel, and
 * "docked, nothing moves" (docs/map-profile.md): a replaced panel's release
 * closed the chart, a re-targeted one re-plotted it over another point. The
 * chart is detached before the navigation. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, String(v)),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
	key: () => null,
	length: 0,
});

const { ui } = await import('$lib/state/ui.svelte');
const { closeSurface, isOpen, placementOf, setPlacement, setStageSize } = await import(
	'$lib/state/workspace.svelte'
);
const {
	airspaceProfileModal,
	detachAirspaceProfile,
	openAirspaceProfile,
	publishAirspaceProfile,
	releaseAirspaceProfile,
} = await import('$lib/state/airspaceProfileModal.svelte');

type Subject = Parameters<typeof openAirspaceProfile>[1];
const subject = (heading: string): Subject => ({
	airspaces: [],
	heading,
	highlightKey: null,
	overlays: [],
	groundFt: 200,
	lat: undefined,
	lon: undefined,
});

beforeEach(() => {
	closeSurface('airspaceProfile');
	store.clear();
	ui.isMobile = false;
	setStageSize(1400, 900);
});

describe("a panel's chart on the desktop", () => {
	it('goes with its panel while docked', async () => {
		const panel = {};
		openAirspaceProfile(panel, subject('LFPN'));
		expect(placementOf('airspaceProfile')).toBe('dock-bottom');
		releaseAirspaceProfile(panel);
		await Promise.resolve();
		expect(isOpen('airspaceProfile')).toBe(false);
	});

	it('outlives its panel once maximised, and keeps opening maximised', async () => {
		const panel = {};
		openAirspaceProfile(panel, subject('LFPN'));
		expect(setPlacement('airspaceProfile', 'page')).toBe(true);
		// The page closed the detail; its panel's teardown releases the chart.
		releaseAirspaceProfile(panel);
		await Promise.resolve();
		expect(isOpen('airspaceProfile')).toBe(true);
		expect(airspaceProfileModal.subject?.heading).toBe('LFPN');
		// The remembered page: the next panel's tap shows the chart.
		closeSurface('airspaceProfile');
		const next = {};
		openAirspaceProfile(next, subject('LFPO'));
		expect(placementOf('airspaceProfile')).toBe('page');
		releaseAirspaceProfile(next);
		await Promise.resolve();
		expect(isOpen('airspaceProfile')).toBe(true);
		expect(airspaceProfileModal.subject?.heading).toBe('LFPO');
	});

	it('stays as it is while the pilot follows one of its columns', async () => {
		const panel = {};
		openAirspaceProfile(panel, subject('LFPN'));
		detachAirspaceProfile();
		// The same panel re-targeted at the column's airspace publishes...
		publishAirspaceProfile(panel, subject('LFR45'));
		expect(airspaceProfileModal.subject?.heading).toBe('LFPN');
		// ...or a replaced one releases: neither moves the chart.
		releaseAirspaceProfile(panel);
		await Promise.resolve();
		expect(isOpen('airspaceProfile')).toBe(true);
		expect(airspaceProfileModal.subject?.heading).toBe('LFPN');
		// A panel opening it again takes it over.
		const other = {};
		openAirspaceProfile(other, subject('LFPG'));
		expect(airspaceProfileModal.subject?.heading).toBe('LFPG');
	});
});
