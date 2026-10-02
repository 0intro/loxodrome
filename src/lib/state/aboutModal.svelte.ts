/* State for the About surface. `view` switches the single dialog between the
 * About content and a licence text without stacking a second surface on top,
 * and `licenseId` says WHICH licence: null is the app's own MIT, anything
 * else a package id in the generated thirdPartyLicenses module. One viewer
 * serves both, because the app's licence and its dependencies' are the same
 * kind of document and a reader arrives at them the same way.
 * closeAbout() resets to 'about' so the next open lands on the default view.
 *
 * Open-ness is not stored here: it is the workspace slot the surface holds
 * (state/workspace.svelte.ts), read through a getter so callers keep writing
 * `aboutModal.open` and stay reactive. Every surface module has this shape,
 * which is what makes the workspace the one place that decides what is up. */

import { closeSurface, isOpen, openSurface } from './workspace.svelte';

export type AboutView = 'about' | 'license';

const local = $state<{ view: AboutView; licenseId: string | null }>({
	view: 'about',
	licenseId: null,
});

export const aboutModal = {
	get open(): boolean {
		return isOpen('about');
	},
	get view(): AboutView {
		return local.view;
	},
	/** Which licence the 'license' view is showing: a package id, or null for
	 *  the app's own. */
	get licenseId(): string | null {
		return local.licenseId;
	},
};

export function openAbout(): void {
	local.view = 'about';
	local.licenseId = null;
	openSurface('about');
}

export function closeAbout(): void {
	closeSurface('about');
	local.view = 'about';
	local.licenseId = null;
}

/** Show a licence in full: a third-party package by id, or the app's own when
 *  called with nothing. */
export function showLicense(id: string | null = null): void {
	local.licenseId = id;
	local.view = 'license';
}

export function showAbout(): void {
	local.view = 'about';
	local.licenseId = null;
}
