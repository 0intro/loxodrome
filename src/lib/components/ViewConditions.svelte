<script lang="ts">
	/* The app-wide viewing conditions as toolbar chrome: the period and the
	 * level band the WHOLE map is read at (NOTAMs, SUP AIP zones, airspace
	 * activation, SIGMETs, cue rings), not a NOTAM-list filter. State reads on
	 * the left beside the brand; the icon cluster past the spacer stays tools.
	 *
	 * They live here rather than in the NOTAMs tab's funnel because that funnel
	 * only renders once a briefing is loaded, and these two govern the map with
	 * or without one. Every EFB surveyed gives them a permanent readout for the
	 * same reason: a condition that silently hides airspace must say so.
	 *
	 * Both chips open ONE popover, portaled by HeadOverlay, which is what keeps
	 * it off the floor: .toolbar is a z-600 stacking context (a flex item with a
	 * z-index), so a fixed overlay rendered inside it would paint UNDER
	 * Leaflet's z-1000 controls, the trap HeadOverlay documents for the
	 * sidebar. */
	import { filter, altitudeError, windowError } from '$lib/state/filter.svelte';
	import { plannedFlightWindow } from '$lib/state/timeWindow.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import { formatZuluSpan, groupThousands } from '$lib/format/datetime';
	import Icon from './Icon.svelte';
	import ViewConditionsPopover from './ViewConditionsPopover.svelte';

	let open = $state(false);
	/** Which chip owns the disclosure, so only IT reports expanded. */
	let which = $state<'period' | 'levels' | null>(null);
	let anchor = $state({ x: 0, y: 0 });
	const uid = $props.id();

	const winErr = $derived(windowError());
	const altErr = $derived(altitudeError());
	const mode = $derived(filter.window.mode);
	const periodDefault = $derived(mode === 'now');
	/* The level chip is emphasised when the band RESTRICTS, not when it is
	 * away from its default: the default IS a restriction (0 to 10 000 ft),
	 * so keying on "non-default" put the accent on the one state that hides
	 * nothing and left the state that hides upper CTAs, the LTA at
	 * FL115-195, high-level SIGMETs and every NOTAM above 10 000 ft looking
	 * inert. Pressing the list's "Show all" even lit the chip up. This is
	 * also the reading the state module already takes: clearFilterDimension
	 * clears the band by switching it OFF, calling that its non-restricting
	 * state. The docstring above states the principle the old rule broke. */
	const levelsRestrict = $derived(filter.altitude.enabled);

	const periodText = $derived.by(() => {
		if (winErr) {
			return t.conditions.periodInvalid;
		}
		if (mode === 'custom') {
			const d = filter.window;
			const part = (date: string, time: string): string =>
				date ? date + (time && time !== '00:00' ? ' ' + time : '') : '–';
			return `${part(d.fromDate, d.fromTime)} – ${part(d.toDate, d.toTime)}`;
		}
		if (mode === 'flight') {
			const w = plannedFlightWindow();
			return w ? formatZuluSpan(w.from, w.to) : t.conditions.flight;
		}
		const h = filter.window.horizonH;
		return h == null ? t.conditions.now : t.conditions.next(h);
	});

	const levelsText = $derived(
		filter.altitude.enabled
			? `${groupThousands(filter.altitude.floor)}–${groupThousands(filter.altitude.ceiling)} ft`
			: t.conditions.allLevels,
	);

	function openFrom(e: MouseEvent, w: 'period' | 'levels'): void {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		anchor = { x: r.left, y: r.bottom + 4 };
		// Toggle, the Toolbar More-menu form: a mouse press on the dismiss
		// backdrop closes first and the retargeted click never reaches the
		// button, so this only ever re-fires for keyboard Enter / Space.
		open = !(open && which === w);
		which = open ? w : null;
	}

	function close(): void {
		open = false;
		which = null;
	}
</script>

