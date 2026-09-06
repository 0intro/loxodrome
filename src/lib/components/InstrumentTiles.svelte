<script lang="ts">
	/* The glanceable figures a pilot reads in flight: ground speed, magnetic
	 * track and the GNSS altitude on MSL.
	 *
	 * Extracted from the Navigation tab so the in-flight strip owns them: the
	 * sidebar unmounts a tab as soon as another is selected, which is the one
	 * thing an instrument must not do. Sized to be read at arm's length on a
	 * mounted phone, and they wrap rather than shrink.
	 *
	 * Each figure holds ONE width whatever it reads: the track is formatted
	 * three-digit, and the other two reserve their digits (see the styles). An
	 * instrument whose field resizes as the value changes shuffles everything
	 * beside it on every fix, which is exactly what cannot be read at a glance.
	 *
	 * Doc 8400 abbreviations label the tiles, as on any instrument or EFB data
	 * field: invariant, and they fit where a translated phrase truncates. The
	 * full wording rides the title. */
	import { t } from '$lib/state/i18n.svelte';
	import { fmtTrack } from '$lib/route/format';

	interface Props {
		speedKt: number | null;
		/** Magnetic, like the nav log's MC / MH columns and the bearing row. */
		trackMagDeg: number | null;
		/** Referenced to mean sea level (nav/altitudeDatum.ts). */
		altMslFt: number | null;
		/** Tooltip naming the altitude datum in force and the correction. */
		altTip: string;
		/** Frozen at the last fix: the figures stay readable but stop reading
		 *  as current (state/navRecording positionQuality). */
		stale?: boolean;
		/** The phone strip's one-line form: the same figures as small
		 *  label-value pairs instead of tiles, sized to FIT the band's line
		 *  so an instrument can never clip mid-digit (docs/nav-live.md). */
		compact?: boolean;
	}

	const { speedKt, trackMagDeg, altMslFt, altTip, stale = false, compact = false }: Props = $props();
</script>

<!-- Each tile names itself for assistive technology as well as for the eye:
     the abbreviation is the label a pilot reads, the title spells it out, and
     an aria-label carries the same words where a title never appears. The
     figures update every fix, so the row is deliberately aria-live="off": an
     instrument that announced itself once a second would talk over the alert
     banner above it. -->
<div class="instruments" class:stale class:compact aria-live="off">
	<div class="tile" title={t.navigation.groundSpeed} aria-label={t.navigation.groundSpeed}>
		<!-- i18n-ignore: GS / TRK are ICAO Doc 8400 abbreviations, locale-invariant like MC / MH in the nav log; the title spells each out -->
		<span class="k">GS</span>
		<span class="v"
			><span class="n w3">{speedKt != null ? Math.round(speedKt) : '—'}</span><span class="u"
				>kt</span
			></span
		>
	</div>
	<div class="tile" title={t.navigation.trackTip} aria-label={t.navigation.track}>
		<span class="k">TRK</span>
		<!-- fmtTrack, the nav log's own MC / MH formatter: three digits and the
		     degree sign, so the field cannot change width and the band agrees
		     with the log docked under it. -->
		<span class="v">{trackMagDeg != null ? fmtTrack(trackMagDeg) : '—'}</span>
	</div>
	<div class="tile" title={altTip} aria-label={t.navigation.altitude}>
		<!-- i18n-ignore: GPS ALT names the source of the figure, not a translated phrase; the title states the datum. The compact line shortens it to ALT so the strip fits a 320 px band, the aria and title unchanged. -->
		<span class="k">{compact ? 'ALT' : 'GPS ALT'}</span>
		<span class="v"
			><span class="n w5">{altMslFt != null ? Math.round(altMslFt) : '—'}</span><span class="u"
				>ft</span
			></span
		>
	</div>
</div>

<style>
	/* A row of data fields that wraps only when it genuinely cannot fit: the
	   figures are read across, and a grid that collapses to one column turns
	   a 60 px band into a third of the map. */
	.instruments {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.tile {
		display: flex;
		flex: 0 0 auto;
		flex-direction: column;
		min-width: 76px;
		gap: 1px;
		padding: 5px 8px 6px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.tile .k {
		overflow: hidden;
		font-size: 10px;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.tile .v {
		font-size: 22px;
		line-height: 1.1;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	/* The reserved figure box. Digits are tabular, so one ch IS one digit and
	   the widest reading fits exactly: the number and the unit beside it each
	   keep one x whatever the value reads, instead of the tile resizing on
	   every fix and shuffling the whole band. The reservation rides the value
	   span, so it scales with the coarse-pointer font bump below.
	   Digits sit at the END of that box so the unit hugs the number it belongs
	   to, the way an instrument reads: the slack falls where the leading digits
	   would be, which is where the eye expects nothing, rather than between the
	   figure and its unit, where it reads as two separate things. */
	.tile .n {
		display: inline-block;
		text-align: right;
	}

	.tile .n.w3 {
		min-width: 3ch;
	}

	.tile .n.w5 {
		min-width: 5ch;
	}

	.tile .u {
		margin-left: 2px;
		font-size: 11px;
		color: var(--text-muted);
	}

	/* Frozen at the last fix: still the last known values, no longer current. */
	.instruments.stale .v {
		opacity: 0.55;
	}

	/* In flight, give the figures more presence. Keyed off the touch-ui
	   class, not a media query: the class is the app's one definition of
	   being in flight (a coarse pointer OR a running recording), and this
	   row sits ON the strip, whose own rules already key off it. A
	   recording on a fine pointer used to grow the frequency band and leave
	   the instruments small (docs/nav-live.md states the rule). */
	:global(:root.touch-ui) .tile .v {
		font-size: 26px;
	}

	/* The compact one-line form (the phone strip's line B): same DOM, the
	   tiles flattened to label-value pairs. Sized to fit a 320 px band
	   beside the XTK pair; nowrap on purpose, the line owns any overflow
	   with cell-boundary snapping. */
	.instruments.compact {
		flex-wrap: nowrap;
		gap: 8px;
	}

	.instruments.compact .tile {
		flex-direction: row;
		gap: 4px;
		align-items: baseline;
		min-width: 0;
		padding: 0;
		background: none;
		border: none;
	}

	.instruments.compact .tile .v {
		font-size: 13px;
		font-weight: 600;
	}

	:global(:root.touch-ui) .instruments.compact .tile .v {
		font-size: 14px;
	}
</style>
