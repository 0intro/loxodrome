<script lang="ts">
	/* The flight plan document's standing host (state/planDocument.svelte.ts):
	 * the plan menu, the questions a save or a replacement asks, the web file
	 * picker, and the save receipt read aloud. Mounted once in App beside
	 * FileOpenHost and outside the workspace a phone page makes inert, so a
	 * surface closing under a question cannot strand it. */
	import { onMount } from 'svelte';
	import { aircraftEditor } from '$lib/state/aircraftEditor.svelte';
	import { saveKey } from '$lib/state/planShortcut';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import PlanMenu from './PlanMenu.svelte';
	import { isNativeApp } from '$lib/native/platform';
	import { activePlan } from '$lib/state/activePlan.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { openIncomingBytes, pickFileNatively } from '$lib/state/openFile.svelte';
	import {
		answerPlanQuestion,
		planDocument,
		planFileReadFailed,
		planIdentity,
		saveAndAnswer,
		setPlanFilePicker,
		setPlanMenuAnchor,
	} from '$lib/state/planDocument.svelte';
	import { pickerAccept } from '$lib/ui/filePicker';

	let fileInput = $state<HTMLInputElement>();

	// Natively the picker is the Android one (state/openFile.svelte.ts): the
	// WebView's own chooser hands the page a file it cannot always read back,
	// and the file then opens as whatever KIND it holds, the app's one
	// dispatcher deciding (docs/android.md).
	onMount(() => {
		setPlanFilePicker(() => {
			if (isNativeApp()) {
				void pickFileNatively();
			} else {
				fileInput?.click();
			}
		});
		setPlanMenuAnchor(() => {
			const at = document.querySelector('.plan-chip, .plan-id')?.getBoundingClientRect();
			return at ? { x: at.left, y: at.bottom + 4 } : { x: 12, y: 56 };
		});
		return () => {
			setPlanFilePicker(null);
			setPlanMenuAnchor(null);
		};
	});

	/* The dialogs that hold a question of their own: Ctrl+S waits for their
	 * answer. A workspace surface carries none of these classes, so the key
	 * still saves under a full-screen workbook (flight prep on a phone, or
	 * maximised). */
	const QUESTIONS = '.confirm-box, .datum-box, .shortcuts-box, .login-box, .reset-box, .palette-box';

	/* Ctrl/Cmd+S saves the plan (state/planShortcut.ts decides), from a text
	 * box too: the focused field is blurred first, so a draft it holds
	 * commits as a click elsewhere would. A save that fails opens the plan
	 * menu on its error line (saveAndAnswer). */
	function onWindowKey(e: KeyboardEvent): void {
		const blocked =
			planDocument.question != null || aircraftEditor.open || document.querySelector(QUESTIONS) != null;
		const act = saveKey(e, blocked);
		if (act === 'pass') {
			return;
		}
		e.preventDefault();
		if (act === 'hold') {
			return;
		}
		const el = document.activeElement;
		if (el instanceof HTMLElement && el.matches('input, select, textarea')) {
			el.blur();
		}
		void saveAndAnswer();
	}

	/* Any plan the app reads, its own YAML or one of the four interchange
	 * formats (docs/route-files.md), through the ONE dispatcher every other
	 * inbound file takes (state/openFile), which asks the replace question
	 * when the plan on screen holds unsaved work. A recorded TRACE picked
	 * here imports as a trace, the file's content deciding rather than the
	 * row that opened it (docs/android.md). The READ is guarded too: on
	 * Android a provider can refuse the chooser's content URI or serve
	 * nothing, and an unguarded read rejects into nowhere. */
	async function onPick(e: Event): Promise<void> {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) {
			return;
		}
		try {
			await openIncomingBytes(file.name, new Uint8Array(await file.arrayBuffer()));
		} catch (err) {
			planFileReadFailed(err instanceof Error ? err.message : String(err));
		}
		// Cleared only once the file has been read, so the same one can be
		// picked again without the clearing racing a read still in flight.
		input.value = '';
	}
</script>

<svelte:window onkeydown={onWindowKey} />

<PlanMenu />

<input
	bind:this={fileInput}
	class="file-input"
	type="file"
	accept={pickerAccept(
		'.yaml,.yml,.fpl,.pln,.gpx,.kml,.kmz,text/yaml,application/vnd.garmin.flightplan,application/gpx+xml,application/vnd.google-earth.kml+xml,application/xml',
	)}
	aria-hidden="true"
	tabindex="-1"
	onchange={(e) => void onPick(e)}
/>

<!-- The receipt, read aloud: the chip that shows it can sit under a full
     surface. -->
<p class="sr-only" aria-live="polite">
	{planDocument.receipt === 'savedAs'
		? t.plan.savedAsNotice
		: planDocument.receipt === 'saved'
			? t.plan.savedNotice
			: ''}
</p>

{#if planDocument.question === 'replace'}
	<!-- Cancel keeps the focus; Discard is the destructive answer, last. -->
	<ConfirmDialog
		message={activePlan.source == null
			? t.plan.replaceNew(planIdentity())
			: t.plan.replaceDirty(planIdentity())}
		confirmLabel={t.plan.discard}
		danger
		altLabel={t.plan.saveAndContinue}
		onAlt={() => answerPlanQuestion('alt')}
		onConfirm={() => answerPlanQuestion('confirm')}
		onCancel={() => answerPlanQuestion('cancel')}
	/>
{:else if planDocument.question === 'lossy'}
	<ConfirmDialog
		message={t.plan.lossyConfirm}
		confirmLabel={t.plan.lossyAction}
		danger
		onConfirm={() => answerPlanQuestion('confirm')}
		onCancel={() => answerPlanQuestion('cancel')}
	/>
{:else if planDocument.question === 'conflict'}
	<ConfirmDialog
		message={t.plan.conflictConfirm}
		confirmLabel={t.plan.conflictAction}
		danger
		onConfirm={() => answerPlanQuestion('confirm')}
		onCancel={() => answerPlanQuestion('cancel')}
	/>
{/if}

<style>
	.file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		border: 0;
	}
</style>