{#if ui.isMobile}
	<div class="conds compact">
		<button
			class="cond stack"
			onclick={(e) => openFrom(e, 'period')}
			aria-expanded={open}
			aria-controls={open ? `${uid}-vc` : undefined}
			title={winErr ??
				altErr ??
				t.conditions.chipTitle({
					axis: t.conditions.title,
					value: `${periodText} · ${levelsText}`,
				})}
		>
			<span class="sr-only">{t.conditions.title}</span>
			<span class="cond-line" class:set={!periodDefault} class:bad={winErr !== null}>
				{periodText}
			</span>
			<span class="cond-line" class:set={levelsRestrict} class:bad={altErr !== null}>
				{levelsText}
			</span>
		</button>
	</div>
{:else}
	<div class="conds">
		<button
			class="cond"
			class:set={!periodDefault}
			class:bad={winErr !== null}
			onclick={(e) => openFrom(e, 'period')}
			aria-expanded={open && which === 'period'}
			aria-controls={open && which === 'period' ? `${uid}-vc` : undefined}
			title={winErr ??
				t.conditions.chipTitle({ axis: t.conditions.period, value: periodText })}
		>
			<span class="sr-only">{t.conditions.period}</span>
			{#if mode === 'flight'}
				<!-- The provenance mark the NOTAMs tab uses for a route-driven filter. -->
				<span class="cond-prov"><Icon name="route" size={11} /></span>
			{/if}
			<span class="cond-value">{periodText}</span>
		</button>
		<button
			class="cond"
			class:set={levelsRestrict}
			class:bad={altErr !== null}
			onclick={(e) => openFrom(e, 'levels')}
			aria-expanded={open && which === 'levels'}
			aria-controls={open && which === 'levels' ? `${uid}-vc` : undefined}
			title={altErr ??
				t.conditions.chipTitle({ axis: t.conditions.levels, value: levelsText })}
		>
			<span class="sr-only">{t.conditions.levels}</span>
			<span class="cond-value">{levelsText}</span>
		</button>
	</div>
{/if}

<ViewConditionsPopover
	{open}
	x={anchor.x}
	y={anchor.y}
	id="{uid}-vc"
	onClose={close}
/>

<style>
	/* One pill, two halves: the chip grammar the NOTAMs tab uses for its filter
	   chips, so a value that is also a button reads as pressable. */
	.conds {
		display: flex;
		min-width: 0;
		flex: 0 1 auto;
		align-items: stretch;
		margin-left: 2px;
		overflow: hidden;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 999px;
	}

	.cond {
		display: inline-flex;
		min-width: 0;
		max-width: 26ch;
		align-items: center;
		gap: 5px;
		padding: 4px 10px;
		font: inherit;
		font-size: 12px;

		/* A ticking value must not reflow the bar. */
		font-variant-numeric: tabular-nums;
		line-height: 1.25;
		color: var(--text-muted);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.cond + .cond {
		border-left: 1px solid var(--border);
	}

	/* The value truncates; the title carries it whole. */
	.cond-value {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.cond:hover {
		color: var(--text);
		background: var(--surface-3);
	}

	.cond:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	/* The open chip reads as pressed; the ink rules below still say whether the
	   value is default, set, or unusable. */
	.cond[aria-expanded='true'] {
		background: var(--surface-3);
	}

	/* Away from the default: the mark the app uses for "this one is doing
	   something". */
	.cond.set {
		font-weight: 600;
		color: var(--accent);
	}

	/* A range the map cannot use (from > to, floor > ceiling). The value is
	   inert, so it must not read like a live setting; the error text rides
	   the title. */
	.cond.bad {
		color: var(--danger);
	}

	.cond-prov {
		display: inline-flex;
		color: var(--accent);
	}

	/* 44 < --toolbar-h (52), so the bar keeps its height. */
	:global(:root.touch-ui) .cond {
		min-height: 44px;
	}

	/* Phone: one chip, two stacked lines. Both readouts survive the collapse
	   (they are the point), and the stack is narrower than the joined one-line
	   form the bar has no room for. The column CENTRES on the cross of the
	   44 px touch box: without it the lines sat at the top and the slack
	   fell below, reading as a top-heavy pill. */
	.conds.compact .cond {
		max-width: 40vw;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 0;
		padding: 2px 9px;
		font-size: 11px;
		line-height: 1.2;
	}

	/* A toolbar setting, not an in-flight control: it keeps a generous
	   target, but the full 44 floor made it the fattest thing on the bar. */
	:global(:root.touch-ui) .conds.compact .cond {
		min-height: 40px;
	}

	.conds.compact .cond-line {
		max-width: 100%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.conds.compact .cond-line.set {
		font-weight: 600;
		color: var(--accent);
	}

	.conds.compact .cond-line.bad {
		color: var(--danger);
	}
</style>
