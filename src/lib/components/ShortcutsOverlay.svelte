<script lang="ts">
	/* The "?" map: a static list of the keys and pointer gestures that exist,
	 * grouped by the surface that answers them (the catalog IS the content,
	 * src/lib/i18n/en/shortcuts.ts; it documents, never defines). A small
	 * centred dialog on the shared .modal-backdrop / .modal-box chrome, the
	 * ResetDialog convention: deliberately NOT a workspace surface, since a
	 * read-only list needs no registry entry, placement or history entry. */
	import { t } from '$lib/state/i18n.svelte';
	import {
		closeShortcuts,
		openShortcuts,
		shortcutsOverlay,
	} from '$lib/state/shortcutsOverlay.svelte';
	import { focusTrap } from '$lib/ui/focusTrap';
	import { portal } from '$lib/ui/portal';

	let boxEl = $state<HTMLElement | null>(null);
	$effect(() => {
		if (shortcutsOverlay.open) {
			boxEl?.focus();
		}
	});

	function isEditable(el: EventTarget | null): boolean {
		return (
			el instanceof HTMLElement &&
			(el.tagName === 'INPUT' ||
				el.tagName === 'TEXTAREA' ||
				el.tagName === 'SELECT' ||
				el.isContentEditable)
		);
	}

	function onWindowKey(e: KeyboardEvent): void {
		// e.key resolves the layout (Shift+/ on QWERTY, the bare key on
		// AZERTY), so matching '?' itself is the whole binding.
		if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) {
			return;
		}
		if (shortcutsOverlay.open) {
			e.preventDefault();
			closeShortcuts();
			return;
		}
		// An open backdrop means a modal is already up (a modal surface, the
		// reset confirm): the key must not stack a dialog under or over it.
		if (document.querySelector('.modal-backdrop')) {
			return;
		}
		e.preventDefault();
		openShortcuts();
	}
</script>

<svelte:window onkeydown={onWindowKey} />

{#if shortcutsOverlay.open}
	<div use:portal>
		<button
			class="modal-backdrop"
			aria-label={t.common.dismiss}
			onpointerdown={closeShortcuts}
			oncontextmenu={(e) => e.preventDefault()}
		></button>
		<div
			class="modal-box at-dialog shortcuts-box"
			role="dialog"
			aria-modal="true"
			aria-labelledby="shortcuts-title"
			tabindex="-1"
			bind:this={boxEl}
			use:focusTrap
			onkeydown={(e: KeyboardEvent) => {
				// Focus is trapped inside, so Escape always lands here; stopping
				// it keeps the key from any surface's window-level handler
				// beneath (the ResetDialog rule).
				if (e.key === 'Escape') {
					e.stopPropagation();
					closeShortcuts();
				}
			}}
		>
			<h2 id="shortcuts-title">{t.shortcuts.title}</h2>
			<div class="cols">
				{#each t.shortcuts.groups as g (g.title)}
					<section class="grp">
						<h3>{g.title}</h3>
						{#each g.rows as r (r.text)}
							<div class="row">
								<span class="caps">
									{#each r.keys as k, i (i)}<kbd>{k}</kbd>{/each}
								</span>
								<span class="what">{r.text}</span>
							</div>
						{/each}
					</section>
				{/each}
			</div>
			<div class="actions">
				<button type="button" class="btn" onclick={closeShortcuts}>{t.common.close}</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.shortcuts-box {
		--modal-width: min(720px, 92vw);

		gap: 10px;
		padding: 16px;
		overflow-y: auto;
	}

	h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
	}

	/* Two columns of groups; a group never splits across the fold. */
	.cols {
		columns: 2;
		column-gap: 28px;
	}

	@media (max-width: 640px) {
		.cols {
			columns: 1;
		}
	}

	.grp {
		margin-bottom: 12px;
		break-inside: avoid;
	}

	.grp h3 {
		margin: 0 0 4px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 2px 0;
		font-size: 12.5px;
	}

	/* A fixed caps gutter aligns the descriptions within a group. */
	.caps {
		display: inline-flex;
		flex: 0 0 auto;
		gap: 3px;
		min-width: 92px;
	}

	kbd {
		padding: 1px 5px;
		font-family: ui-monospace, 'SF Mono', 'Cascadia Code', consolas, monospace;
		font-size: 11px;
		line-height: 1.5;
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border-strong);
		border-bottom-width: 2px;
		border-radius: 4px;
	}

	.what {
		min-width: 0;
		color: var(--text);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
	}

</style>
