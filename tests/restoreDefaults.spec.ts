/* Restore default settings (state/defaultSettings.ts, docs/preferences.md),
 * end to end over the real modules. Every key the registry classes as a
 * preference or a layout is seeded away from its default, next to one of
 * every OTHER class; the restore must leave no preference or layout key
 * behind, leave every other key byte for byte, write nothing new, and leave
 * each preference in the state a fresh load over the kept keys alone would
 * have. A first case fails when a registered preference has no seed here,
 * so a new preference cannot land without its restore being exercised. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage, type MemoryStorage } from './helpers/storage';
import { KEEP_SEEDS, PREF_SEEDS } from './helpers/prefSeeds';
import { keysOfClass, storageClassOf } from '$lib/state/storageKeys';

let ls: MemoryStorage;

function stubWorld(seed: Record<string, string>): void {
	ls = memoryStorage(seed);
	vi.stubGlobal('localStorage', ls);
	vi.stubGlobal('navigator', { languages: ['en-GB'], language: 'en-GB' });
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))),
	);
}

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function loadModules() {
	return {
		display: await import('$lib/state/display.svelte'),
		layers: await import('$lib/state/layers.svelte'),
		filter: await import('$lib/state/filter.svelte'),
		theme: await import('$lib/state/theme.svelte'),
		i18n: await import('$lib/state/i18n.svelte'),
		nightDim: await import('$lib/state/nightDim.svelte'),
		wind: await import('$lib/state/windAloft.svelte'),
		radar: await import('$lib/state/radar.svelte'),
		metar: await import('$lib/state/metarStations.svelte'),
		sigmets: await import('$lib/state/sigmets.svelte'),
		alert: await import('$lib/state/airspaceAlert.svelte'),
		terrain: await import('$lib/state/terrainAlert.svelte'),
		autoStop: await import('$lib/state/autoStop.svelte'),
		strip: await import('$lib/state/navStrip.svelte'),
		nav: await import('$lib/state/navRecording.svelte'),
		profileLayers: await import('$lib/state/profileLayers.svelte'),
		profileAirspace: await import('$lib/state/profileAirspaceFilter.svelte'),
		route: await import('$lib/state/route.svelte'),
		source: await import('$lib/state/notamSource.svelte'),
		sofia: await import('$lib/state/sofiaCharts.svelte'),
		prep: await import('$lib/state/flightPrepModal.svelte'),
		widths: await import('$lib/state/panelWidths.svelte'),
	};
}

function pick<T extends object>(o: T, keys: (keyof T)[]): Partial<T> {
	return Object.fromEntries(keys.map((k) => [k, o[k]])) as Partial<T>;
}

/** Every preference the restore governs, as plain data. */
function preferences(m: Awaited<ReturnType<typeof loadModules>>): unknown {
	const f = m.filter.filter;
	return JSON.parse(
		JSON.stringify({
			display: m.display.display,
			layers: { ...m.layers.layers, chartSource: null },
			filter: {
				altitude: f.altitude,
				kind: f.kind,
				horizonH: f.window.horizonH,
				trafficMode: f.trafficMode,
				trafficPinned: f.trafficPinned,
				notamsOnRouteOnly: f.notamsOnRouteOnly,
			},
			theme: m.theme.theme,
			locale: [m.i18n.i18n.locale, m.i18n.localePref.value],
			nightDim: m.nightDim.nightDim,
			wind: pick(m.wind.windAloft, [
				'model',
				'levelFt',
				'showOnMap',
				'isotherm0',
				'isothermC',
				'isobars',
			]),
			radar: pick(m.radar.radar, ['showOnMap', 'product', 'opacityPct', 'coverage', 'loopMin', 'stripFolded']),
			metar: m.metar.metarStations.showOnMap,
			sigmets: m.sigmets.sigmets.showOnMap,
			alerts: m.alert.alertPrefs,
			terrain: m.terrain.terrainPrefs,
			autoStop: m.autoStop.autoStop.enabled,
			strip: pick(m.strip.navStrip, ['collapsed', 'hidden', 'overflight', 'altRing']),
			nav: pick(m.nav.nav, ['showTrace', 'vector', 'contactMap', 'playbackSpeed', 'iconKind']),
			profileLayers: m.profileLayers.profileLayers,
			profileAirspace: m.profileAirspace.profileAirspaceGroups,
			route: pick(m.route.routeSettings, ['airspacesOnRouteOnly', 'minAltDangerOn']),
			source: m.source.notamSource.source,
			zone: m.sofia.sofiaCharts.zone,
			nomogram: m.prep.flightPrepModal.nomogramMetric,
			widths: m.widths.panelWidths,
		}),
	);
}

/** A preference or layout key: what the restore removes. */
function restored(key: string): boolean {
	const cls = storageClassOf(key);
	return cls === 'pref' || cls === 'layout';
}

