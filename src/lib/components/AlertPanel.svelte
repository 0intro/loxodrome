<script lang="ts">
	/* The alert panel: the RECORD half of the alert surface
	 * (docs/nav-alerts.md "Presentation"). The strip's banner row carries
	 * only the dominant unacknowledged alert; this panel, opened from the
	 * channel chip, lists everything: the active alerts ranked, the
	 * acknowledged ones put away under a disclosure (the G1000
	 * active-white / inactive-grey convention), the data caveats, and the
	 * lifecycle stated in words. Presented through HeadOverlay (the
	 * FiltersPopover idiom): an anchored popup on desktop, a bottom sheet
	 * on phones; Escape / Back / backdrop are the overlay's own.
	 *
	 * Section order is deliberate: active, acknowledged, [the transient
	 * events lane slots here later, docs/nav-live-comparison.md item 9],
	 * caveats, caption. */
	import HeadOverlay from './HeadOverlay.svelte';
	import Icon from './Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { alertAnnounce, alertLine, openAlertPanel } from './alertText';
	import type { AlertSurfaceModel } from '$lib/nav/alertSurface';
	import type { VolumeAlert } from '$lib/nav/airspaceAlert';
	import { acknowledgeAlert } from '$lib/state/airspaceAlert.svelte';

	let {
		open,
		x,
		y,
		model,
		onClose,
	}: {
		open: boolean;
		x: number;
		y: number;
		model: AlertSurfaceModel;
		onClose: () => void;
	} = $props();

	/** Opening a volume's detail panel answers the question; the panel has
	 *  served and folds away (the menu convention). */
	function openDetail(a: VolumeAlert): void {
		openAlertPanel(a);
		onClose();
	}
</script>

<HeadOverlay {open} {x} {y} title={t.navigation.alertsSection} minWidthPx={440} maxWidthPx={460} {onClose}>
	<!-- Not a list: the box holds the alert rows, a disclosure of the
	     acknowledged ones and the standing notes, and role="list" over that
	     both admitted children that are not items and left the acknowledged
	     rows claiming to be items with no list above them. Each row is a
	     named button, which is what carries it. -->
	<div class="panel" aria-label={t.navigation.alertsSection}>
		{#if model.panel.active.length === 0 && model.panel.acked.length === 0}
			<p class="note">{t.navigation.alertPanelEmpty}</p>
		{/if}
		{#each model.panel.active as a (a.key)}
			<div
				class="arow"
				class:avoid={a.action === 'avoid' && !a.planned}
				class:caution={a.action === 'caution'}
				class:inside={a.severity === 'inside' && !a.planned}
				class:planned={a.planned}
			>
				<button
					type="button"
					class="alert-open"
					title={t.navigation.alertOpenTip}
					aria-label={alertAnnounce(a)}
					onclick={() => openDetail(a)}>{alertLine(a)}</button
				>
				<button
					type="button"
					class="alert-ack"
					title={t.navigation.alertAckTip}
					aria-label={t.navigation.alertAckLabel}
					onclick={() => acknowledgeAlert(a.key)}
				>
					<Icon name="x" size={12} />
				</button>
			</div>
		{/each}
		{#if model.panel.acked.length > 0}
			<details class="acked-group">
				<summary>{t.navigation.alertAckedSection(String(model.panel.acked.length))}</summary>
				{#each model.panel.acked as a (a.key)}
					<div class="arow acked">
						<button
							type="button"
							class="alert-open"
							title={t.navigation.alertOpenTip}
							onclick={() => openDetail(a)}>{alertLine(a)}</button
						>
					</div>
				{/each}
				<p class="note">{t.navigation.alertAckedNote}</p>
			</details>
		{/if}
		{#each model.panel.caveats as c (c)}
			<p
				class="caveat"
				class:lost={c === 'airspaces'}
				title={c === 'airspaces' ? t.navigation.alertNoAirspacesTip : t.navigation.alertNoBriefingTip}
			>
				<Icon name="alert-triangle" size={13} />
				{c === 'airspaces' ? t.navigation.alertNoAirspaces : t.navigation.alertNoBriefing}
			</p>
		{/each}
		<p class="note">{t.navigation.alertLifecycleNote}</p>
	</div>
</HeadOverlay>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 3px;
	}

	/* The banner grammar's row form (NavStrip's .alert family): the body
	   opens the volume's detail panel, the cross acknowledges. Ink per
	   tier through the one --alert-ink device; solid only for the
	   unplanned inside form; planned dashed; acked dimmed. */
	.arow {
		--alert-ink: var(--nav-orange);

		display: flex;
		gap: 6px;
		align-items: center;
		padding: 3px 7px;
		font-size: 12px;
		font-weight: 600;
		color: var(--alert-ink);
		background: color-mix(in srgb, var(--alert-ink) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--alert-ink) 30%, transparent);
		border-radius: var(--radius-sm);
	}

	.arow.avoid {
		--alert-ink: var(--danger);
	}

	.arow.caution {
		--alert-ink: var(--workbook-orange);
	}

	.arow.inside {
		color: var(--surface);
		background: var(--alert-ink);
		border-color: var(--alert-ink);
	}

	.arow.planned {
		border-style: dashed;
		opacity: 0.85;
	}

	.arow.acked {
		opacity: 0.55;
	}

	.alert-open {
		flex: 1;
		min-width: 0;
		padding: 0;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
		background: none;
		border: none;
	}

	.alert-ack {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		color: inherit;
		cursor: pointer;
		background: none;
		border: none;
		border-radius: var(--radius-sm);
	}

	.alert-ack:hover {
		background: color-mix(in srgb, currentcolor 14%, transparent);
	}

	.acked-group summary {
		padding: 2px 4px;
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--text-muted);
		cursor: pointer;
		user-select: none;
	}

	.acked-group .arow {
		margin-top: 3px;
	}

	.caveat {
		--alert-ink: var(--workbook-orange);

		display: flex;
		gap: 6px;
		align-items: center;
		margin: 0;
		padding: 3px 7px;
		font-size: 12px;
		font-weight: 600;
		color: var(--alert-ink);
		background: color-mix(in srgb, var(--alert-ink) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--alert-ink) 30%, transparent);
		border-radius: var(--radius-sm);
	}

	.caveat.lost {
		--alert-ink: var(--danger);
	}

	.note {
		margin: 2px 4px;
		font-size: var(--fs-2xs);
		color: var(--text-muted);
	}

	/* In flight this is read with gloves on (the touch-ui doctrine). */
	:global(:root.touch-ui) .arow {
		min-height: 44px;
	}

	:global(:root.touch-ui) .alert-ack {
		min-width: 44px;
		min-height: 44px;
	}

	:global(:root.touch-ui) .acked-group summary {
		min-height: 44px;
		line-height: 40px;
	}
</style>
