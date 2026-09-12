<script lang="ts">
	/* The incoming-file lifecycle: one component mounted once from App (the
	 * PersistHost idiom). It subscribes to the files Android hands the app
	 * (native/openFile.ts; nothing happens on the web) and carries the three
	 * surfaces the dispatcher needs and no tab owns: the failure banner, the
	 * confirm that guards a recorded trace from being replaced, and the
	 * altitude-reference question an IGC file that states none has to ask.
	 * Every successful open reports where its own tab already reports it.
	 *
	 * That question lives HERE rather than on whichever surface started the
	 * import, because a surface can be closed or evicted while it stands and
	 * the importer awaiting it would then wait for ever (the flights batch
	 * importer latches a module guard for the whole run). */

	import { onMount } from 'svelte';
	import Banner from './Banner.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { bytesOfIncoming, watchIncomingFiles } from '$lib/native/openFile';
	import { t } from '$lib/state/i18n.svelte';
	import TraceDatumDialog from './TraceDatumDialog.svelte';
	import {
		answerTraceDatum,
		applyPendingTrace,
		dismissOpenFailure,
		dismissPendingTrace,
		openFile,
		openIncomingBytes,
		openIncomingFile,
	} from '$lib/state/openFile.svelte';
	import { flightImport } from '$lib/state/flightImport.svelte';

	onMount(() => {
		void watchIncomingFiles((file) => {
			// A binary file (a KMZ, a flights bundle) arrives as bytes rather
			// than text: reading it as text would shred it beyond recovery.
			// Past a megabyte it arrives as a PATH instead, since the bridge is
			// a JSON channel and a whole library would cross it as one base64
			// string (docs/android.md); bytesOfIncoming answers both.
			void (async () => {
				let bytes: Uint8Array | null;
				try {
					bytes = await bytesOfIncoming(file);
				} catch (err) {
					openFile.failure = {
						name: file.name,
						reason: 'failed',
						detail: err instanceof Error ? err.message : String(err),
					};
					return;
				}
				if (bytes) {
					await openIncomingBytes(file.name, bytes);
					return;
				}
				await openIncomingFile(file.name, file.text);
			})();
		});
		// A question with nobody left to answer it resolves as a cancel,
		// rather than leaving its awaiter hanging for the session.
		return () => answerTraceDatum(null);
	});

	/* Worded at render from the stored code, so a locale switch re-words a
	 * standing banner; the detail line is the upstream parser message and stays
	 * as it came (docs/i18n.md rule 7). A provider that publishes no display
	 * name leaves the sentence with a plain noun instead. */
	const failureText = $derived.by(() => {
		const failure = openFile.failure;
		if (!failure) {
			return '';
		}
		const name = failure.name || t.common.openFileUnknownName;
		const head =
			failure.reason === 'unsupported'
				? t.common.openFileUnsupported(name)
				: t.common.openFileFailed(name);
		return failure.detail ? `${head} ${failure.detail}` : head;
	});
</script>

{#if openFile.failure}
	<Banner text={failureText} dismissLabel={t.common.dismiss} onDismiss={dismissOpenFailure} />
{/if}

{#if openFile.pendingTrace}
	<ConfirmDialog
		message={t.navigation.replaceConfirm}
		confirmLabel={t.navigation.replaceConfirmAction}
		danger
		onConfirm={applyPendingTrace}
		onCancel={dismissPendingTrace}
	/>
{:else if openFile.askingDatum}
	<TraceDatumDialog
		note={flightImport.datumFiles > 0
			? t.flights.datumBatchNote(flightImport.datumFiles)
			: undefined}
		onChoose={answerTraceDatum}
		onCancel={() => answerTraceDatum(null)}
	/>
{/if}
