<script lang="ts">
	/* The login dialog (docs/accounts-sync.md, "UI surface"): the ONE
	 * sign-in surface, opened by the toolbar's account chip and the
	 * Settings group's Sign-in button. Rendered-when-open by App.svelte
	 * (the ResetDialog pattern), so every open starts the flow fresh; the
	 * merge confirm renders as the dialog's closing step (its default
	 * flips on the misused-mode guard, which a fixed-focus ConfirmDialog
	 * cannot express). Deliberately NOT a workspace surface: signing in
	 * must not evict a docked profile. */

	import TurnstileWidget from './TurnstileWidget.svelte';
	import { errorTextOf, type ErrorText } from '$lib/i18n/errorText';
	import { isNativeApp } from '$lib/native/platform';
	import { ApiError } from '$lib/sync/protocol';
	import {
		account,
		beginSignIn,
		completeSignIn,
		lastModeChoice,
	} from '$lib/state/account.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { ACCOUNT_LIVE } from '$lib/net/endpoints';
	import { accountApiBase } from '$lib/sync/protocol';
	import { openAccountModal, takeAfterLogin } from '$lib/state/accountModal.svelte';
	import { adoptPreexisting, afterSignIn, sync } from '$lib/state/sync.svelte';
	import { focusTrap } from '$lib/ui/focusTrap';
	import { portal } from '$lib/ui/portal';

	interface Props {
		onClose: () => void;
	}
	let { onClose }: Props = $props();

	let stage = $state<'email' | 'code' | 'merge'>('email');
	// An expired session pre-fills its own address; anything else starts
	// blank (mounted fresh per open, so this is the open-time state).
	let email = $state(account.authExpired ? (account.email ?? '') : '');
	let code = $state('');
	// The device's LAST choice wins (a club PC keeps proposing shared); a
	// fresh device falls back to the failure asymmetry: browser unchecked,
	// installed app checked (docs/accounts-sync.md).
	const lastMode = lastModeChoice();
	let remember = $state(lastMode !== null ? lastMode === 'personal' : isNativeApp());
	// A per-mount field name keeps browser autofill heuristics from
	// remembering the address on a shared machine (autocomplete="off" is
	// advisory only).
	const fieldNonce = Math.random().toString(36).slice(2, 8);
	let turnstileToken = $state('');
	let busy = $state(false);
	let flowErr = $state<ErrorText | null>(null);
	let mergeDifferent = $state(false);
	let mergeCount = $state(0);

	// Talking to a LOCAL dev service (the vite proxy or a localhost
	// base): its DEV_CODE mails nothing and fixes the code, and the
	// "code was sent" line would otherwise send the tester to an inbox
	// that will stay empty.
	const devService =
		!ACCOUNT_LIVE && /^\/__account$|^http:\/\/(localhost|127\.0\.0\.1)/.test(accountApiBase());

	let emailInput = $state<HTMLInputElement | null>(null);
	$effect(() => {
		emailInput?.focus();
	});

	/** Close after a SUCCESSFUL sign-in (never on cancel): the ?account=
	 *  deep link arms a one-shot that lands the user on the management
	 *  surface, where the deletion controls live. */
	function finish(): void {
		onClose();
		if (takeAfterLogin()) {
			openAccountModal();
		}
	}

	function wordApi(e: unknown): ErrorText {
		if (e instanceof ApiError) {
			const code2 = e.code;
			return () => t.account.syncError(code2);
		}
		return errorTextOf(e);
	}

	async function submitEmail(): Promise<void> {
		busy = true;
		flowErr = null;
		try {
			await beginSignIn(email, turnstileToken);
			stage = 'code';
		} catch (e) {
			flowErr = wordApi(e);
		} finally {
			busy = false;
		}
	}

	async function submitCode(): Promise<void> {
		busy = true;
		flowErr = null;
		try {
			const out = await completeSignIn(email, code, remember);
			await afterSignIn(out.created, out.differentAccount);
			// Anything held back after the first pass asks (a creation that
			// adopted everything holds nothing back).
			if (account.mode === 'personal' && sync.unadopted > 0) {
				mergeCount = sync.unadopted;
				mergeDifferent = out.differentAccount;
				stage = 'merge';
			} else {
				finish();
			}
		} catch (e) {
			flowErr = wordApi(e);
		} finally {
			busy = false;
		}
	}
</script>

