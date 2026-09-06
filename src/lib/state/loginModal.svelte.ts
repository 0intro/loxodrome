/* State for the login dialog (docs/accounts-sync.md, "UI surface"): the
 * ONE sign-in surface, opened by the toolbar's account chip and the
 * Settings group's Sign-in button alike. Deliberately NOT a workspace
 * surface, the ResetDialog / search-palette class: a small centred
 * dialog needs no slot, placement or history entry, and signing in must
 * not evict a docked profile. */

export const loginModal = $state<{ open: boolean }>({ open: false });

export function openLogin(): void {
	loginModal.open = true;
}

export function closeLogin(): void {
	loginModal.open = false;
}
