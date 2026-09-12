<script lang="ts" generics="Key extends string">
	/* An anchored popover of checkbox rows, shared by the surfaces whose
	 * headers offer a small "what to show" list: the profile modals' Layers
	 * and the nav-log's Columns. Both had been written out in full, twice,
	 * with the same anchoring effect, the same backdrop and the same CSS
	 * under two sets of class names.
	 *
	 * The panel is fixed with its own backdrop ABOVE the modal box (the
	 * ctx-menu layering): a surface header is overflow-x auto, so a
	 * header-anchored absolute child would be clipped. It anchors to the
	 * trigger's rect, right-aligned, flipping above when it would overflow.
	 * The caller owns the trigger button and the open state (an {#if}
	 * around this component); Escape routes through the caller's
	 * SurfaceShell onEscape chain, which closes the popover before the
	 * surface. */
	import { t } from '$lib/state/i18n.svelte';

	interface Row<K> {
		key: K;
		label: string;
		/** Tooltip; the row's own explanation where it has one. */
		tip?: string;
		checked: boolean;
	}

	interface Props {
		/** The rows this surface offers, in display order. */
		rows: Row<Key>[];
		onToggle: (key: Key, on: boolean) => void;
		/** The header button the panel anchors to. */
		anchorEl: HTMLElement | undefined;
		/** Backdrop dismissal; the caller flips its open flag. */
		onClose: () => void;
	}
	const { rows, onToggle, anchorEl, onClose }: Props = $props();

	let panelEl = $state<HTMLDivElement>();
	let pos = $state({ left: 0, top: 0 });

	$effect(() => {
		if (!panelEl || !anchorEl) {
			return;
		}
		const m = 4;
		const r = anchorEl.getBoundingClientRect();
		const w = panelEl.offsetWidth;
		const h = panelEl.offsetHeight;
		const left = Math.min(Math.max(m, r.right - w), window.innerWidth - w - m);
		let top = r.bottom + m;
		if (top + h > window.innerHeight - m) {
			top = Math.max(m, r.top - h - m);
		}
		pos = { left, top };
	});
</script>

<button
	class="ctx-backdrop no-print"
	aria-label={t.common.dismissMenu}
	onpointerdown={onClose}
	oncontextmenu={(e) => e.preventDefault()}
></button>
<div class="toggles-panel no-print" bind:this={panelEl} style="left:{pos.left}px;top:{pos.top}px">
	{#each rows as row (row.key)}
		<label class="toggle-row" title={row.tip}>
			<input
				type="checkbox"
				checked={row.checked}
				onchange={(e) => onToggle(row.key, e.currentTarget.checked)}
			/>
			<span>{row.label}</span>
		</label>
	{/each}
</div>

<style>
	/* The backdrop and panel share the ctx-menu layering (fixed, above the
	 * modal box at 1100); rows are checkbox labels. */
	.ctx-backdrop {
		position: fixed;
		inset: 0;
		z-index: 1101;
		padding: 0;
		border: none;
		background: transparent;
		cursor: default;
	}

	.toggles-panel {
		position: fixed;
		z-index: 1102;
		min-width: 170px;
		padding: 4px;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow-2);
	}

	.toggle-row {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 5px 8px;
		font-size: var(--fs-sm);
		color: var(--text);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.toggle-row:hover {
		background: var(--surface-3);
	}

	.toggle-row input {
		accent-color: var(--accent);
	}

	/* These sit on surface headers worked in flight (the profile layers, the
	   nav-log columns), so they take the app's touch floor. */
	:global(:root.touch-ui) .toggle-row {
		min-height: 44px;
	}

	:global(:root.touch-ui) .toggle-row input[type='checkbox'] {
		width: 18px;
		height: 18px;
	}
</style>
