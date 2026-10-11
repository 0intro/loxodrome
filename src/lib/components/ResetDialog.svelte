<script lang="ts">
	/* The Display tab's reset confirm: a small centred dialog on the shared
	 * .modal-backdrop / .modal-box chrome (app.css), deliberately NOT a
	 * workspace surface; a three-checkbox confirm needs no registry entry,
	 * placement or history entry. Escape and the backdrop cancel, and focus
	 * lands on Cancel so a stray Enter never erases. */
	import { t } from '$lib/state/i18n.svelte';
	import { account, signedIn } from '$lib/state/account.svelte';
	import { nav } from '$lib/state/navRecording.svelte';
	import { resetApplication } from '$lib/state/reset';
	import type { RecordingRefusal } from '$lib/state/sync.svelte';
	import { focusTrap } from '$lib/ui/focusTrap';
	import { portal } from '$lib/ui/portal';
	import { dismissOnDown } from '$lib/ui/dismissOnDown';

	interface Props {
		onClose: () => void;
	}
	let { onClose }: Props = $props();

	// The authored-data and flights groups rest unchecked (Decision 6; a
	// filed flight is durable data like an aircraft sheet); preferences and
	// the briefing workspace rest checked.
	let settings = $state(true);
	let briefing = $state(true);
	let aircraft = $state(false);
	let flights = $state(false);

	let cancelBtn = $state<HTMLButtonElement | null>(null);

	// focusTrap lands on the first focusable (the first checkbox); the safe
	// control must hold the initial focus instead.
	$effect(() => {
		cancelBtn?.focus();
	});

	const nothingChecked = $derived(!settings && !briefing && !aircraft && !flights);

	// The settings group ENDS a shared session, and no end runs under a
	// flight (docs/accounts-sync.md): held while this tab records, and said
	// when the reset finds one in another tab.
	const endsShared = $derived(settings && signedIn() && account.mode === 'shared');
	let refused = $state<RecordingRefusal | null>(null);
	const blocked = $derived<RecordingRefusal | null>(endsShared && nav.recording ? 'recording' : refused);

	async function confirmReset(): Promise<void> {
		refused = null;
		refused = (await resetApplication({ settings, briefing, aircraft, flights })) ?? null;
	}
</script>

<div use:portal>
	<button
		class="modal-backdrop"
		aria-label={t.common.dismiss}
		onpointerdown={dismissOnDown(onClose)}
		oncontextmenu={(e) => e.preventDefault()}
	></button>
	<div
		class="modal-box at-dialog reset-box"
		role="dialog"
		aria-modal="true"
		aria-labelledby="reset-dialog-title"
		tabindex="-1"
		use:focusTrap
		onkeydown={(e: KeyboardEvent) => {
			// Focus is trapped inside, so Escape always lands here; stopping it
			// keeps the key from any surface's window-level handler beneath.
			if (e.key === 'Escape') {
				e.stopPropagation();
				onClose();
			}
		}}
	>
		<h2 id="reset-dialog-title">{t.display.resetTitle}</h2>
		<p class="intro">{t.display.resetIntro}</p>
		<label class="check">
			<input type="checkbox" bind:checked={settings} />
			{t.display.resetGroupSettings}
		</label>
		<!-- The account session is stored with the settings group
		     (state/storageKeys.ts), so the sign-out is stated beside its cause
		     and only while it applies: with Settings unticked, or nobody
		     signed in, the device comes back exactly as signed in as it was. -->
		{#if settings && signedIn()}
			<p class="fine signs-out">
				{account.mode === 'shared' ? t.account.resetEndsShared : t.account.resetSignsOut}
			</p>
		{/if}
		<label class="check">
			<input type="checkbox" bind:checked={briefing} />
			{t.display.resetGroupBriefing}
		</label>
		<label class="check">
			<input type="checkbox" bind:checked={aircraft} />
			{t.display.resetGroupAircraft}
		</label>
		<label class="check">
			<input type="checkbox" bind:checked={flights} />
			{t.display.resetGroupFlights}
		</label>
		<p class="fine">{t.display.resetFinePrint}</p>
		{#if endsShared && blocked}
			<p class="fine refused" role="alert">
				{blocked === 'recording' ? t.account.recordingBlocked : t.account.recordingElsewhere}
			</p>
		{/if}
		<div class="actions">
			<button type="button" class="btn" bind:this={cancelBtn} onclick={onClose}>
				{t.common.cancel}
			</button>
			<button
				type="button"
				class="btn danger"
				disabled={nothingChecked || (endsShared && nav.recording)}
				onclick={() => void confirmReset()}
			>
				{t.display.resetConfirm}
			</button>
		</div>
	</div>
</div>

<style>
	.reset-box {
		--modal-width: min(400px, 92vw);

		gap: 8px;
		padding: 16px;
	}

	h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
	}

	.intro {
		margin: 0;
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 2px 0;
		font-size: 13px;
		cursor: pointer;
	}

	.check input {
		accent-color: var(--accent);
	}

	.fine {
		margin: 0;
		font-size: 11.5px;
		color: var(--text-muted);
		line-height: 1.4;
	}

	.signs-out {
		margin: -2px 0 2px 24px;
	}

	.refused {
		color: var(--danger);
	}

	.actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		margin-top: 6px;
	}

</style>