describe('Restore default settings', () => {
	it('has a seed for every registered preference and layout key', () => {
		const missing = [...keysOfClass('pref'), ...keysOfClass('layout')].filter(
			(k) => !Object.hasOwn(PREF_SEEDS, k),
		);
		expect(missing).toEqual([]);
		for (const k of Object.keys(KEEP_SEEDS)) {
			expect(['pref', 'layout', null]).not.toContain(storageClassOf(k));
		}
		// One key of every other class, so none goes unexercised.
		const kept = new Set<string | null>(Object.keys(KEEP_SEEDS).map((k) => storageClassOf(k)));
		for (const cls of ['briefing', 'aircraft', 'account', 'override', 'notice', 'view', 'legacy']) {
			expect(kept.has(cls), cls).toBe(true);
		}
	});

	it('puts every preference back, in place, and keeps everything else', { timeout: 30_000 }, async () => {
		stubWorld({ ...PREF_SEEDS, ...KEEP_SEEDS });
		const m = await loadModules();
		// The seeds were read: a sample of them, so the restore has work to do.
		expect(m.layers.layers.baseLayer).toBe('ign');
		expect(m.display.display.typeIcons).toBe(false);
		expect(m.filter.filter.trafficPinned).toBe(true);
		expect(m.theme.theme.pref).toBe('night');
		expect(m.widths.panelWidths.sidebar).toBe(520);
		const seeded = preferences(m);
		// What the boot left: the legacy key and the older build's copy of the
		// aircraft symbol are the modules' own migrations, not the restore's.
		const booted = ls.dump();
		expect(booted['loxodrome:aip-content-lang']).toBeUndefined();
		expect(booted['loxodrome:nav-trace']).not.toContain('iconKind');

		(await import('$lib/state/defaultSettings')).restoreDefaultSettings();

		// (a) No preference or layout key is left, (b) every other key is
		// byte for byte, and nothing new was written.
		const kept = Object.fromEntries(Object.entries(booted).filter(([k]) => !restored(k)));
		expect(ls.dump()).toEqual(kept);
		const after = preferences(m);
		expect(after).not.toEqual(seeded);

		// (c) Each preference reads as a fresh load over the kept keys alone.
		vi.resetModules();
		stubWorld(kept);
		expect(after).toEqual(preferences(await loadModules()));
	});
});

describe('Restore default settings, around the rest of the app', () => {
	it('refuses while a recording runs, touching nothing', { timeout: 30_000 }, async () => {
		stubWorld({ ...PREF_SEEDS });
		const m = await loadModules();
		m.nav.nav.recording = true;
		const d = await import('$lib/state/defaultSettings');
		expect(d.canRestoreDefaults()).toBe(false);
		const before = ls.dump();
		expect(d.restoreDefaultSettings()).toBe(false);
		expect(ls.dump()).toEqual(before);
		m.nav.nav.recording = false;
		expect(d.canRestoreDefaults()).toBe(true);
	});

	it('runs over an interrupted flight, and says it did', { timeout: 30_000 }, async () => {
		// Kept by decision: on the web an interrupted flight lasts until the
		// pilot continues or clears it, so disabling the restore there could
		// lock it for good. SettingsTab's status line reads the answer.
		const now = Date.now();
		stubWorld({
			'loxodrome:theme': 'night',
			'loxodrome:nav-trace': JSON.stringify({
				v: 1,
				altDatum: 'msl',
				recording: true,
				points: [
					{ lat: 48.6, lon: 2.4, timeMs: now - 120_000, altFt: 1500, speedKt: 95 },
					{ lat: 48.85, lon: 2.35, timeMs: now - 60_000, altFt: 1500, speedKt: 95 },
				],
			}),
		});
		const m = await loadModules();
		expect(m.nav.nav.interrupted).toBe(true);
		expect(m.nav.nav.recording).toBe(false);
		const d = await import('$lib/state/defaultSettings');
		expect(d.canRestoreDefaults()).toBe(true);
		expect(d.restoreDefaultSettings()).toBe(true);
		expect(ls.getItem('loxodrome:theme')).toBeNull();
	});

	it('hands the flight rules back to an IFR route', { timeout: 30_000 }, async () => {
		stubWorld({});
		const m = await loadModules();
		m.route.setRouteVfr(false, 'restore');
		m.filter.setTrafficMode('all');
		expect(m.filter.filter.trafficPinned).toBe(true);
		(await import('$lib/state/defaultSettings')).restoreDefaultSettings();
		expect(m.filter.filter.trafficMode).toBe('ifr');
		expect(m.filter.filter.trafficPinned).toBe(false);
	});

	it('takes back a night the pinned theme held, as Auto does', { timeout: 30_000 }, async () => {
		// Past dusk over an interrupted flight, a Day picked mid-night holds
		// the automatic night ended. Restore unpins the theme, and Auto is
		// the choice that includes the automatic night: the hold existed
		// only because of the pin it removes (docs/preferences.md).
		stubWorld({ 'loxodrome:theme': 'day', 'loxodrome:auto-night': 'held' });
		const m = await loadModules();
		expect(m.theme.theme.value).toBe('day');
		(await import('$lib/state/defaultSettings')).restoreDefaultSettings();
		expect(m.theme.theme.pref).toBe('auto');
		expect(m.theme.theme.value).toBe('night');
		expect(ls.getItem('loxodrome:auto-night')).toBe('1');
		expect(ls.getItem('loxodrome:theme')).toBeNull();
	});

	it('idles the alert sounds before it silences them', { timeout: 30_000 }, async () => {
		const disarm = vi.fn();
		vi.doMock('$lib/nav/alertSounds', async (original) => ({
			...(await original<typeof import('$lib/nav/alertSounds')>()),
			disarmAlertAudio: disarm,
		}));
		stubWorld({ 'loxodrome:nav-alert-audio': '1' });
		await loadModules();
		(await import('$lib/state/defaultSettings')).restoreDefaultSettings();
		expect(disarm).toHaveBeenCalledOnce();
		vi.doUnmock('$lib/nav/alertSounds');
	});
});