<div use:portal>
	<button
		class="modal-backdrop"
		aria-label={t.common.dismiss}
		onpointerdown={onClose}
		oncontextmenu={(e) => e.preventDefault()}
	></button>
	<div
		class="modal-box at-dialog login-box"
		role="dialog"
		aria-modal="true"
		aria-labelledby="login-dialog-title"
		tabindex="-1"
		use:focusTrap
		onkeydown={(e: KeyboardEvent) => {
			// Focus is trapped inside, so Escape always lands here; stopping
			// it keeps the key from any surface's window-level handler.
			if (e.key === 'Escape') {
				e.stopPropagation();
				onClose();
			}
		}}
	>
		<h2 id="login-dialog-title">{t.account.signInAction}</h2>
		{#if stage === 'email'}
			<label class="lg-field">
				{t.account.emailLabel}
				<input
					type="email"
					class="search"
					name={'acc-' + fieldNonce}
					autocapitalize="none"
					autocomplete="off"
					spellcheck="false"
					enterkeyhint="send"
					bind:this={emailInput}
					bind:value={email}
					onkeydown={(e) => {
						if (e.key === 'Enter' && email !== '' && turnstileToken !== '' && !busy) {
							void submitEmail();
						}
					}}
				/>
			</label>
			<TurnstileWidget onToken={(token: string) => (turnstileToken = token)} />
			<div class="actions">
				<button type="button" class="btn" disabled={busy} onclick={onClose}>
					{t.common.cancel}
				</button>
				<button
					type="button"
					class="btn primary"
					disabled={busy || email === '' || turnstileToken === ''}
					onclick={() => void submitEmail()}
				>
					{busy ? t.account.sending : t.account.sendCode}
				</button>
			</div>
		{:else if stage === 'code'}
			{#if devService}
			<p class="muted">{t.account.devCodeHint}</p>
		{:else}
			<p class="muted">{t.account.codeSent(email)}</p>
		{/if}
			<label class="lg-field">
				{t.account.codeLabel}
				<input
					type="text"
					class="search lg-code"
					inputmode="numeric"
					autocomplete="off"
					spellcheck="false"
					maxlength="6"
					enterkeyhint="go"
					bind:value={code}
					onkeydown={(e) => {
						if (e.key === 'Enter' && code.length === 6 && !busy) {
							void submitCode();
						}
					}}
				/>
			</label>
			<label class="check" title={t.account.staySignedInTip}>
				<input type="checkbox" bind:checked={remember} />
				{t.account.staySignedIn}
			</label>
			<p class="muted">{t.account.codeHint}</p>
			<div class="actions">
				<button type="button" class="btn" disabled={busy} onclick={() => (stage = 'email')}>
					{t.account.back}
				</button>
				<button
					type="button"
					class="btn primary"
					disabled={busy || code.length !== 6}
					onclick={() => void submitCode()}
				>
					{busy ? t.account.verifying : t.account.signInAction}
				</button>
			</div>
		{:else}
			<p>{t.account.mergeAsk(mergeCount)}</p>
			{#if mergeDifferent}
				<p class="lg-error">{t.account.mergeDifferentAccount}</p>
			{/if}
			<div class="actions">
				<!-- The misused-mode guard flips which button is primary: the
				     default reads as "don't add" when the last account on this
				     device was someone else's (docs/accounts-sync.md). -->
				<button
					type="button"
					class="btn"
					class:primary={mergeDifferent}
					onclick={finish}
				>
					{t.account.mergeNotNow}
				</button>
				<button
					type="button"
					class="btn"
					class:primary={!mergeDifferent}
					onclick={() => {
						void adoptPreexisting();
						finish();
					}}
				>
					{t.account.mergeAdd}
				</button>
			</div>
		{/if}
		{#if flowErr}<p class="lg-error" role="alert">{flowErr()}</p>{/if}
	</div>
</div>

<style>
	.login-box {
		--modal-width: min(380px, 92vw);

		gap: 8px;
		padding: 16px;
	}

	h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
	}

	.lg-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	/* The shared .search field styling rides the .tab-panel / .popover-panel
	   carriers, which a portaled dialog sits outside of; the fields carry
	   their own copy of the look. */
	.lg-field input {
		padding: 6px 8px;
		font: inherit;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
	}

	.lg-field input:focus {
		border-color: var(--accent);
		outline: none;
	}

	.lg-code {
		max-width: 10em;
		letter-spacing: 0.3em;
		font-variant-numeric: tabular-nums;
	}

	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 2px 0;
		cursor: pointer;
	}

	.check input {
		accent-color: var(--accent);
	}

	.muted {
		margin: 0;
		font-size: var(--fs-sm);
		color: var(--text-muted);
	}

	.lg-error {
		margin: 0;
		color: var(--danger);
	}

	.actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		margin-top: 6px;
	}
</style>
