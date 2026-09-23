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

function initial(key: ProfileLayerKey): boolean {
	const stored = readItem(KEYS[key]);
	return stored == null ? DEFAULTS[key] : stored === 'on';
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

/** Toggle one profile layer, storing only the non-default state. */
export function setProfileLayer(key: ProfileLayerKey, on: boolean): void {
	profileLayers[key] = on;
	if (on === DEFAULTS[key]) {
		removeItem(KEYS[key]);
	} else {
		writeItem(KEYS[key], on ? 'on' : 'off');
	}
}
