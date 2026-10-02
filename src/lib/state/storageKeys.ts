/* Every localStorage key the application writes, classified once
 * (docs/preferences.md, "The key registry"). A LEAF module on purpose: the
 * boot sweep and the shared-mode wipe (sync/bootSweep.ts, sync/wipe.ts) read
 * it before any state module may evaluate, and the Reset dialog reads it
 * through state/reset.ts. The modules keep their own key literals; what stops
 * this list drifting from them is tests/storageKeys.spec.ts, which fails on a
 * `loxodrome:` literal anywhere in the source that is not registered here, and
 * on an entry here that no longer occurs anywhere.
 *
 * The class says what a key HOLDS, which decides who may erase it:
 *   pref      a choice about how the application looks or behaves; the
 *             Restore default settings action puts every one back
 *   layout    a remembered panel width or surface placement, restored with
 *             the preferences
 *   briefing  the route workspace, the recorded trace and its automatic night
 *             (Reset's second group)
 *   aircraft  the pilot's own aircraft sheets, the selection and the
 *             preparation (its third)
 *   account   the account session and the sync bookkeeping
 *             (docs/accounts-sync.md)
 *   override  a developer's DevTools pin of a service address
 *   notice    a one-time notice the pilot has already read
 *   view      working state remembered across sessions, never a setting
 *   legacy    a retired key, erased on load where it still exists
 * Reset application erases briefing and aircraft by their own checkboxes and
 * every other class, an unregistered key included, with its Settings group.
 * A shared session's end (sync/wipe.ts wipeSharedSession) erases every class
 * but the survivors it names there. */

export const STORAGE_PREFIX = 'loxodrome:';

export type StorageClass =
	| 'pref'
	| 'layout'
	| 'briefing'
	| 'aircraft'
	| 'account'
	| 'override'
	| 'notice'
	| 'view'
	| 'legacy';

