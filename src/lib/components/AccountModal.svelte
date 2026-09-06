<script lang="ts">
	/* The account MANAGEMENT surface (docs/accounts-sync.md, "UI
	 * surface"): a dialog on the About pattern behind the toolbar chip,
	 * holding status, storage, devices, sign-out and the sudo actions.
	 * Sign-IN lives in the LoginModal dialog (which this surface's
	 * signed-out face opens too); the destructive account actions ride
	 * the sudo re-verify, whose code request needs no Turnstile (the
	 * bearer vouches). */

	import { onMount } from 'svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import SurfaceShell from './SurfaceShell.svelte';
	import { closeAccountModal } from '$lib/state/accountModal.svelte';
	import { buildZipDeflated } from '$lib/files/zip';
	import { errorTextOf, type ErrorText } from '$lib/i18n/errorText';
	import {
		ApiError,
		deleteAccount,
		fetchAccount,
		renameSession,
		restoreAccount,
		revokeSession,
		signOutEverywhere,
		type AccountInfo,
	} from '$lib/sync/protocol';
	import {
		account,
		accountToken,
		markAuthExpired,
		requestSudoCode,
		setAccountStatus,
		signedIn,
	} from '$lib/state/account.svelte';
	import { buildFlightBundle, bundleFileName } from '$lib/state/flightExport';
	import { formatBytes } from '$lib/i18n/intl';
	import { i18n, t } from '$lib/state/i18n.svelte';
	import { openLogin } from '$lib/state/loginModal.svelte';
	import { nav } from '$lib/state/navRecording.svelte';
	import { notamState } from '$lib/state/notam.svelte';
	import {
		adoptPreexisting,
		countPendingDocs,
		signOutDevice,
		sync,
		syncNow,
	} from '$lib/state/sync.svelte';
	import { downloadBlob } from '$lib/ui/dom';

	let busy = $state(false);
	let flowErr = $state<ErrorText | null>(null);
	let deleteNotice = $state<number | null>(null);

	function wordApi(e: unknown): ErrorText {
		if (e instanceof ApiError) {
			const code2 = e.code;
			return () => t.account.syncError(code2);
		}
		return errorTextOf(e);
	}

	// --- the signed-in view --------------------------------------------------
	let info = $state<AccountInfo | null>(null);
	let pending = $state<number | null>(0);
	let renaming = $state(false);
	let renameValue = $state('');

	async function refreshInfo(): Promise<void> {
		const token = accountToken();
		if (!token) {
			return;
		}
		try {
			info = await fetchAccount(token);
		} catch (e) {
			if (e instanceof ApiError && e.status === 401) {
				markAuthExpired();
			}
		}
		pending = await countPendingDocs();
	}

	onMount(() => {
		if (signedIn()) {
			void refreshInfo();
		}
	});

	// A settled sync refreshes the figures (debounced by the syncs
	// themselves; refreshInfo reads nothing this effect tracks back).
	$effect(() => {
		void sync.lastSyncMs;
		if (signedIn() && !account.authExpired) {
			void refreshInfo();
		}
	});

	function agoText(): string {
		// The shared minute tick: "Synced just now" must age while the
		// surface stays open, and Date.now() alone tracks nothing.
		void notamState.tick;
		if (sync.syncing) {
			const prog = sync.progress;
			return prog !== null
				? t.account.statusSyncingProgress(prog.done, prog.total)
				: t.account.statusSyncing;
		}
		if (sync.lastSyncMs === null) {
			return t.account.statusNever;
		}
		const min = Math.floor((Date.now() - sync.lastSyncMs) / 60_000);
		if (min < 1) {
			return t.account.statusSynced(t.account.justNow);
		}
		if (min < 60) {
			return t.account.statusSynced(t.account.minutesAgo(min));
		}
		return t.account.statusSynced(t.account.hoursAgo(Math.floor(min / 60)));
	}

	function mb(n: number): string {
		return formatBytes(i18n.locale, n);
	}

	function modeWord(m: string): string {
		return m === 'shared' ? t.account.modeShared : t.account.modePersonal;
	}

	function fmtDate(ms: number): string {
		return new Date(ms).toLocaleDateString(i18n.locale === 'fr' ? 'fr-FR' : 'en-GB', {
			day: 'numeric',
			month: 'long',
			year: 'numeric',
		});
	}

	// --- sign out + sudo -----------------------------------------------------
	let confirm = $state<{ message: string; label: string; run: () => void } | null>(null);
	let signOutWipe = $state(false);
	let sudo = $state<{
		action: 'everywhere' | 'delete';
		code: string;
		busy: boolean;
		err: ErrorText | null;
		wipe: boolean;
	} | null>(null);

	async function askSignOut(): Promise<void> {
		// Flush first so the warning counts what a sign-out would actually
		// leave behind, not what the next pass was about to push anyway.
		try {
			await syncNow();
		} catch {
			/* best-effort */
		}
		const n = await countPendingDocs();
		const parts: string[] = [];
		if (n === null) {
			parts.push(t.account.pendingUnknown);
		} else if (n > 0) {
			parts.push(t.account.signOutPending(n));
		}
		parts.push(account.mode === 'shared' ? t.account.signOutShared : t.account.signOutKeep);
		const wipe = signOutWipe;
		confirm = {
			message: parts.join(' '),
			label: t.account.signOutAction,
			run: () => {
				void signOutDevice({ wipe });
			},
		};
	}

	async function startSudo(action: 'everywhere' | 'delete'): Promise<void> {
		try {
			await requestSudoCode();
		} catch {
			/* the caps answer quietly; the code field says wrong-code if so */
		}
		sudo = { action, code: '', busy: false, err: null, wipe: false };
	}

	async function submitSudo(): Promise<void> {
		const s = sudo;
		const token = accountToken();
		if (!s || !token) {
			return;
		}
		s.busy = true;
		s.err = null;
		try {
			await syncNow();
			if (s.action === 'everywhere') {
				await signOutEverywhere(token, s.code);
				sudo = null;
				await signOutDevice({ wipe: account.mode === 'shared' });
			} else {
				deleteNotice = await deleteAccount(token, s.code);
				const wipe = s.wipe;
				sudo = null;
				await signOutDevice({ wipe });
			}
		} catch (e) {
			s.err = wordApi(e);
			s.busy = false;
		}
	}

	async function restore(): Promise<void> {
		const token = accountToken();
		if (!token) {
			return;
		}
		busy = true;
		try {
			await restoreAccount(token);
			setAccountStatus('active');
			void syncNow();
			void refreshInfo();
		} catch (e) {
			flowErr = wordApi(e);
		} finally {
			busy = false;
		}
	}

	async function revoke(id: string): Promise<void> {
		const token = accountToken();
		if (!token) {
			return;
		}
		try {
			await revokeSession(token, id);
		} catch (e) {
			flowErr = wordApi(e);
		}
		void refreshInfo();
	}

	async function commitRename(): Promise<void> {
		const token = accountToken();
		if (!token || renameValue.trim() === '') {
			renaming = false;
			return;
		}
		try {
			await renameSession(token, renameValue.trim());
		} catch (e) {
			flowErr = wordApi(e);
		}
		renaming = false;
		void refreshInfo();
	}

	let downloading = $state(false);
	async function downloadData(): Promise<void> {
		downloading = true;
		try {
			const entries = await buildFlightBundle();
			const atMs = Date.now();
			downloadBlob(
				new Blob([await buildZipDeflated(entries)], { type: 'application/zip' }),
				bundleFileName(atMs),
				'application/zip',
			);
		} finally {
			downloading = false;
		}
	}
