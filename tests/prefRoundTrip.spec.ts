/* Every preference round-trips through its own key (docs/preferences.md): set
 * away from its default through its setter, it is stored in the form its
 * reader takes, a fresh load reads it back, and the default removes the key
 * again. The modules seed themselves at evaluation, hence the re-import per
 * case. tests/restoreDefaults.spec.ts proves each key GOES at a restore; this
 * spec proves each one is WRITTEN and READ, which is what a pilot relies on
 * after the WebView restarts (an alert sound armed and then silent is the
 * unsafe direction). The garbage rows pin that a stored value no reader
 * wrote reads as the default rather than as some other choice. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage, type MemoryStorage } from './helpers/storage';

let ls: MemoryStorage;

beforeEach(() => {
	vi.resetModules();
	ls = memoryStorage();
	vi.stubGlobal('localStorage', ls);
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

interface Row<M> {
	name: string;
	load: () => Promise<M>;
	/** Away from the default. */
	set: (m: M) => void;
	/** The key and the value it must hold afterwards. */
	stored: [string, string];
	read: (m: M) => unknown;
	want: unknown;
	/** Back to the default, which must leave no key. */
	back: (m: M) => void;
}

function row<M>(r: Row<M>): Row<unknown> {
	return r as unknown as Row<unknown>;
}

const alerts = () => import('$lib/state/airspaceAlert.svelte');
const terrain = () => import('$lib/state/terrainAlert.svelte');
const strip = () => import('$lib/state/navStrip.svelte');
const display = () => import('$lib/state/display.svelte');
const wind = () => import('$lib/state/windAloft.svelte');
const radar = () => import('$lib/state/radar.svelte');
const layers = () => import('$lib/state/profileLayers.svelte');
const rows = () => import('$lib/state/profileAirspaceFilter.svelte');

