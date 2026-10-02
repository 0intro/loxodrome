/* Restore default settings (docs/preferences.md): every preference back to
 * its default IN PLACE, with no reload and nothing else erased.
 *
 * In place because a reload is not free: the loaded NOTAM briefing, the
 * detail selection and the open surfaces live only in memory, and a
 * reload-based restore would lose them silently. So each module puts its own
 * preferences back through its own setters, which is also what removes their
 * keys, a preference being stored only away from its default; the
 * storage-key registry (state/storageKeys.ts) and tests/restoreDefaults.spec.ts
 * hold this list to every key classed pref or layout.
 *
 * Never touched: the route workspace and its planning settings, the recorded
 * trace and the flights library, the aircraft sheets, the preparation and the
 * selected aircraft, the account and its sync, the notices already read, the
 * DevTools overrides, and the session state that is not a preference: the
 * terrain inhibit, follow, the period's mode and custom dates, the search
 * text, the phone pane's detent, the recording's automatic night (though
 * the theme's Auto, like any pick of Auto, takes back a night a pinned
 * theme had held ended: state/theme.svelte.ts).
 *
 * Synchronous, called from an event handler only, never from an effect. It
 * refuses while a recording runs (canRestoreDefaults, which the Settings tab
 * disables its button on): it would re-arm or silence alerts, move the GNSS
 * datum and possibly switch the language under a pilot in flight. The NOTAM Viewer has its own, narrower one
 * (src/notam/defaultSettings.ts); the destructive sibling is state/reset.ts. */

import { disarmAlertAudio } from '$lib/nav/alertSounds';
import { alertPrefs, restoreAlertDefaults } from './airspaceAlert.svelte';
import { setAutoStopEnabled } from './autoStop.svelte';
import { restoreDisplayDefaults } from './display.svelte';
import { restoreFilterDefaults } from './filter.svelte';
import { restoreNomogramDefault } from './flightPrepModal.svelte';
import { setLocalePref } from './i18n.svelte';
import { persistLayers, resetLayerChoices } from './layers.svelte';
import { setShowStationsOnMap } from './metarStations.svelte';
import { nav, restoreNavDisplayDefaults } from './navRecording.svelte';
import { restoreNavStripDefaults } from './navStrip.svelte';
import { restoreNightDimDefault } from './nightDim.svelte';
import { setNotamSource } from './notamSource.svelte';
import { restorePanelWidths } from './panelWidths.svelte';
import { restoreProfileAirspaceDefaults } from './profileAirspaceFilter.svelte';
import { restoreProfileLayerDefaults } from './profileLayers.svelte';
import { restoreRadarDefaults } from './radar.svelte';
import { restoreRouteViewDefaults, routeSettings, setRouteVfr } from './route.svelte';
import { setShowSigmetsOnMap } from './sigmets.svelte';
import { DEFAULT_SOFIA_ZONE, setSofiaZone } from './sofiaCharts.svelte';
import { restoreTerrainAlertDefaults } from './terrainAlert.svelte';
import { setThemePref } from './theme.svelte';
import { restoreWindDefaults } from './windAloft.svelte';
import { forgetSurfaceLayout } from './workspace.svelte';

/** Whether Restore default settings may run now: not while a recording
 *  runs. The Settings tab disables its button on it, and the restore itself
 *  refuses, a recording being able to begin under the confirm (the Android
 *  boot reconcile resumes one asynchronously). */
export function canRestoreDefaults(): boolean {
	return !nav.recording;
}

/** Put every preference back to its default, in place. Returns false, having
 *  done nothing, while a recording runs (canRestoreDefaults). */
export function restoreDefaultSettings(): boolean {
	if (!canRestoreDefaults()) {
		return false;
	}
	// The language and the theme first: everything below renders in them.
	setLocalePref('auto');
	setThemePref('auto');
	// The weather layers off before anything redraws around them.
	restoreRadarDefaults();
	restoreWindDefaults();
	setShowStationsOnMap(false);
	setShowSigmetsOnMap(false);
	// What the map shows and how. PersistHost would remove the layers key on
	// its own; saying so here keeps the storage right without an effect.
	restoreDisplayDefaults();
	restoreNightDimDefault();
	resetLayerChoices();
	persistLayers();
	restoreProfileLayerDefaults();
	restoreProfileAirspaceDefaults();
	restoreFilterDefaults();
	restoreRouteViewDefaults();
	// The flight rules came unpinned above: the route drives them again.
	setRouteVfr(routeSettings.vfr, 'restore');
	// The alerts (the audio context idled first, as the tab's own switch
	// does), the terrain rows, the automatic stop.
	if (alertPrefs.audio || alertPrefs.audioCaution) {
		disarmAlertAudio();
	}
	restoreAlertDefaults();
	restoreTerrainAlertDefaults();
	setAutoStopEnabled(true);
	// The in-flight display.
	restoreNavStripDefaults();
	restoreNavDisplayDefaults();
	// The sources and the pages.
	setNotamSource('sofia');
	setSofiaZone(DEFAULT_SOFIA_ZONE);
	restoreNomogramDefault();
	// The layout last: the panel widths, then every remembered placement and
	// dock size, without moving an open surface.
	restorePanelWidths();
	forgetSurfaceLayout();
	return true;
}