</script>


<SurfaceShell
	id="account"
	onClose={closeAccountModal}
	labelledby="account-title"
	closeLabel={t.common.close}
	boxClass="account-box"
>
	{#snippet header()}
		<h2 id="account-title">{t.account.title}</h2>
	{/snippet}
	<div class="body">
			{#if !signedIn()}
			{#if deleteNotice !== null}
				<p class="muted" role="status">{t.account.deleteStaged(fmtDate(deleteNotice))}</p>
			{/if}
			<div class="acc-row">
				<button class="btn primary" onclick={openLogin}>{t.account.signInAction}</button>
			</div>
		{:else}
			<p class="signed-as">{t.account.signedInAs(account.email ?? '')}</p>
			{#if account.mode === 'shared'}
				<p class="muted">{t.account.sharedSession}</p>
			{/if}
			{#if account.authExpired}
				<p class="acc-error" role="alert">{t.account.authExpired}</p>
				<div class="acc-row">
					<button class="btn primary" onclick={openLogin}>{t.account.signInAction}</button>
				</div>
			{:else if account.status === 'pending_delete'}
				<p class="acc-error" role="alert">
					{t.account.deleteStaged(fmtDate(info?.deleteAfter ?? Date.now()))}
				</p>
				<div class="acc-row">
					<button class="btn primary" disabled={busy} onclick={() => void restore()}>
						{t.account.restoreAccount}
					</button>
				</div>
				{#if flowErr}<p class="acc-error" role="alert">{flowErr()}</p>{/if}
			{:else}
				<!-- One truth at a time: the live progress counter while a
				     pass runs (its total counts uploaded DOCUMENTS; deletions
				     push no payload), the pending count only at rest. Side by
				     side they read as a contradiction (53/102 beside 104). -->
				<p class="muted" role="status">
					{agoText()}{#if !sync.syncing && pending !== null && pending > 0}
						({t.account.pendingLine(pending)}){/if}
				</p>
				{#if sync.errorCode !== null}
					<p class="acc-error" role="alert">{t.account.syncError(sync.errorCode)}</p>
				{/if}
				{#if sync.expiredPendingAsk}
					<p class="acc-error" role="alert">{t.account.expiredSharedPending}</p>
				{/if}
				{#if info}
					<p class="muted">{t.account.storageLine(mb(info.bytesUsed), mb(info.quotaBytes))}</p>
				{/if}
				{#if account.mode === 'personal' && sync.unadopted > 0}
					<p class="muted">
						{t.account.unadoptedLine(sync.unadopted)}
						<button class="btn" onclick={() => void adoptPreexisting()}>
							{t.account.unadoptedAdd}
						</button>
					</p>
				{/if}
				<div class="acc-row">
					<button class="btn" disabled={sync.syncing} onclick={() => void syncNow()}>
						{t.account.syncNow}
					</button>
					<button class="btn" disabled={downloading} onclick={() => void downloadData()}>
						{t.account.downloadAll}
					</button>
				</div>
				{#if info && info.sessions.length > 0}
					<p class="acc-devices-title">{t.account.devices}</p>
					<ul class="acc-devices">
						{#each info.sessions as s (s.id)}
							<li>
								<span class="acc-device-name">{s.deviceName}</span>
								{#if s.current}
									<span class="muted">({t.account.deviceCurrent}, {modeWord(s.mode)})</span>
									{#if renaming}
										<input
											type="text"
											class="search acc-rename"
											bind:value={renameValue}
											onkeydown={(e) => {
												if (e.key === 'Enter') {
													void commitRename();
												}
												if (e.key === 'Escape') {
													renaming = false;
												}
											}}
										/>
										<button class="btn" onclick={() => void commitRename()}>OK</button>
									{:else}
										<button
											class="btn"
											onclick={() => {
												renameValue = s.deviceName;
												renaming = true;
											}}
										>
											{t.account.renameDevice}
										</button>
									{/if}
								{:else}
									<span class="muted">
										({modeWord(s.mode)}, {t.account.deviceSeen(fmtDate(s.lastSeen))})
									</span>
									<button class="btn" onclick={() => void revoke(s.id)}>
										{t.account.deviceRevoke}
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
				{#if nav.recording}
					<p class="muted">{t.account.recordingBlocked}</p>
				{/if}
				<div class="acc-danger-zone">
					{#if account.mode === 'personal'}
						<label class="check">
							<input type="checkbox" bind:checked={signOutWipe} />
							{t.account.signOutWipeOption}
						</label>
					{/if}
					<div class="acc-row">
						<button class="btn" disabled={nav.recording} onclick={() => void askSignOut()}>
							{t.account.signOut}
						</button>
						<button
							class="btn"
							disabled={nav.recording}
							onclick={() => void startSudo('everywhere')}
						>
							{t.account.signOutEverywhere}
						</button>
						<button
							class="btn acc-danger"
							disabled={nav.recording}
							onclick={() => void startSudo('delete')}
						>
							{t.account.deleteAccount}
						</button>
					</div>
				</div>
				{#if sudo}
					<div class="acc-sudo">
						{#if sudo.action === 'delete'}
							<p class="muted">{t.account.deleteExplain}</p>
						{/if}
						<p class="muted">{t.account.sudoIntro(account.email ?? '')}</p>
						<label class="acc-field">
							{t.account.codeLabel}
							<input
								type="text"
								class="search acc-code"
								inputmode="numeric"
								autocomplete="off"
								maxlength="6"
								bind:value={sudo.code}
							/>
						</label>
						{#if sudo.action === 'delete' && account.mode === 'personal'}
							<label class="check">
								<input type="checkbox" bind:checked={sudo.wipe} />
								{t.account.signOutWipeOption}
							</label>
						{/if}
						<div class="acc-row">
							<button
								class="btn"
								class:danger={sudo.action === 'delete'}
								disabled={sudo.busy || sudo.code.length !== 6}
								onclick={() => void submitSudo()}
							>
								{t.account.sudoConfirm}
							</button>
							<button class="btn" disabled={sudo.busy} onclick={() => (sudo = null)}>
								{t.common.cancel}
							</button>
						</div>
						{#if sudo.err}<p class="acc-error" role="alert">{sudo.err()}</p>{/if}
					</div>
				{/if}
			{/if}
			{/if}
	</div>
</SurfaceShell>

{#if confirm}
	<ConfirmDialog
		message={confirm.message}
		confirmLabel={confirm.label}
		danger
		onConfirm={() => {
			const run = confirm?.run;
			confirm = null;
			run?.();
		}}
		onCancel={() => (confirm = null)}
	/>
{/if}

<style>
	/* The shell owns the box element; sizing rides the unique class. */
	:global(.modal-box.account-box) {
		--modal-width: min(520px, 94vw);
	}

	/* The caller-owned scroll body, the About convention. */
	.body {
		flex: 1;
		overflow-y: auto;
		padding: 14px 16px 18px;
		font-size: 13px;
		line-height: 1.5;
	}

	.body p {
		margin: 0 0 4px;
	}

	.signed-as {
		font-weight: 600;
	}

	/* The destructive row sits apart from the everyday actions. */
	.acc-danger-zone {
		margin-top: 14px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}

	/* The shared .search field styling rides the .tab-panel /
	   .popover-panel carriers, which a portaled surface sits outside of;
	   the two inputs here carry their own copy of the look. */
	.acc-field input,
	.acc-rename {
		padding: 6px 8px;
		font: inherit;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
	}

	.acc-field input:focus,
	.acc-rename:focus {
		border-color: var(--accent);
		outline: none;
	}

	.acc-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 6px 0;
	}

	.acc-code {
		max-width: 10em;
		letter-spacing: 0.3em;
		font-variant-numeric: tabular-nums;
	}

	.acc-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 8px 0 4px;
		align-items: center;
	}

	.acc-error {
		color: var(--danger);
		margin: 6px 0;
	}

	.acc-danger {
		color: var(--danger);
	}

	.acc-devices-title {
		margin: 14px 0 6px;
		font-weight: 600;
	}

	.acc-devices {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.acc-devices li {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
	}

	.acc-device-name {
		font-weight: 600;
	}

	.acc-rename {
		max-width: 14em;
	}

	.acc-sudo {
		border: 1px solid var(--border, #8884);
		border-radius: var(--radius-sm, 6px);
		padding: 8px 10px;
		margin-top: 8px;
	}
</style>
