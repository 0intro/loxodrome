<script lang="ts">
	/* The positioned popup shell shared by the map context menu and the
	 * NOTAM-stack menu: a transparent dismiss backdrop raised over the
	 * docked surfaces, a fixed box flipped and clamped to the viewport at
	 * the invocation point, Escape and the system Back gesture both
	 * dismissing. Content is the caller's. */
	import type { Snippet } from 'svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { registerBackClose } from '$lib/ui/backClose';
	import { dismissOnDown } from '$lib/ui/dismissOnDown';

	let {
		open,
		x,
		y,
		minWidthPx = 280,
		maxWidthPx = 380,
		aboveSurface = false,
		onClose,
		children,
	}: {
		open: boolean;
		x: number;
		y: number;
		minWidthPx?: number;
		/** The .menu CSS cap by default; the alert panel widens it. */
		maxWidthPx?: number;
		/** Raise the menu over a modal surface box instead of resting in the
		 *  popup band. A full-screen or dialog surface sits at z 1100
		 *  (app.css), above the band, so a menu opened from its own header
		 *  lands UNDERNEATH the box: present, laid out, and neither visible
		 *  nor clickable. Callers inside a surface pass this from that
		 *  surface's placement; see HeadOverlay's `surface`. */
		aboveSurface?: boolean;
		onClose: () => void;
		children: Snippet;
	} = $props();

	let menuEl = $state<HTMLDivElement>();
	let pos = $state({ left: 0, top: 0 });

	// Position the box at the invocation point, flipping and clamping to
	// the viewport.
	$effect(() => {
		if (!open || !menuEl) {
			return;
		}
		const m = 4;
		const w = menuEl.offsetWidth;
		const h = menuEl.offsetHeight;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		let left = x;
		if (left + w > vw - m) {
			left = x - w;
		}
		if (left < m) {
			left = Math.max(m, vw - w - m);
		}
		let top = y;
		if (top + h > vh - m) {
			top = y - h;
		}
		if (top < m) {
			top = Math.max(m, vh - h - m);
		}
		pos = { left, top };
	});

	/* Dismiss on the DOWN, a touch's following click swallowed
	 * (ui/dismissOnDown.ts, where the reasons are). */
	const dismiss = dismissOnDown(() => onClose());

	/* Focus goes INTO the menu when it opens and back where it came from when
	 * it closes. The box is portaled to the end of <body>, so Tab from the
	 * head button that opened it walked the rest of the toolbar and never
	 * reached the menu, and a menu row that opens another overlay destroys the
	 * element holding focus, dropping it on <body>. The BOX takes focus, never
	 * its first control: a popover whose first control is a field would put
	 * up a phone's keyboard for a menu the pilot only wanted to glance at, and
	 * content that already placed focus inside keeps it. Handed back only when
	 * focus was lost or is still inside, so a close that sent it somewhere on
	 * purpose is left alone. */
	$effect(() => {
		if (!open || !menuEl) {
			return;
		}
		const box = menuEl;
		const from = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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

	// System/browser Back dismisses the menu (the Android back gesture).
	$effect(() => {
		if (!open) {
			return;
		}
		return registerBackClose(onClose);
	});

	/* Is an Escape the menu's own? Only while the keyboard is in it, or
	 * nowhere (a row that removed itself drops focus on <body>). A dialog
	 * opened OVER the menu from the keyboard (Ctrl+K, "?") holds focus, and
	 * taken here in the capture phase its first Escape closed the hidden menu
	 * and left the visible dialog up. */
	function escapeIsMine(): boolean {
		const at = document.activeElement;
		return at === null || at === document.body || (menuEl?.contains(at) ?? false);
	}
</script>

<!-- In the CAPTURE phase, and the key consumed: a surface's own Escape (the
     SurfaceShell's window handler) closed the whole full-screen surface on
     the very key that was meant to close this menu over it. -->
<svelte:window
	onkeydowncapture={(e: KeyboardEvent) => {
		if (e.key === 'Escape' && open && escapeIsMine()) {
			e.stopPropagation();
			onClose();
		}
	}}
/>

{#if open}
	<!-- transparent backdrop: a click anywhere dismisses the menu -->
	<button
		class="backdrop no-print"
		class:above={aboveSurface}
		aria-label={t.common.dismissMenu}
		onpointerdown={dismiss}
		oncontextmenu={(e) => e.preventDefault()}
	></button>
	<!-- Portaled chrome sits outside #app, which the print flows hide
	     wholesale, so it carries its own no-print: a menu never prints. -->
	<div
		class="menu menu-panel no-print"
		class:above={aboveSurface}
		bind:this={menuEl}
		tabindex="-1"
		style="left:{pos.left}px;top:{pos.top}px;min-width:{minWidthPx}px;max-width:{maxWidthPx}px"
	>
		{@render children()}
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;

		/* Above docked and paged surfaces (1090), below the modal
		   backdrop (1099): a menu raised next to a dock has to be
		   visible and clickable, and its dismiss layer has to
		   intercept over the dock too. */
		z-index: 1095;
		padding: 0;
		border: none;
		background: transparent;
		cursor: default;
	}

	/* Over a modal surface box (1100), the ProfileStackMenu / TogglesPopover
	   band: those two menus are raised from inside a surface for the same
	   reason and have always sat here. */
	.backdrop.above {
		z-index: 1101;
	}

	.menu {
		position: fixed;
		z-index: 1096;
		max-width: 380px;
		max-height: 60vh;
		overflow-y: auto;
		padding: 4px;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow-2);
	}

	/* The box takes focus so Tab reaches its rows; a ring round the whole
	   menu would say nothing a row's own ring does not. */
	.menu:focus {
		outline: none;
	}

	.menu.above {
		z-index: 1102;
	}
</style>
