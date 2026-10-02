/* Persisted visibility toggles for the vertical profiles' overlay layers
 * (the RouteProfileModal / NavProfileModal Layers popovers): wind barbs,
 * freezing level, clouds, obstacles, MSA, NOTAMs, terrain-proximity tint.
 * Each layer has its own default in the DEFAULTS record (currently every
 * one ON; the safety layers belong on out of the box) and only the
 * NON-DEFAULT state is stored (the persist.ts idiom), one key per layer,
 * so a fresh browser shows the defaults. Unlike the modals' session state
 * (window, inspect cursor), a layer choice is a lasting reading preference
 * and survives reloads. */

import { readItem, removeItem, writeItem } from './persist';

const KEYS = {
	windBarbs: 'loxodrome:profile-wind-barbs',
	freezing: 'loxodrome:profile-freezing',
	clouds: 'loxodrome:profile-clouds',
	obstacles: 'loxodrome:profile-obstacles',
	msa: 'loxodrome:profile-msa',
	notams: 'loxodrome:profile-notams',
	terrainTint: 'loxodrome:profile-terrain-tint',
} as const;

export type ProfileLayerKey = keyof typeof KEYS;

const DEFAULTS: Record<ProfileLayerKey, boolean> = {
	windBarbs: true,
	freezing: true,
	clouds: true,
	obstacles: true,
	msa: true,
	notams: true,
	terrainTint: true,
};

/** The stored 'on' or 'off', else the default: a value no setter writes
 *  (a corrupt store, a future build's) must not switch a layer off. */
function initial(key: ProfileLayerKey): boolean {
	const stored = readItem(KEYS[key]);
	return stored === 'on' ? true : stored === 'off' ? false : DEFAULTS[key];
}

export const profileLayers = $state({
	windBarbs: initial('windBarbs'),
	freezing: initial('freezing'),
	clouds: initial('clouds'),
	obstacles: initial('obstacles'),
	msa: initial('msa'),
	notams: initial('notams'),
	terrainTint: initial('terrainTint'),
});

/** The layers each chart offers, in its popover's order: the route
 *  profile all seven, the trace profile the three a flown track can draw. */
export const ROUTE_PROFILE_LAYERS: readonly ProfileLayerKey[] = [
	'windBarbs',
	'freezing',
	'clouds',
	'obstacles',
	'msa',
	'terrainTint',
	'notams',
];
export const TRACE_PROFILE_LAYERS: readonly ProfileLayerKey[] = ['obstacles', 'terrainTint', 'notams'];

/** Whether a layer the asking chart offers is away from its default: every
 *  one is on by default, so off means the chart is not drawing something
 *  it can, which its Layers button says without being opened
 *  (docs/preferences.md rule 3), the way the airspace rows' button does. A
 *  layer the chart does not offer never lights it. */
export function profileLayersRestrict(offered: readonly ProfileLayerKey[]): boolean {
	return offered.some((key) => profileLayers[key] !== DEFAULTS[key]);
}

/** Toggle one profile layer, storing only the non-default state. */
export function setProfileLayer(key: ProfileLayerKey, on: boolean): void {
	profileLayers[key] = on;
	if (on === DEFAULTS[key]) {
		removeItem(KEYS[key]);
	} else {
		writeItem(KEYS[key], on ? 'on' : 'off');
	}
}

/** Put every profile layer back to its default, in place, storage included
 *  (Restore default settings). */
export function restoreProfileLayerDefaults(): void {
	for (const key of Object.keys(DEFAULTS) as ProfileLayerKey[]) {
		setProfileLayer(key, DEFAULTS[key]);
	}
}
