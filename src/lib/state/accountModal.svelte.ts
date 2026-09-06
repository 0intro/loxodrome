/* State for the account MANAGEMENT surface (docs/accounts-sync.md, "UI
 * surface"): the dialog behind the toolbar chip once signed in, holding
 * status, devices, sign-out and the sudo actions. Open-ness is the
 * workspace slot (the aboutModal shape). Sign-IN stays its own
 * lightweight dialog (state/loginModal.svelte.ts); `afterLogin` is the
 * one-shot bridge the ?account= deep link uses so a signed-out arrival
 * lands here right after the login completes (the Play deletion URL
 * must reach the deletion controls). */

import { closeSurface, isOpen, openSurface } from './workspace.svelte';

let afterLogin = false;

export const accountModal = {
	get open(): boolean {
		return isOpen('account');
	},
};

export function openAccountModal(): void {
	openSurface('account');
}

export function closeAccountModal(): void {
	closeSurface('account');
}

/** Arm the one-shot: the next successful login opens the surface. */
export function openAccountAfterLogin(): void {
	afterLogin = true;
}

/** Consume the one-shot (the login dialog's success path). */
export function takeAfterLogin(): boolean {
	const out = afterLogin;
	afterLogin = false;
	return out;
}