const ROWS: Row<unknown>[] = [
	row({
		name: 'airspace alerts disarmed',
		load: alerts,
		set: (m) => m.setAlertsEnabled(false),
		stored: ['loxodrome:nav-alerts-off', '1'],
		read: (m) => m.alertPrefs.enabled,
		want: false,
		back: (m) => m.setAlertsEnabled(true),
	}),
	...(['avoid', 'clearance', 'equipment', 'caution'] as const).map((tier) =>
		row({
			name: `the ${tier} tier off`,
			load: alerts,
			set: (m) => m.setAlertTier(tier, false),
			stored: [`loxodrome:nav-alert-${tier}-off`, '1'],
			read: (m) => m.alertPrefs.tiers[tier],
			want: false,
			back: (m) => m.setAlertTier(tier, true),
		}),
	),
	row({
		name: 'the vertical buffer',
		load: alerts,
		set: (m) => m.setAlertBuffer(500),
		stored: ['loxodrome:nav-alert-buffer', '500'],
		read: (m) => m.alertPrefs.bufferFt,
		want: 500,
		back: (m) => m.setAlertBuffer(200),
	}),
	row({
		name: 'the look-ahead',
		load: alerts,
		set: (m) => m.setAlertLookahead(10),
		stored: ['loxodrome:nav-alert-lookahead', '10'],
		read: (m) => m.alertPrefs.lookaheadMin,
		want: 10,
		back: (m) => m.setAlertLookahead(5),
	}),
	row({
		name: 'the alert sound armed',
		load: alerts,
		set: (m) => m.setAlertAudio(true),
		stored: ['loxodrome:nav-alert-audio', '1'],
		read: (m) => m.alertPrefs.audio,
		want: true,
		back: (m) => m.setAlertAudio(false),
	}),
	row({
		name: 'the caution sound armed',
		load: alerts,
		set: (m) => m.setAlertCautionAudio(true),
		stored: ['loxodrome:nav-alert-audio-caution', '1'],
		read: (m) => m.alertPrefs.audioCaution,
		want: true,
		back: (m) => m.setAlertCautionAudio(false),
	}),
	...(['terrain', 'obstacle'] as const).map((kind) =>
		row({
			name: `the ${kind} alert off`,
			load: terrain,
			set: (m) => m.setTerrainTier(kind, false),
			stored: [`loxodrome:nav-alert-${kind}-off`, '1'],
			read: (m) => m.terrainPrefs[kind],
			want: false,
			back: (m) => m.setTerrainTier(kind, true),
		}),
	),
	row({
		name: 'the automatic stop off',
		load: () => import('$lib/state/autoStop.svelte'),
		set: (m) => m.setAutoStopEnabled(false),
		stored: ['loxodrome:nav-auto-stop', 'off'],
		read: (m) => m.autoStop.enabled,
		want: false,
		back: (m) => m.setAutoStopEnabled(true),
	}),
	row({
		name: 'the band collapsed',
		load: strip,
		set: (m) => m.setStripCollapsed(true),
		stored: ['loxodrome:nav-strip-collapsed', 'on'],
		read: (m) => m.navStrip.collapsed,
		want: true,
		back: (m) => m.setStripCollapsed(false),
	}),
	row({
		name: 'the band hidden',
		load: strip,
		set: (m) => m.setStripHidden(true),
		stored: ['loxodrome:nav-strip-hidden', 'on'],
		read: (m) => m.navStrip.hidden,
		want: true,
		back: (m) => m.setStripHidden(false),
	}),
	row({
		name: 'the overflown-aerodrome cell off',
		load: strip,
		set: (m) => m.setStripOverflight(false),
		stored: ['loxodrome:nav-overflight', 'off'],
		read: (m) => m.navStrip.overflight,
		want: false,
		back: (m) => m.setStripOverflight(true),
	}),
	row({
		name: "the height cell on the leg's MSA",
		load: strip,
		set: (m) => m.setStripAltRing('msa'),
		stored: ['loxodrome:nav-strip-alt', 'msa'],
		read: (m) => m.navStrip.altRing,
		want: 'msa',
		back: (m) => m.setStripAltRing('gps'),
	}),
	row({
		name: 'the night dimming',
		load: () => import('$lib/state/nightDim.svelte'),
		set: (m) => m.setNightDim(50),
		stored: ['loxodrome:night-dim', '50'],
		read: (m) => m.nightDim.pct,
		want: 50,
		back: (m) => m.setNightDim(70),
	}),
	row({
		name: 'the autorouter briefing source',
		load: () => import('$lib/state/notamSource.svelte'),
		set: (m) => m.setNotamSource('autorouter'),
		stored: ['loxodrome:notam-source', 'autorouter'],
		read: (m) => m.notamSource.source,
		want: 'autorouter',
		back: (m) => m.setNotamSource('sofia'),
	}),
	row({
		name: 'the GNSS datum pinned',
		load: display,
		set: (m) => m.setGpsAltDatum('msl'),
		stored: ['loxodrome:gps-alt-datum', 'msl'],
		read: (m) => m.display.gpsAltDatum,
		want: 'msl',
		back: (m) => m.setGpsAltDatum('auto'),
	}),
	row({
		name: 'the trace format',
		load: display,
		set: (m) => m.setTraceExportFormat('igc'),
		stored: ['loxodrome:trace-export-format', 'igc'],
		read: (m) => m.display.traceExportFormat,
		want: 'igc',
		back: (m) => m.setTraceExportFormat('gpx'),
	}),
	row({
		name: 'the SUP AIP language pinned',
		load: display,
		set: (m) => m.setSupaipLang('fr'),
		stored: ['loxodrome:supaip-lang', 'fr'],
		read: (m) => m.display.supaipLang,
		want: 'fr',
		back: (m) => m.setSupaipLang('auto'),
	}),
	row({
		name: 'the SOFIA language pinned',
		load: display,
		set: (m) => m.setSofiaLang('en'),
		stored: ['loxodrome:sofia-lang', 'en'],
		read: (m) => m.display.sofiaLang,
		want: 'en',
		back: (m) => m.setSofiaLang('auto'),
	}),
	row({
		name: 'the AIP remark language pinned',
		load: display,
		set: (m) => m.setAipRemarkLang('fr'),
		stored: ['loxodrome:aip-remark-lang', 'fr'],
		read: (m) => m.display.aipRemarkLang,
		want: 'fr',
		back: (m) => m.setAipRemarkLang('auto'),
	}),
	row({
		name: 'the layers control on the map',
		load: display,
		set: (m) => m.setLayersControl('map'),
		stored: ['loxodrome:layers-control', 'map'],
		read: (m) => m.display.layersControl,
		want: 'map',
		back: (m) => m.setLayersControl('toolbar'),
	}),
	row({
		name: 'the toolbar folded in flight',
		load: display,
		set: (m) => m.setToolbarInFlight('folded'),
		stored: ['loxodrome:toolbar-in-flight', 'folded'],
		read: (m) => m.display.toolbarInFlight,
		want: 'folded',
		back: (m) => m.setToolbarInFlight('kept'),
	}),
	row({
		name: 'the winds model',
		load: wind,
		set: (m) => m.setWindModel('icon_seamless'),
		stored: ['loxodrome:wind-model', 'icon_seamless'],
		read: (m) => m.windAloft.model,
		want: 'icon_seamless',
		back: (m) => m.setWindModel('auto'),
	}),
	row({
		name: 'the winds on the map',
		load: wind,
		set: (m) => m.setShowWindOnMap(true),
		stored: ['loxodrome:wind-map', 'on'],
		read: (m) => m.windAloft.showOnMap,
		want: true,
		back: (m) => m.setShowWindOnMap(false),
	}),
	row({
		name: 'the isotherm',
		load: wind,
		set: (m) => m.setWindIsotherm(true),
		stored: ['loxodrome:wind-isotherm', 'on'],
		read: (m) => m.windAloft.isotherm0,
		want: true,
		back: (m) => m.setWindIsotherm(false),
	}),
	row({
		name: 'the isotherm temperature',
		load: wind,
		set: (m) => m.setWindIsothermC(-10),
		stored: ['loxodrome:wind-isotherm-c', '-10'],
		read: (m) => m.windAloft.isothermC,
		want: -10,
		back: (m) => m.setWindIsothermC(0),
	}),
	row({
		name: 'the isobars',
		load: wind,
		set: (m) => m.setWindIsobars(true),
		stored: ['loxodrome:wind-isobars', 'on'],
		read: (m) => m.windAloft.isobars,
		want: true,
		back: (m) => m.setWindIsobars(false),
	}),
	row({
		name: 'the radar on the map',
		load: radar,
		set: (m) => m.setShowRadarOnMap(true),
		stored: ['loxodrome:radar-map', 'on'],
		read: (m) => m.radar.showOnMap,
		want: true,
		back: (m) => m.setShowRadarOnMap(false),
	}),
	row({
		name: 'the radar product',
		load: radar,
		set: (m) => m.setRadarProduct('RATE'),
		stored: ['loxodrome:radar-product', 'RATE'],
		read: (m) => m.radar.product,
		want: 'RATE',
		back: (m) => m.setRadarProduct('DBZH'),
	}),
	row({
		name: 'the radar opacity',
		load: radar,
		set: (m) => m.setRadarOpacity(50),
		stored: ['loxodrome:radar-opacity', '50'],
		read: (m) => m.radar.opacityPct,
		want: 50,
		back: (m) => m.setRadarOpacity(70),
	}),
	row({
		name: 'the radar coverage hatch off',
		load: radar,
		set: (m) => m.setRadarCoverage(false),
		stored: ['loxodrome:radar-coverage', 'off'],
		read: (m) => m.radar.coverage,
		want: false,
		back: (m) => m.setRadarCoverage(true),
	}),
	row({
		name: 'the radar loop',
		load: radar,
		set: (m) => m.setRadarLoop(120),
		stored: ['loxodrome:radar-loop', '120'],
		read: (m) => m.radar.loopMin,
		want: 120,
		back: (m) => m.setRadarLoop(60),
	}),
	row({
		name: 'the radar strip folded',
		load: radar,
		set: (m) => m.foldRadarStrip(),
		stored: ['loxodrome:radar-strip', 'folded'],
		read: (m) => m.radar.stripFolded,
		want: true,
		back: (m) => m.unfoldRadarStrip(),
	}),
	row({
		name: 'the METAR stations on the map',
		load: () => import('$lib/state/metarStations.svelte'),
		set: (m) => m.setShowStationsOnMap(true),
		stored: ['loxodrome:metar-map', 'on'],
		read: (m) => m.metarStations.showOnMap,
		want: true,
		back: (m) => m.setShowStationsOnMap(false),
	}),
	row({
		name: 'the SIGMETs on the map',
		load: () => import('$lib/state/sigmets.svelte'),
		set: (m) => m.setShowSigmetsOnMap(true),
		stored: ['loxodrome:sigmet-map', 'on'],
		read: (m) => m.sigmets.showOnMap,
		want: true,
		back: (m) => m.setShowSigmetsOnMap(false),
	}),
	...(
		['windBarbs', 'freezing', 'clouds', 'obstacles', 'msa', 'notams', 'terrainTint'] as const
	).map((key) =>
		row({
			name: `the profile layer ${key} off`,
			load: layers,
			set: (m) => m.setProfileLayer(key, false),
			stored: [
				`loxodrome:profile-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
				'off',
			],
			read: (m) => m.profileLayers[key],
			want: false,
			back: (m) => m.setProfileLayer(key, true),
		}),
	),
	row({
		name: 'the profile row of class E off',
		load: rows,
		set: (m) => m.setProfileAirspaceGroup('classE', false),
		stored: ['loxodrome:profile-class-e', 'off'],
		read: (m) => m.profileAirspaceGroups.classE,
		want: false,
		back: (m) => m.setProfileAirspaceGroup('classE', true),
	}),
	row({
		name: 'the profile row of the FIS sectors on',
		load: rows,
		set: (m) => m.setProfileAirspaceGroup('siv', true),
		stored: ['loxodrome:profile-siv', 'on'],
		read: (m) => m.profileAirspaceGroups.siv,
		want: true,
		back: (m) => m.setProfileAirspaceGroup('siv', false),
	}),
	row({
		name: 'the sidebar width',
		load: () => import('$lib/state/panelWidths.svelte'),
		set: (m) => m.commitPanelWidth('sidebar', 520),
		stored: ['loxodrome:sidebar-width', '520'],
		read: (m) => m.panelWidths.sidebar,
		want: 520,
		back: (m) => m.commitPanelWidth('sidebar', 400),
	}),
];

describe('every preference round-trips', () => {
	// Each row re-imports its module graph (vi.resetModules), and the first
	// pays the cold transform: under a loaded machine that alone passed the
	// 5 s default (the restore specs' convention).
	for (const r of ROWS) {
		it(r.name, { timeout: 30_000 }, async () => {
			const m = await r.load();
			r.set(m);
			expect(ls.getItem(r.stored[0])).toBe(r.stored[1]);
			vi.resetModules();
			const again = await r.load();
			expect(r.read(again)).toEqual(r.want);
			r.back(again);
			expect(ls.dump()).toEqual({});
		});
	}
});

/* What no setter writes reads as the default, never as another choice. */
const GARBAGE: { key: string; value: string; load: () => Promise<unknown>; read: (m: never) => unknown; want: unknown }[] = [
	{ key: 'loxodrome:nav-alert-buffer', value: '123', load: alerts, read: (m: Awaited<ReturnType<typeof alerts>>) => m.alertPrefs.bufferFt, want: 200 },
	{ key: 'loxodrome:nav-alert-lookahead', value: '7', load: alerts, read: (m: Awaited<ReturnType<typeof alerts>>) => m.alertPrefs.lookaheadMin, want: 5 },
	{ key: 'loxodrome:night-dim', value: '35', load: () => import('$lib/state/nightDim.svelte'), read: (m: { nightDim: { pct: number } }) => m.nightDim.pct, want: 70 },
	{ key: 'loxodrome:night-dim', value: '150', load: () => import('$lib/state/nightDim.svelte'), read: (m: { nightDim: { pct: number } }) => m.nightDim.pct, want: 70 },
	{ key: 'loxodrome:theme', value: 'purple', load: () => import('$lib/state/theme.svelte'), read: (m: { theme: { pref: string } }) => m.theme.pref, want: 'auto' },
	{ key: 'loxodrome:notam-rules', value: 'none', load: () => import('$lib/state/filter.svelte'), read: (m: { filter: { trafficPinned: boolean } }) => m.filter.trafficPinned, want: false },
	{ key: 'loxodrome:altitude-band', value: '6500,1500', load: () => import('$lib/state/filter.svelte'), read: (m: { filter: { altitude: unknown } }) => m.filter.altitude, want: { enabled: true, floor: 0, ceiling: 10000 } },
	{ key: 'loxodrome:nav-vector', value: 'maybe', load: () => import('$lib/state/navRecording.svelte'), read: (m: { nav: { vector: boolean } }) => m.nav.vector, want: true },
	{ key: 'loxodrome:nav-playback-speed', value: '3', load: () => import('$lib/state/navRecording.svelte'), read: (m: { nav: { playbackSpeed: number } }) => m.nav.playbackSpeed, want: 4 },
	{ key: 'loxodrome:nav-overflight', value: 'maybe', load: strip, read: (m: Awaited<ReturnType<typeof strip>>) => m.navStrip.overflight, want: true },
	{ key: 'loxodrome:profile-clouds', value: 'maybe', load: layers, read: (m: Awaited<ReturnType<typeof layers>>) => m.profileLayers.clouds, want: true },
	{ key: 'loxodrome:profile-fir', value: 'maybe', load: rows, read: (m: Awaited<ReturnType<typeof rows>>) => m.profileAirspaceGroups.fir, want: true },
	{ key: 'loxodrome:sidebar-width', value: '0', load: () => import('$lib/state/panelWidths.svelte'), read: (m: { panelWidths: { sidebar: number } }) => m.panelWidths.sidebar, want: 400 },
	{ key: 'loxodrome:detail-width', value: '-50', load: () => import('$lib/state/panelWidths.svelte'), read: (m: { panelWidths: { detail: number } }) => m.panelWidths.detail, want: 480 },
	{ key: 'loxodrome:radar-opacity', value: '10', load: radar, read: (m: Awaited<ReturnType<typeof radar>>) => m.radar.opacityPct, want: 70 },
	{ key: 'loxodrome:wind-isotherm-c', value: '99', load: wind, read: (m: Awaited<ReturnType<typeof wind>>) => m.windAloft.isothermC, want: 0 },
	{ key: 'loxodrome:gps-alt-datum', value: 'geoid', load: display, read: (m: Awaited<ReturnType<typeof display>>) => m.display.gpsAltDatum, want: 'auto' },
	// Blanks and the other spellings Number() takes: '' and ' ' read as 0,
	// which is a real choice for these two, and '1e3' / '0x10' as values
	// no setter writes.
	{ key: 'loxodrome:nav-alert-buffer', value: '', load: alerts, read: (m: Awaited<ReturnType<typeof alerts>>) => m.alertPrefs.bufferFt, want: 200 },
	{ key: 'loxodrome:nav-alert-buffer', value: ' ', load: alerts, read: (m: Awaited<ReturnType<typeof alerts>>) => m.alertPrefs.bufferFt, want: 200 },
	{ key: 'loxodrome:wind-level', value: '', load: wind, read: (m: Awaited<ReturnType<typeof wind>>) => m.windAloft.levelFt, want: 2500 },
	{ key: 'loxodrome:wind-level', value: '1e3', load: wind, read: (m: Awaited<ReturnType<typeof wind>>) => m.windAloft.levelFt, want: 2500 },
	{ key: 'loxodrome:wind-level', value: '0x10', load: wind, read: (m: Awaited<ReturnType<typeof wind>>) => m.windAloft.levelFt, want: 2500 },
	{ key: 'loxodrome:wind-level', value: '90000', load: wind, read: (m: Awaited<ReturnType<typeof wind>>) => m.windAloft.levelFt, want: 2500 },
	{ key: 'loxodrome:wind-level', value: 'Infinity', load: wind, read: (m: Awaited<ReturnType<typeof wind>>) => m.windAloft.levelFt, want: 2500 },
	{ key: 'loxodrome:wind-isotherm-c', value: '-1', load: wind, read: (m: Awaited<ReturnType<typeof wind>>) => m.windAloft.isothermC, want: 0 },
	{ key: 'loxodrome:altitude-band', value: '0,99999999999999999999', load: () => import('$lib/state/filter.svelte'), read: (m: { filter: { altitude: unknown } }) => m.filter.altitude, want: { enabled: true, floor: 0, ceiling: 10000 } },
	{ key: 'loxodrome:sidebar-width', value: '1e3', load: () => import('$lib/state/panelWidths.svelte'), read: (m: { panelWidths: { sidebar: number } }) => m.panelWidths.sidebar, want: 400 },
	{ key: 'loxodrome:sidebar-width', value: '5000', load: () => import('$lib/state/panelWidths.svelte'), read: (m: { panelWidths: { sidebar: number } }) => m.panelWidths.sidebar, want: 400 },
	{ key: 'loxodrome:detail-width', value: '100', load: () => import('$lib/state/panelWidths.svelte'), read: (m: { panelWidths: { detail: number } }) => m.panelWidths.detail, want: 480 },
	{ key: 'loxodrome:sidebar-width', value: '450px', load: () => import('$lib/state/panelWidths.svelte'), read: (m: { panelWidths: { sidebar: number } }) => m.panelWidths.sidebar, want: 400 },
];

describe('a stored value no setter writes', () => {
	for (const g of GARBAGE) {
		it(`reads ${g.key} = ${g.value} as the default`, { timeout: 30_000 }, async () => {
			ls.setItem(g.key, g.value);
			const m = await g.load();
			expect(g.read(m as never)).toEqual(g.want);
		});
	}
});
