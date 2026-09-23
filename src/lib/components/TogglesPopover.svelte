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
	 * around this component).
	 *
	 * The panel owns its keyboard, since it holds focus and sits OUTSIDE the
	 * surface box (the shell's `extra` snippet): Escape on it closes it and
	 * goes no further, and Tab cycles inside it. A docked or paged surface
	 * hears Escape only from inside its box, so the key closed nothing once
	 * focus moved into the panel; and a full-screen one traps Tab in its box,
	 * which the panel is not in, so Tab past the last row walked out to the
	 * app behind the modal backdrop. Once the panel has gone, focus is back on
	 * the trigger, inside the box, and the caller's SurfaceShell onEscape
	 * chain takes the next Escape. */
	import type { Snippet } from 'svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { dismissOnDown } from '$lib/ui/dismissOnDown';
	import { cycleTab } from '$lib/ui/focusTrap';

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
		/** Optional note / action under the rows, above the panel's edge:
		 *  what the list cannot say as a row (the airspace filter's
		 *  always-plotted rule and its reset). */
		footer?: Snippet;
	}
	const { rows, onToggle, anchorEl, onClose, footer }: Props = $props();

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

	/* Focus goes INTO the panel when it opens and back where it came from when
	 * it closes (PopupMenu's rule). At full screen or in a dialog the surface
	 * traps Tab inside its own box, and this panel, rendered beside the box
	 * and above it, was out of the keyboard's reach: its checkboxes could not
	 * be tabbed to at all. The PANEL takes focus, never its first row, and
	 * content that already placed focus inside keeps it. */
	$effect(() => {
		const box = panelEl;
		if (!box) {
			return;
		}
		const from = document.activeElement as HTMLElement | null;
		if (!box.contains(document.activeElement)) {
			box.focus({ preventScroll: true });
		}
		return () => {
			const now = document.activeElement;
			if (from?.isConnected && (now === null || now === document.body || box.contains(now))) {
				from.focus({ preventScroll: true });
			}
		};
	});
</script>

<!-- The click reaches the backdrop only from the keyboard (a pointer's
     down removed it before its click), so it is what makes the button
     named "Dismiss menu" do so. -->
<button
	class="ctx-backdrop no-print"
	aria-label={t.common.dismissMenu}
	onpointerdown={dismissOnDown(onClose)}
	onclick={onClose}
	oncontextmenu={(e) => e.preventDefault()}
></button>
<!-- The keydown is the panel's keyboard management (Escape, the Tab cycle),
     not an interaction of its own: the rows are the controls. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="toggles-panel no-print"
	bind:this={panelEl}
	tabindex="-1"
	style="left:{pos.left}px;top:{pos.top}px"
	onkeydown={(e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			e.stopPropagation();
			onClose();
		} else if (panelEl) {
			cycleTab(panelEl, e);
		}
	}}
>
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
	{#if footer}
		<div class="toggles-foot">{@render footer()}</div>
	{/if}
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

	/* Bounded to the viewport and scrollable inside it: a landscape phone is
	   358 px tall and the airspace filter's twelve 44 px rows plus its note
	   run past that, which would put the last rows out of reach. The
	   anchoring effect measures offsetHeight AFTER this clamp, so the flip
	   still lands the panel on screen. `contain` keeps an over-scroll off
	   the page and away from Android's back gesture (the profile strip's
	   rule). */
	.toggles-panel {
		position: fixed;
		z-index: 1102;
		min-width: 170px;
		max-height: calc(100dvh - 8px);
		padding: 4px;
		overflow-y: auto;
		overscroll-behavior: contain;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow-2);
	}

	/* Focus lands on the box itself only to put the keyboard inside it (its
	   rows keep their own rings). */
	.toggles-panel:focus {
		outline: none;
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

	/* The note (and its reset action) the rows cannot carry: separated by a
	   rule so it never reads as one more checkbox. */
	.toggles-foot {
		margin-top: 4px;
		padding: 6px 8px 2px;
		border-top: 1px solid var(--border);
		font-size: var(--fs-xs);
		color: var(--text-muted);
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
