<script lang="ts">
	/* The detail on a PHONE: the `detail` workspace surface, the pane's
	 * third occupant beside the nav log and the profiles
	 * (docs/workspace-surfaces.md "Phones"). The desktop keeps its side
	 * panel (DetailPanel.svelte); App.svelte's bridge opens this surface
	 * while ui.detail names something and the layout is the phone's, and
	 * closes it otherwise. Presentation is the shared detailHead module, so
	 * the two homes cannot drift. The shell gives it the pane's head (the
	 * handle that cycles the detents, the X), the back entry and the
	 * eviction rules; this file only fills the head and the body. */
	import SurfaceShell from './SurfaceShell.svelte';
	import Icon from './Icon.svelte';
	import DetailBody from './detail/DetailBody.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { closeDetail, ui, type DetailTarget } from '$lib/state/ui.svelte';
	import { closeSurface, isOpen } from '$lib/state/workspace.svelte';
	import {
		centerSelected,
		detailBack,
		detailBackLabel,
		detailCanCenter,
		detailKeydown,
		detailScrollKey,
		detailSelection,
		detailPending,
		detailSubtitle,
		detailTitle,
		notamStepper,
		stepToNotam,
	} from './detail/detailHead.svelte';

	const selection = $derived(detailSelection());
	const open = $derived(isOpen('detail'));
	const pending = $derived(detailPending(selection));
	// A head with no words is a pane nobody can name, and the shell hands the
	// label to the region's aria-label.
	const title = $derived(
		detailTitle(selection) ||
			(pending === 'loading' ? t.detail.pendingTitleLoading : pending ? t.detail.pendingTitle : ''),
	);
	const subtitle = $derived(detailSubtitle(selection));
	const backLabel = $derived(detailBackLabel());
	const canCenter = $derived(detailCanCenter(selection));
	const stepper = $derived(notamStepper());

	/* Closing is BOTH halves at once: the selection and the surface. The
	 * bridge effect would close the surface a tick after the selection
	 * clears, but an eviction (another surface claiming the pane) checks the
	 * slot synchronously, so the surface has to be gone before it looks. */
	function close(): void {
		closeDetail();
		closeSurface('detail');
	}

	// Per-target scroll memory: navigating between linked panels (an airport
	// to a NOTAM and back) restores the previous panel's scroll position
	// rather than jumping to the top. The DetailPanel idiom.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const scrollPositions = new Map<string, number>();
	let scrollEl = $state<HTMLDivElement>();
	let prevDetail: DetailTarget | null = null;

	function onScroll(): void {
		if (prevDetail && scrollEl) {
			scrollPositions.set(detailScrollKey(prevDetail), scrollEl.scrollTop);
		}
	}

	$effect(() => {
		const next = ui.detail;
		prevDetail = next;
		if (!next || !open) {
			return;
		}
		const saved = scrollPositions.get(detailScrollKey(next)) ?? 0;
		// Next frame, once the body has rendered; cancelled on teardown so a
		// subject swapped inside that frame does not inherit the previous
		// one's offset.
		const frame = requestAnimationFrame(() => {
			if (scrollEl) {
				scrollEl.scrollTop = saved;
			}
		});
		return () => cancelAnimationFrame(frame);
	});
</script>

<svelte:window onkeydown={(e: KeyboardEvent) => open && detailKeydown(e, stepper)} />

<SurfaceShell id="detail" onClose={close} label={title} boxClass="detail-box" closeLabel={t.common.closeDetail}>
	{#snippet header()}
		{#if backLabel}
			<button class="modal-close back-btn" title={backLabel} aria-label={backLabel} onclick={detailBack}>
				<Icon name="chevron-left" size={16} />
			</button>
		{/if}
		<h2 class="detail-title">
			<span class="detail-id">{title}</span>
			<span class="detail-sub">{subtitle}</span>
		</h2>
		{#if stepper}
			<nav class="stepper" aria-label={t.common.stepThroughList}>
				<button
					class="modal-close"
					disabled={stepper.prev === null}
					onclick={() => stepper.prev !== null && stepToNotam(stepper.prev)}
					aria-label={t.common.prevNotam}
				>
					<Icon name="chevron-left" size={16} />
				</button>
				<span class="step-pos">{stepper.pos + 1} / {stepper.total}</span>
				<button
					class="modal-close"
					disabled={stepper.next === null}
					onclick={() => stepper.next !== null && stepToNotam(stepper.next)}
					aria-label={t.common.nextNotam}
				>
					<Icon name="chevron-right" size={16} />
				</button>
			</nav>
		{/if}
		<button
			class="modal-close"
			onclick={() => centerSelected(selection)}
			disabled={!canCenter}
			aria-label={t.common.centerMapAria}
			title={t.common.centerMap}
		>
			<Icon name="crosshair" size={16} />
		</button>
	{/snippet}
	<div class="body detail-scroll" bind:this={scrollEl} onscroll={onScroll}>
		<DetailBody {selection} />
	</div>
</SurfaceShell>

<style>
	/* The body scrolls inside the pane; the head is the shell's. */
	:global(.modal-box.detail-box) {
		overflow: hidden;
	}

	.detail-scroll {
		flex: 1;
		min-height: 0;
		padding: 10px 12px;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.detail-title {
		display: flex;
		gap: 6px;
		align-items: baseline;
		min-width: 0;
		margin: 0;
		overflow: hidden;
		font-size: 13px;
		white-space: nowrap;
	}

	.detail-id {
		font-weight: 700;
	}

	.detail-sub {
		overflow: hidden;
		font-size: 10px;
		font-weight: 400;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		text-overflow: ellipsis;
	}

	.stepper {
		display: flex;
		flex: 0 0 auto;
		gap: 2px;
		align-items: center;
	}

	.step-pos {
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
		white-space: nowrap;
	}
</style>
