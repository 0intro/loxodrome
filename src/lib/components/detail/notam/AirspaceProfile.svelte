<script lang="ts">
	import type { Airspace } from '$lib/data/airspaces';
	import type { Notam } from '$lib/notam/types';
	import { t } from '$lib/state/i18n.svelte';
	import AltitudeProfile from '$lib/components/detail/AltitudeProfile.svelte';
	import type { VerticalOverlay } from '$lib/components/verticalProfile';

	interface Props {
		airspaces: Airspace[];
		notam: Notam;
	}
	const { airspaces, notam }: Props = $props();

	// The NOTAM's altitude band, overlaid on the airspace stack as a filled
	// band so the reader sees where the restriction sits vertically. The
	// operational F)/G) items win over the coarse Q-line band (OPADD);
	// their values draw at face value in their own datum, like the
	// airspace columns beside them.
	const notamBand = $derived.by(() => {
		const fgLo = notam.fgLower;
		const fgUp = notam.fgUpper;
		if (fgLo && fgUp) {
			// A surface-to-unlimited band covers the whole chart; skip it.
			if (fgLo.sfc && fgUp.unl) return null;
			return {
				floor: fgLo.ft,
				ceiling: fgUp.unl ? Infinity : fgUp.ft,
				// The label states the band's provenance: F)/G) items here,
				// the coarse Q-line fallback below.
				source: 'fg' as const,
			};
		}
		const q = notam.qualifier;
		if (!q || !Number.isFinite(q.lower) || !Number.isFinite(q.upper)) return null;
		// FL 0-999 is the ICAO "no statement" default; nothing to overlay.
		if (q.upper === 999 && q.lower === 0) return null;
		const floor = q.lower * 100;
		const ceiling = q.upper === 999 ? Infinity : q.upper * 100;
		return { floor, ceiling, source: 'qline' as const };
	});

	const overlays = $derived.by<VerticalOverlay[]>(() => {
		if (!notamBand) return [];
		return [
			{
				kind: 'fill',
				floorFt: notamBand.floor,
				ceilingFt: Number.isFinite(notamBand.ceiling) ? notamBand.ceiling : null,
				color: 'var(--accent)',
				label: notamBand.source === 'fg' ? t.notam.fgBandLabel : t.notam.qlineBandLabel,
			},
		];
	});

	/* No ceiling contribution to pass: the altitude window reads the overlay
	 * bands themselves and keeps this one wholly visible, its floor included (an
	 * F)/G) band can start at FL 095, which the old ceiling-only prop could not
	 * state). */
</script>

<AltitudeProfile {airspaces} {overlays} description={t.notam.profileDescription} />
