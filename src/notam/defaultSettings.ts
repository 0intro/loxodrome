/* The NOTAM Viewer's Restore default settings (docs/preferences.md,
 * docs/notam-viewer.md "The preferences it reads"): the preferences THIS app
 * offers a control for, back to their defaults in place, and nothing else.
 *
 * Narrower than Loxodrome's (state/defaultSettings.ts) on purpose. On
 * loxodrome.fr/notam the two apps share one origin's storage, so a key the
 * viewer does not offer is the flight app's alone: its alerts, its radar,
 * its in-flight options, its route filters are not the viewer's to reset,
 * and the route corridor, inert here for want of a plan, is left as the
 * flight app set it. What the viewer does offer IS shared (the languages,
 * the markers, the NOTAM filters, the theme), and restoring it here restores
 * it there too, which the confirm says on that origin. The layer choices are
 * reset in memory only: this app pins them at their defaults at every boot
 * and never writes the flight app's layers document (state/layers.svelte.ts
 * resetLayerChoices). */

import type { DisplayPref } from '$lib/state/display.svelte';
import { restoreDisplayDefaults } from '$lib/state/display.svelte';
import { restoreFilterDefaults } from '$lib/state/filter.svelte';
import { setLocalePref } from '$lib/state/i18n.svelte';
import { resetLayerChoices } from '$lib/state/layers.svelte';
import { restoreNightDimDefault } from '$lib/state/nightDim.svelte';
import { setNotamSource } from '$lib/state/notamSource.svelte';
import { restorePanelWidths } from '$lib/state/panelWidths.svelte';
import { restoreProfileAirspaceDefaults } from '$lib/state/profileAirspaceFilter.svelte';
import { setThemePref } from '$lib/state/theme.svelte';
import { forgetSurfaceLayout } from '$lib/state/workspace.svelte';
import { viewHashWithoutLayers, writeViewHash } from '$lib/map/viewHash';

/** The display.* fields this app offers a control for: the three content
 *  languages, live weather and the profile scope (SettingsPopover), and the
 *  six NOTAM-marker toggles (LayersPopover). tests/restoreViewerDefaults.spec.ts
 *  holds this list to the fields those two panels read. */
export const VIEWER_DISPLAY_PREFS: readonly DisplayPref[] = [
	'supaipLang',
	'sofiaLang',
	'aipRemarkLang',
	'liveWeather',
	'profileAllAirspaces',
	'typeIcons',
	'qlineMarkers',
	'qlineRadius',
	'hideAirportNotamMarkers',
	'affectedAirspaces',
	'showInAirspaces',
];

/** Put this app's preferences back to their defaults, in place. */
export function restoreViewerDefaultSettings(): void {
	setLocalePref('auto');
	setThemePref('auto');
	restoreDisplayDefaults(VIEWER_DISPLAY_PREFS);
	restoreNightDimDefault();
	restoreProfileAirspaceDefaults();
	resetLayerChoices();
	restoreFilterDefaults(['altitude', 'kind', 'horizon', 'rules']);
	setNotamSource('sofia');
	// This app's two surfaces and its one panel.
	forgetSurfaceLayout(['airspaceProfile', 'about']);
	restorePanelWidths(['detail']);
	// The map re-stamps the URL only when it moves, and a present #map= is
	// what the next boot reads its base map from.
	if (typeof location !== 'undefined') {
		writeViewHash(viewHashWithoutLayers(location.hash));
	}
}
