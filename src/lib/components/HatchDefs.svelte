<script lang="ts">
	/* The activation overlays' SVG hatch <pattern>s, defined ONCE for both map
	 * components.
	 *
	 * activationLayer.ts and supaipActivationLayer.ts paint their clones with
	 * `fill="url(#hatch-<category>)"` / `url(#hatch-supaip)`, which resolves by
	 * id anywhere in the document. That makes the definitions invisible
	 * infrastructure: nothing imports them, nothing type-checks the link, and a
	 * map component that omits them renders a path with an unresolvable fill,
	 * which is to say NOTHING, with no error anywhere.
	 *
	 * Which is what had happened. MapView carried these inline and
	 * NotamMapView, its deliberate duplicate, never did, so in the NOTAM Viewer
	 * every activated zone and every activated airspace drew an invisible
	 * hatch: the one overlay that app exists to show. Shared as a component
	 * because the markup is pure (a palette import and no Leaflet), which is
	 * the same division the rest of the duplication already follows: the RULE
	 * is shared, the wiring is each app's own. */
	import { ACTIVATION_HATCH_FILL } from '$lib/map/palette';
</script>

<svg class="hatch-defs" aria-hidden="true" focusable="false">
	<defs>
		<!-- Diagonal-hatch fills referenced by activationLayer.ts's polygons via
			 fill="url(#hatch-<category>)", generated from the palette's
			 ACTIVATION_HATCH_FILL so every category resolves to a real pattern.
			 Each category mirrors the underlying airspace colour so the overlay
			 reads as "this same airspace, activated" rather than a foreign
			 visual. Stripe width (3) and tile size (8 with a 45° rotate) yield a
			 clearly-spaced hatch that doesn't moiré at typical zoom levels. -->
		{#each Object.entries(ACTIVATION_HATCH_FILL) as [cat, fill] (cat)}
			<pattern id="hatch-{cat}" patternUnits="userSpaceOnUse"
					 width="8" height="8" patternTransform="rotate(45)">
				<rect width="3" height="8" {fill} />
			</pattern>
		{/each}
		<!-- SUP AIP activated-zone hatch (supaipActivationLayer.ts). Magenta to
			 match the base SUP AIP overlay's #c2185b identity (app identity,
			 deliberately not a palette entry). -->
		<pattern id="hatch-supaip" patternUnits="userSpaceOnUse"
				 width="8" height="8" patternTransform="rotate(45)">
			<rect width="3" height="8" fill="#c2185b" />
		</pattern>
	</defs>
</svg>

<style>
	/* Zero size + absolutely positioned so the page never paints it directly,
	   while the pattern ids stay reachable by url(#hatch-…) fills anywhere on
	   the page (Leaflet's SVG polygons cross SVG element boundaries when
	   resolving fill URLs by id). */
	.hatch-defs {
		position: absolute;
		width: 0;
		height: 0;
		pointer-events: none;
	}
</style>
