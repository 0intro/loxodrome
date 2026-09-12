/* Day / night theme state, persisted to localStorage. */

import { writeItem } from './persist';

export type Theme = 'day' | 'night';

const STORAGE_KEY = 'loxodrome:theme';

function initialTheme(): Theme {
	// The inline script in index.html has already resolved and applied a theme
	// to <html data-theme> before first paint; mirror it here. (Guarded so a
	// node test importing a consumer stays loadable.)
	if (typeof document === 'undefined') {
		return 'day';
	}
	return document.documentElement.dataset.theme === 'night' ? 'night' : 'day';
}

export const theme = $state<{ value: Theme }>({ value: initialTheme() });

function apply(value: Theme): void {
	theme.value = value;
	if (typeof document !== 'undefined') {
		document.documentElement.dataset.theme = value;
	}
	writeItem(STORAGE_KEY, value);
}

export function toggleTheme(): void {
	apply(theme.value === 'day' ? 'night' : 'day');
}

/** Set the theme outright: the recording's automatic night handling
 *  (state/nightDim.svelte.ts) restores a remembered value, which a toggle
 *  cannot express. */
export function setTheme(value: Theme): void {
	apply(value);
}