export const STORAGE_KEYS: Readonly<Record<string, StorageClass>> = {
	// Map layers, the viewing conditions and the NOTAM filters (state/layers,
	// state/filter).
	'loxodrome:layers': 'pref',
	'loxodrome:altitude-band': 'pref',
	'loxodrome:notam-horizon': 'pref',
	'loxodrome:notam-rules': 'pref',
	'loxodrome:notam-kind': 'pref',
	'loxodrome:notams-on-route': 'pref',
	// The Route tab's two display preferences (state/route), kept out of the
	// workspace doc so a cleared plan does not take them along.
	'loxodrome:airspaces-on-route': 'pref',
	'loxodrome:min-alt-danger': 'pref',
	// Settings (state/display).
	'loxodrome:notam-type-icons': 'pref',
	'loxodrome:notam-qline-radius': 'pref',
	'loxodrome:notam-qline-markers': 'pref',
	'loxodrome:hide-airport-notam-markers': 'pref',
	'loxodrome:affected-airspaces': 'pref',
	'loxodrome:show-in-airspaces': 'pref',
	'loxodrome:cursor-coords': 'pref',
	'loxodrome:live-weather': 'pref',
	'loxodrome:profile-all-airspaces': 'pref',
	'loxodrome:gps-alt-datum': 'pref',
	'loxodrome:supaip-lang': 'pref',
	'loxodrome:sofia-lang': 'pref',
	'loxodrome:aip-remark-lang': 'pref',
	'loxodrome:trace-export-format': 'pref',
	'loxodrome:trace-convert-imported': 'pref',
	'loxodrome:layers-control': 'pref',
	'loxodrome:toolbar-in-flight': 'pref',
	'loxodrome:flight-fullscreen': 'pref',
	'loxodrome:route-lock-in-flight': 'pref',
	// Appearance and language (state/theme, state/nightDim, state/i18n).
	'loxodrome:theme': 'pref',
	'loxodrome:night-dim': 'pref',
	'loxodrome:locale': 'pref',
	// The NOTAM source picker (state/notamSource).
	'loxodrome:notam-source': 'pref',
	// The Weather tab's SOFIA chart zone (state/sofiaCharts) and the
	// performance nomogram's reading (state/flightPrepModal).
	'loxodrome:sofia-zone': 'pref',
	'loxodrome:perf-nomogram-metric': 'pref',
	// Winds aloft (state/windAloft).
	'loxodrome:wind-model': 'pref',
	'loxodrome:wind-level': 'pref',
	'loxodrome:wind-map': 'pref',
	'loxodrome:wind-isotherm': 'pref',
	'loxodrome:wind-isotherm-c': 'pref',
	'loxodrome:wind-isobars': 'pref',
	// Precipitation radar (state/radar).
	'loxodrome:radar-map': 'pref',
	'loxodrome:radar-opacity': 'pref',
	'loxodrome:radar-coverage': 'pref',
	'loxodrome:radar-loop': 'pref',
	'loxodrome:radar-product': 'pref',
	'loxodrome:radar-strip': 'pref',
	// METAR stations and SIGMETs on the map.
	'loxodrome:metar-map': 'pref',
	'loxodrome:sigmet-map': 'pref',
	// Airspace and terrain alerts, the automatic stop (state/airspaceAlert,
	// state/terrainAlert, state/autoStop).
	'loxodrome:nav-alerts-off': 'pref',
	'loxodrome:nav-alert-avoid-off': 'pref',
	'loxodrome:nav-alert-clearance-off': 'pref',
	'loxodrome:nav-alert-equipment-off': 'pref',
	'loxodrome:nav-alert-caution-off': 'pref',
	'loxodrome:nav-alert-buffer': 'pref',
	'loxodrome:nav-alert-lookahead': 'pref',
	'loxodrome:nav-alert-audio': 'pref',
	'loxodrome:nav-alert-audio-caution': 'pref',
	'loxodrome:nav-alert-terrain-off': 'pref',
	'loxodrome:nav-alert-obstacle-off': 'pref',
	'loxodrome:nav-auto-stop': 'pref',
	// The in-flight band (state/navStrip).
	'loxodrome:nav-strip-collapsed': 'pref',
	'loxodrome:nav-strip-hidden': 'pref',
	'loxodrome:nav-overflight': 'pref',
	'loxodrome:nav-strip-alt': 'pref',
	// The Navigation tab's live-position display (state/navRecording).
	'loxodrome:nav-show-trace': 'pref',
	'loxodrome:nav-vector': 'pref',
	'loxodrome:nav-contact-map': 'pref',
	'loxodrome:nav-playback-speed': 'pref',
	'loxodrome:nav-icon': 'pref',
	// The profile charts' layers (state/profileLayers).
	'loxodrome:profile-wind-barbs': 'pref',
	'loxodrome:profile-freezing': 'pref',
	'loxodrome:profile-clouds': 'pref',
	'loxodrome:profile-obstacles': 'pref',
	'loxodrome:profile-msa': 'pref',
	'loxodrome:profile-notams': 'pref',
	'loxodrome:profile-terrain-tint': 'pref',
	// The profiles' airspace filter (state/profileAirspaceFilter).
	'loxodrome:profile-class-a': 'pref',
	'loxodrome:profile-class-b': 'pref',
	'loxodrome:profile-class-c': 'pref',
	'loxodrome:profile-class-d': 'pref',
	'loxodrome:profile-class-e': 'pref',
	'loxodrome:profile-zone-restricted': 'pref',
	'loxodrome:profile-zone-military': 'pref',
	'loxodrome:profile-zone-trafficmgmt': 'pref',
	'loxodrome:profile-zone-other': 'pref',
	'loxodrome:profile-activity': 'pref',
	'loxodrome:profile-fir': 'pref',
	'loxodrome:profile-siv': 'pref',

	// Panel widths (components/Sidebar, components/DetailPanel); the surface
	// placements and dock sizes are the family below.
	'loxodrome:sidebar-width': 'layout',
	'loxodrome:detail-width': 'layout',

	// Reset's "Briefing, routes and traces" group; the shared-mode wipe clears
	// it with the session (sync/wipe.ts).
	'loxodrome:routes': 'briefing',
	'loxodrome:routes-rescued': 'briefing',
	'loxodrome:nav-trace': 'briefing',
	'loxodrome:nav-trace-parked': 'briefing',
	// The recording's automatic night from dusk to dawn, in force or held by
	// the pilot's pick (state/theme; index.html's pre-paint reads it), which
	// is never the pilot's theme choice. It belongs to the trace: erased
	// without it, it painted a boot night and flashed the day in, and on a
	// club PC kept the previous session's night.
	'loxodrome:auto-night': 'briefing',

	// Reset's "My aircraft and pilot details" group.
	'loxodrome:aircraft-user': 'aircraft',
	'loxodrome:aircraft-fuel': 'aircraft',
	'loxodrome:flight-prep': 'aircraft',
	'loxodrome:pilot': 'aircraft',
	// Which plane is selected (state/aircraft): working state, never
	// restored, and gone with the planes it may name.
	'loxodrome:aircraft-selected': 'aircraft',

	// The account and its sync (sync/keys.ts). shared-marker lives in
	// sessionStorage, the per-tab half of the ended-session signature.
	'loxodrome:sync': 'account',
	'loxodrome:sync-found': 'account',
	'loxodrome:account': 'account',
	'loxodrome:last-account': 'account',
	'loxodrome:last-mode': 'account',
	'loxodrome:shared-session': 'account',
	'loxodrome:shared-marker': 'account',

	// DevTools pins of a service address (autorouter/state, sync/protocol).
	'loxodrome:autorouter-proxy': 'override',
	'loxodrome:account-api': 'override',

	// Notices read once (state/radar, state/flightAction).
	'loxodrome:radar-caution': 'notice',
	'loxodrome:nav-location-disclosed': 'notice',
	'loxodrome:nav-battery-asked': 'notice',

	// Working state remembered across sessions (state/fleetView), and the
	// map's last settled view, which a boot whose URL carries none opens on
	// (state/mapView).
	'loxodrome:fleet-expanded': 'view',
	'loxodrome:map-view': 'view',

	// Retired keys, erased on load (state/display, autorouter/state).
	'loxodrome:aip-content-lang': 'legacy',
	'loxodrome:autorouter-email': 'legacy',
	'loxodrome:autorouter-password': 'legacy',
};

/** Keys built at run time from a literal stem: one stem, the pattern every
 *  key built from it matches, and the class they share. */
export const STORAGE_FAMILIES: readonly {
	readonly literal: string;
	readonly pattern: RegExp;
	readonly cls: StorageClass;
}[] = [
	{
		// state/workspace.svelte.ts: a surface's remembered placement and
		// dock sizes, `loxodrome:surface:<id>:placement` / `:size-<edge>`.
		literal: 'loxodrome:surface',
		pattern: /^loxodrome:surface:[A-Za-z]+:(?:placement|size-bottom|size-right)$/,
		cls: 'layout',
	},
];

/** The class of a stored key, or null when nothing registers it. */
export function storageClassOf(key: string): StorageClass | null {
	if (Object.hasOwn(STORAGE_KEYS, key)) {
		return STORAGE_KEYS[key];
	}
	for (const family of STORAGE_FAMILIES) {
		if (family.pattern.test(key)) {
			return family.cls;
		}
	}
	return null;
}

/** Every registered key of one class (the families, being open-ended, are
 *  not listed). */
export function keysOfClass(cls: StorageClass): string[] {
	return Object.keys(STORAGE_KEYS).filter((k) => STORAGE_KEYS[k] === cls);
}
