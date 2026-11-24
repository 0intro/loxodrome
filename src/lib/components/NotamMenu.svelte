<script lang="ts">
	import { decodeQ, t } from '$lib/state/i18n.svelte';
	import { notamMenu, closeNotamMenu } from '$lib/state/notamMenu.svelte';
	import { selectNotam } from '$lib/state/ui.svelte';
	import PopupMenu from './PopupMenu.svelte';

	function onSelect(index: number): void {
		selectNotam(index);
		closeNotamMenu();
	}
</script>

<PopupMenu
	open={notamMenu.open}
	x={notamMenu.x}
	y={notamMenu.y}
	minWidthPx={260}
	onClose={closeNotamMenu}
>
	<div class="menu-title">{t.notam.menuTitle(notamMenu.items.length)}</div>
	{#each notamMenu.items as item, i (i)}
		{@const decoded = decodeQ(item.notam.qCode)}
		<button
			class="item"
			onclick={() => onSelect(item.index)}
			title={item.notam.fullContent.slice(0, 240)}
		>
			<span class="id">{item.notam.id}</span>
			{#if item.notam.qCode}
				<span class="qcode">{item.notam.qCode}</span>
			{/if}
			<span class="decoded">{decoded || '–'}</span>
		</button>
	{/each}
</PopupMenu>

<style>
	.menu-title {
		padding: 4px 8px 6px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.id {
		flex: 0 0 auto;
		font-family: ui-monospace, monospace;
		font-size: 12px;
		font-weight: 700;
	}

	.qcode {
		flex: 0 0 auto;
		padding: 1px 5px;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		font-weight: 600;
		background: var(--surface-3);
		border-radius: 3px;
	}

	.decoded {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--text-muted);
	}
</style>
