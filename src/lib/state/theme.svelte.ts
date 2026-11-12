/* Day / night theme (docs/preferences.md, "Auto is a state"). Three inputs
 * decide the theme on screen, and only one of them is ever stored:
 *   - the pilot's CHOICE, `theme.pref`: Auto, which follows the device's
 *     light or dark appearance and is stored as the key's absence, or a
 *     pinned Day / Night under 'loxodrome:theme' (the value the pre-paint
 *     scripts in index.html and notam.html read);
 *   - the DEVICE's appearance, prefers-color-scheme, followed live while the
 *     choice is Auto (watchSystemTheme);
 *   - the recording's AUTOMATIC NIGHT, `theme.autoNight`, which
 *     state/nightDim.svelte.ts turns on past civil twilight. It is never
 *     written into the choice (a dusk flight used to pin the theme for good,
 *     and a WebView killed mid-night left it pinned to night): it rides a
 *     transient key of its own, 'loxodrome:auto-night': '1' while it is in
 *     force, which index.html's pre-paint honours so a restart during a
 *     night recording paints dark from the first frame instead of flashing
 *     the day theme in a cockpit, and 'held' past a dusk whose night a
 *     pinned pick ended, which the pre-paint ignores and which keeps a
 *     restart before dawn from firing that dusk again over the pick.
 * `theme.value` is the theme on screen, recomputed imperatively (apply), so a
 * node spec sees it with no effect running. A pinned choice ends an automatic
 * night, the pilot's hand winning over the trigger; Auto keeps it, since the
 * automatic night is part of what Auto means. */

import { untrack } from 'svelte';
import { isNotamViewer } from './appIdentity';
import { readItem, removeItem, writeItem } from './persist';

export type Theme = 'day' | 'night';
/** The pilot's choice: follow the device, or one theme pinned. */
export type ThemePref = 'auto' | Theme;

const STORAGE_KEY = 'loxodrome:theme';
const AUTO_NIGHT_KEY = 'loxodrome:auto-night';
/** The automatic-night key's second value: past dusk, the night ended by the
 *  pilot's pick. */
const HELD = 'held';
const DARK_MEDIA = '(prefers-color-scheme: dark)';

function storedPref(): ThemePref {
	const v = readItem(STORAGE_KEY);
	return v === 'day' || v === 'night' ? v : 'auto';
}

function deviceTheme(): Theme {
	try {
		return typeof window !== 'undefined' && window.matchMedia(DARK_MEDIA).matches
			? 'night'
			: 'day';
	} catch {
		return 'day';
	}
}

/** The device's appearance as last read. Plain module state: it is an input,
 *  never stored, and `theme.value` is what anything renders from. */
let device: Theme = deviceTheme();

const initialPref = storedPref();
// The flight app only: the viewer records nothing and never ends a night, so
// a key the flight app left on the shared origin must not darken it (and
// notam.html's pre-paint ignores the key for the same reason).
const initialNightKey = isNotamViewer() ? null : readItem(AUTO_NIGHT_KEY);
const initialAutoNight = initialNightKey === '1';

/** A dusk edge had passed when the app loaded, its automatic night in force
 *  or held: state/nightDim.svelte.ts resumes its edge from it, so a restart
 *  before dawn fires no second dusk. */
export const pastDuskAtLoad = initialAutoNight || initialNightKey === HELD;

/** Past dusk, the automatic night ended by a pinned pick (the key's 'held'):
 *  Auto picked again before dawn takes the night back. Module state beside
 *  the key it mirrors; never true in the viewer, which reads no key. */
let held = initialNightKey === HELD;

function resolve(pref: ThemePref, autoNight: boolean): Theme {
	if (autoNight) {
		return 'night';
	}
	return pref === 'auto' ? device : pref;
}

export const theme = $state<{
	/** The theme on screen. */
	value: Theme;
	/** The pilot's choice, the one stored input. */
	pref: ThemePref;
	/** The recording's automatic night is in force. */
	autoNight: boolean;
}>({
	value: resolve(initialPref, initialAutoNight),
	pref: initialPref,
	autoNight: initialAutoNight,
});

/** Recompute the theme on screen and stamp it on <html data-theme>, the one
 *  carrier every stylesheet reads. */
function apply(): void {
	const value = resolve(theme.pref, theme.autoNight);
	theme.value = value;
	if (typeof document !== 'undefined') {
		document.documentElement.dataset.theme = value;
	}
}

apply();

/** Set the pilot's choice: Auto (the key removed) or a pinned Day / Night. A
 *  pinned choice ends an automatic night in force: a manual change between
 *  the dusk and dawn edges is never fought (state/nightDim.svelte.ts). Auto
 *  picked again before dawn takes it back, the automatic night being part of
 *  what Auto means. */
export function setThemePref(pref: ThemePref): void {
	theme.pref = pref;
	if (pref === 'auto') {
		removeItem(STORAGE_KEY);
		if (held) {
			held = false;
			theme.autoNight = true;
			writeItem(AUTO_NIGHT_KEY, '1');
		}
	} else {
		writeItem(STORAGE_KEY, pref);
		if (theme.autoNight) {
			theme.autoNight = false;
			// Ended, and still past dusk: held rather than removed, so a
			// restart before dawn resumes past the edge instead of firing it
			// again over this pick.
			held = true;
			writeItem(AUTO_NIGHT_KEY, HELD);
		}
	}
	apply();
}

/** The toolbar's sun / moon button: pin the theme opposite to the one on
 *  screen. Auto is chosen in Settings, which is where the pilot returns to
 *  following the device. */
export function toggleTheme(): void {
	setThemePref(theme.value === 'night' ? 'day' : 'night');
}

/** Turn the recording's automatic night on at a dusk edge, or end it at a
 *  dawn edge or the stop (state/nightDim.svelte.ts, the one caller). Never
 *  written into the choice: it rides its own transient key, which the end
 *  removes whether the night was in force or held. Untracked, since it runs
 *  inside App's reconcile effect, which must not come to depend on the
 *  theme it writes. */
export function setAutoNight(on: boolean): void {
	untrack(() => {
		held = false;
		if (on) {
			if (theme.autoNight) {
				return;
			}
			theme.autoNight = true;
			writeItem(AUTO_NIGHT_KEY, '1');
		} else {
			removeItem(AUTO_NIGHT_KEY);
			if (!theme.autoNight) {
				return;
			}
			theme.autoNight = false;
		}
		apply();
	});
}

/** Follow the device's light or dark appearance live, which moves the theme
 *  while the choice is Auto. Mounted once by each App shell; returns the
 *  cleanup. */
export function watchSystemTheme(): () => void {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
		return () => {};
	}
	const mq = window.matchMedia(DARK_MEDIA);
	const onChange = (): void => {
		device = mq.matches ? 'night' : 'day';
		apply();
	};
	// A change between this module's evaluation and the mount counts too.
	onChange();
	mq.addEventListener('change', onChange);
	return () => mq.removeEventListener('change', onChange);
}
