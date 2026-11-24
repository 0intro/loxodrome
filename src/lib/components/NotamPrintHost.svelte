<script lang="ts">
	/* Print-only host for the NOTAMs tab's "print all NOTAMs" bulletin. Mounted
	 * once in App; each requestNotamPrint bump mounts NotamPrintDoc through the
	 * shared portal (outside #app, which the print isolation hides), lets layout
	 * settle, prints, and clears on afterprint. Synchronous by design (the
	 * NOTAMs are already parsed), so unlike WxPrintHost it needs no prefetch,
	 * progress overlay, or cross-modal cancel: window.print() fires within a
	 * couple of frames of the request. */

	import { tick } from 'svelte';
	import { markDocumentPrint } from '$lib/ui/surfacePrint.svelte';
	import { printBusy } from '$lib/state/printProgress.svelte';
	import { planPrintStem } from '$lib/state/printName';
	import { printPage } from '$lib/ui/print';
	import { DOCUMENT_ORIENTATION, installDocumentPageCss } from '$lib/ui/printJob';
	import NotamPrintDoc from './NotamPrintDoc.svelte';
	import { portal } from '$lib/ui/portal';
	import { notamPrint } from '$lib/state/notamPrint.svelte';

	let printing = $state(false);
	// Plain (non-reactive) so the job's own writes can't re-trigger the effect;
	// it tracks only notamPrint.seq.
	let lastSeq = 0;

	$effect(() => {
		const seq = notamPrint.seq;
		if (seq !== lastSeq) {
			lastSeq = seq;
			// Escape the effect's tracking context before doing the work.
			queueMicrotask(() => void run());
		}
	});

	async function run(): Promise<void> {
		if (printing || printBusy()) {
			return;
		}
		printing = true;
		await tick(); // mount the doc + add the isolation class
		// One frame for layout to settle (text only, so no image decode pass).
		await new Promise((res) => requestAnimationFrame(() => res(undefined)));
		window.addEventListener('afterprint', reset, { once: true });
		// This flow prints a document of its own, so the user-print claim
		// must stay out of its way (surfacePrint).
		markDocumentPrint(planPrintStem('notam'));
		printPage(DOCUMENT_ORIENTATION);
	}

	function reset(): void {
		printing = false;
	}

	// While printing, isolate the app and inject the landscape @page
	// (installDocumentPageCss), its margin zero like every document flow's:
	// the bulletin carries the kneeboard's margins as its own padding
	// (NotamPrintDoc).
	$effect(() => {
		if (!printing) {
			return;
		}
		return installDocumentPageCss(['notam-print']);
	});
</script>

{#if printing}
	<div use:portal>
		<NotamPrintDoc />
	</div>
{/if}
