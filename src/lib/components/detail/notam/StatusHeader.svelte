<script lang="ts">
	import type { Notam } from '$lib/notam/types';
	import { formatVLimit } from '$lib/vertical/limits';
	import { notamStatus } from '$lib/format/datetime';
	import { decodeQ, t } from '$lib/state/i18n.svelte';
	import { notamState } from '$lib/state/notam.svelte';

	interface Props {
		notam: Notam;
		isTrigger: boolean;
	}
	let { notam, isTrigger }: Props = $props();

	// notamStatus evaluates Date.now(): track the shared minute heartbeat
	// while the chip can still change (future -> active / permanent ->
	// expired at the B)/C) boundaries), so an open panel migrates like the
	// list buckets. A terminal status (permanent, expired) skips the tick
	// and stops re-deriving.
	const status = $derived.by(() => {
		const s = notamStatus(notam.startDate, notam.endDate, notam.permanent);
		if (s === 'future' || s === 'active') {
			void notamState.tick;
		}
		return s;
	});
	const qDecoded = $derived(decodeQ(notam.qCode));

	// The catalog records carry literal keys; the parsed qualifier is an open
	// string, so the lookups widen at the read site and fall back to the code.
	const trafficLabel = (code: string): string =>
		(t.notam.traffic as Record<string, string>)[code] ?? code;
	const scopeLabel = (code: string): string =>
		(t.notam.scope as Record<string, string>)[code] ?? code;

	function qFlLabel(n: number): string {
		if (n === 0) {
			return 'SFC';
		}
		if (n === 999) {
			return 'UNL';
		}
		return 'FL' + String(n).padStart(3, '0');
	}

	// Vertical-limits chip: the operational F)/G) values when both parsed
	// (OPADD precedence; they are published as a pair, so a half-parsed
	// pair falls back to the Q-line rather than inventing a side), else the
	// Q-line FL band with its conventions (000 = from the surface, 999 =
	// unlimited or unknown). The all-default SFC-UNL pair states nothing
	// and gets no chip, as does a malformed (NaN) Q-line band.
	const vertChip = $derived.by(() => {
		if (notam.fgLower && notam.fgUpper) {
			return `${formatVLimit(notam.fgLower)} – ${formatVLimit(notam.fgUpper)}`;
		}
		const q = notam.qualifier;
		if (!q || !Number.isFinite(q.lower) || !Number.isFinite(q.upper)) {
			return null;
		}
		if (q.lower === 0 && q.upper === 999) {
			return null;
		}
		return `${qFlLabel(q.lower)} – ${qFlLabel(q.upper)}`;
	});
</script>

<div class="status-row">
	<span class="status status-{status}">{t.notam.status[status]}</span>
	{#if isTrigger}
		<span
			class="trigger-tag"
			title={t.notam.triggerTip}
		>TRIGGER</span>
	{/if}
</div>

{#if notam.qCode}
	<dl class="fields">
		<div class="field">
			<dt>{t.notam.fields.qCode}</dt>
			<dd><span class="qmono">{notam.qCode}</span> {qDecoded}</dd>
		</div>
		{#if notam.qualifier?.fir}
			<div class="field">
				<dt>{t.notam.fields.fir}</dt>
				<dd>{notam.qualifier.fir}</dd>
			</div>
		{/if}
	</dl>
{/if}

{#if notam.qualifier}
	<div class="chips">
		{#if notam.qualifier.traffic}
			<span class="chip">
				{trafficLabel(notam.qualifier.traffic)}
			</span>
		{/if}
		{#if notam.qualifier.scope}
			<span class="chip">
				{scopeLabel(notam.qualifier.scope)}
			</span>
		{/if}
		{#if vertChip}
			<span class="chip">{vertChip}</span>
		{/if}
	</div>
{/if}

<style>
	.status-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.status {
		align-self: flex-start;
		padding: 3px 9px;
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		border-radius: 999px;
	}

	.status-active {
		color: #fff;
		background: var(--status-active);
	}

	.status-future {
		color: var(--accent-text);
		background: var(--accent);
	}

	.status-expired {
		color: var(--text-muted);
		background: var(--surface-3);
	}

	.status-permanent {
		color: #fff;
		background: var(--status-neutral);
	}

	/* Status-row badge for activation NOTAMs (QR_CA family) whose body
	   names at least one airspace id or AIP SUP. Diagonal stripe echoes
	   the airspace-activation hatch on the map. */
	.trigger-tag {
		padding: 3px 9px;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #fff;
		background:
			repeating-linear-gradient(
				45deg,
				var(--airspace-restricted) 0,
				var(--airspace-restricted) 3px,
				color-mix(in srgb, var(--airspace-restricted) 70%, #fff) 3px,
				color-mix(in srgb, var(--airspace-restricted) 70%, #fff) 6px
			);
		border-radius: 999px;
	}

	.qmono {
		font-family: ui-monospace, monospace;
		font-weight: 600;
	}

	.fields {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
	}

	.field {
		display: flex;
		gap: 8px;
	}

	.field dt {
		flex: 0 0 70px;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.field dd {
		margin: 0;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.chip {
		padding: 3px 8px;
		font-size: 12px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 999px;
	}
</style>
