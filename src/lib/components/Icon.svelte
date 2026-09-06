<script lang="ts">
	interface Props {
		name: string;
		size?: number;
	}

	let { name, size = 20 }: Props = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#if name === 'user'}
		<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
		<circle cx="12" cy="7" r="4" />
	{:else if name === 'menu'}
		<line x1="3" y1="6" x2="21" y2="6" />
		<line x1="3" y1="12" x2="21" y2="12" />
		<line x1="3" y1="18" x2="21" y2="18" />
	{:else if name === 'sun'}
		<circle cx="12" cy="12" r="4" />
		<path
			d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"
		/>
	{:else if name === 'moon'}
		<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
	{:else if name === 'file-text'}
		<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
		<polyline points="14 2 14 8 20 8" />
		<line x1="8" y1="13" x2="16" y2="13" />
		<line x1="8" y1="17" x2="16" y2="17" />
	{:else if name === 'list'}
		<line x1="8" y1="6" x2="21" y2="6" />
		<line x1="8" y1="12" x2="21" y2="12" />
		<line x1="8" y1="18" x2="21" y2="18" />
		<line x1="3" y1="6" x2="3.01" y2="6" />
		<line x1="3" y1="12" x2="3.01" y2="12" />
		<line x1="3" y1="18" x2="3.01" y2="18" />
	{:else if name === 'filter'}
		<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
	{:else if name === 'layers'}
		<polygon points="12 2 2 7 12 12 22 7 12 2" />
		<polyline points="2 17 12 22 22 17" />
		<polyline points="2 12 12 17 22 12" />
	{:else if name === 'chevron-left'}
		<polyline points="15 18 9 12 15 6" />
	{:else if name === 'chevron-right'}
		<polyline points="9 18 15 12 9 6" />
	{:else if name === 'chevron-down'}
		<polyline points="6 9 12 15 18 9" />
	{:else if name === 'chevron-up'}
		<polyline points="18 15 12 9 6 15" />
	{:else if name === 'x'}
		<line x1="18" y1="6" x2="6" y2="18" />
		<line x1="6" y1="6" x2="18" y2="18" />
	{:else if name === 'check'}
		<polyline points="20 6 9 17 4 12" />
	{:else if name === 'edit-2'}
		<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
	{:else if name === 'plus'}
		<line x1="12" y1="5" x2="12" y2="19" />
		<line x1="5" y1="12" x2="19" y2="12" />
	{:else if name === 'printer'}
		<polyline points="6 9 6 2 18 2 18 9" />
		<path
			d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"
		/>
		<rect x="6" y="14" width="12" height="8" />
	{:else if name === 'maximize'}
		<path
			d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"
		/>
	{:else if name === 'search'}
		<circle cx="11" cy="11" r="8" />
		<line x1="21" y1="21" x2="16.65" y2="16.65" />
	{:else if name === 'crosshair'}
		<circle cx="12" cy="12" r="10" />
		<line x1="22" y1="12" x2="18" y2="12" />
		<line x1="6" y1="12" x2="2" y2="12" />
		<line x1="12" y1="6" x2="12" y2="2" />
		<line x1="12" y1="22" x2="12" y2="18" />
	{:else if name === 'aerodrome'}
		<!-- The SIA civil paved aerodrome (Legende2026), the mark
		     airportSymbols.ts paints on the map: a filled disc with four
		     short cardinal tabs and the runway cut through it at 45
		     degrees. Proportions of the disc radius s = 8: tabs 0.19 s wide
		     reaching 1.375 s, runway 0.82 s long and 0.24 s wide, the ones
		     drawRunway paints. One path, so the tabs union into the disc
		     under the default nonzero rule while the runway, wound the
		     other way, cuts the hole that shows the button's own
		     background in either theme. -->
		<path
			d="M12 4A8 8 0 1 1 12 20A8 8 0 1 1 12 4Z M10.48 1H13.52V7.04H10.48Z M10.48 16.96H13.52V23H10.48Z M1 10.48H7.04V13.52H1Z M16.96 10.48H23V13.52H16.96Z M18 8.72L15.28 6L6 15.28L8.72 18Z"
			fill="currentColor"
			stroke="none"
		/>
	{:else if name === 'navigation'}
		<polygon points="3 11 22 2 13 21 11 13 3 11" />
	{:else if name === 'info'}
		<circle cx="12" cy="12" r="10" />
		<line x1="12" y1="11" x2="12" y2="16" />
		<line x1="12" y1="8" x2="12.01" y2="8" />
	{:else if name === 'alert-triangle'}
		<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
		<line x1="12" y1="9" x2="12" y2="13" />
		<line x1="12" y1="17" x2="12.01" y2="17" />
	{:else if name === 'sliders'}
		<line x1="4" y1="21" x2="4" y2="14" />
		<line x1="4" y1="10" x2="4" y2="3" />
		<line x1="12" y1="21" x2="12" y2="12" />
		<line x1="12" y1="8" x2="12" y2="3" />
		<line x1="20" y1="21" x2="20" y2="16" />
		<line x1="20" y1="12" x2="20" y2="3" />
		<line x1="1" y1="14" x2="7" y2="14" />
		<line x1="9" y1="8" x2="15" y2="8" />
		<line x1="17" y1="16" x2="23" y2="16" />
	{:else if name === 'wind'}
		<path d="M9.59 4.59A2 2 0 1 1 11 8H2" />
		<path d="M12.59 19.41A2 2 0 1 0 14 16H2" />
		<path d="M17.73 7.73A2.5 2.5 0 1 1 19.5 12H2" />
	{:else if name === 'download'}
		<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
		<polyline points="7 10 12 15 17 10" />
		<line x1="12" y1="15" x2="12" y2="3" />
	{:else if name === 'upload'}
		<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
		<polyline points="7 8 12 3 17 8" />
		<line x1="12" y1="3" x2="12" y2="15" />
	{:else if name === 'send'}
		<line x1="22" y1="2" x2="11" y2="13" />
		<polygon points="22 2 15 22 11 13 2 9 22 2" />
	{:else if name === 'play'}
		<polygon points="6 4 20 12 6 20 6 4" />
	{:else if name === 'skip-back'}
		<polygon points="19 20 9 12 19 4 19 20" />
		<line x1="5" y1="19" x2="5" y2="5" />
	{:else if name === 'skip-forward'}
		<polygon points="5 4 15 12 5 20 5 4" />
		<line x1="19" y1="5" x2="19" y2="19" />
	{:else if name === 'pause'}
		<line x1="9" y1="5" x2="9" y2="19" />
		<line x1="15" y1="5" x2="15" y2="19" />
	{:else if name === 'route'}
		<circle cx="6" cy="19" r="3" />
		<path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
		<circle cx="18" cy="5" r="3" />
	{:else if name === 'columns'}
		<path
			d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7m0-18H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7m0-18v18"
		/>
	{:else if name === 'book'}
		<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
		<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
	{:else if name === 'logbook'}
		<!-- The carnet the flights library shows (docs/flights-library.md): the
		     book above, ruled into one row per flight. The rows sit high on the
		     page, clear of the spine curve they otherwise blur into at 14px, and
		     there are three, two reading as a document where three read as a list
		     of entries. The spine is what holds this apart from the nav log's
		     chevron sheet, the glyph it stands beside in the launcher cluster;
		     'book' stays the plain bound document, which is the printed dossier. -->
		<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
		<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
		<path d="M9.5 6h8M9.5 9.5h8M9.5 13h8" />
	{:else if name === 'archive'}
		<polyline points="21 8 21 21 3 21 3 8" />
		<rect x="1" y="3" width="22" height="5" />
		<line x1="10" y1="12" x2="14" y2="12" />
	{:else if name === 'plane'}
		<path
			d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"
		/>
	{:else if name === 'droplet'}
		<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
	{:else if name === 'scale'}
		<path d="M12 3v18M5 7l7-4 7 4" />
		<path d="M5 7l-3 7a4.2 4.2 0 0 0 6 0zM19 7l-3 7a4.2 4.2 0 0 0 6 0z" />
		<line x1="8" y1="21" x2="16" y2="21" />
	{:else if name === 'gauge'}
		<path d="M12 15l4-6" />
		<circle cx="12" cy="15" r="1.5" />
		<path d="M4.5 19a9 9 0 1 1 15 0" />
	{:else if name === 'trash'}
		<polyline points="3 6 5 6 21 6" />
		<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
		<line x1="10" y1="11" x2="10" y2="17" />
		<line x1="14" y1="11" x2="14" y2="17" />
	{:else if name === 'rotate-ccw'}
		<polyline points="1 4 1 10 7 10" />
		<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
	{:else if name === 'rotate-cw'}
		<polyline points="23 4 23 10 17 10" />
		<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
	{:else if name === 'save'}
		<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
		<polyline points="17 21 17 13 7 13 7 21" />
		<polyline points="7 3 7 8 15 8" />
	{:else if name === 'helicopter'}
		<line x1="3" y1="5" x2="21" y2="5" />
		<line x1="12" y1="5" x2="12" y2="8" />
		<path d="M5 14a5 5 0 0 1 5-6h2l5 4h2" />
		<path d="M5 14h11a2 2 0 0 0 2-2" />
		<line x1="19" y1="8" x2="19" y2="12" />
		<line x1="7" y1="19" x2="15" y2="19" />
		<line x1="9" y1="14" x2="8" y2="19" />
		<line x1="13" y1="14" x2="14" y2="19" />
	{:else if name === 'glider'}
		<line x1="2.5" y1="9" x2="21.5" y2="9" />
		<line x1="12" y1="5" x2="12" y2="18" />
		<line x1="8.5" y1="18" x2="15.5" y2="18" />
	{:else if name === 'record'}
		<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />
	{:else if name === 'stop'}
		<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
	{:else if name === 'more-vertical'}
		<circle cx="12" cy="5" r="1" />
		<circle cx="12" cy="12" r="1" />
		<circle cx="12" cy="19" r="1" />
	{:else if name === 'panel-bottom'}
		<!-- Surface placements: a frame with the docked pane shaded. -->
		<rect x="3" y="4" width="18" height="16" rx="2" />
		<path d="M3 14h18v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor" stroke="none" />
	{:else if name === 'panel-right'}
		<rect x="3" y="4" width="18" height="16" rx="2" />
		<path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4z" fill="currentColor" stroke="none" />
	{:else if name === 'panel-page'}
		<rect x="3" y="4" width="18" height="16" rx="2" />
		<rect x="6" y="7" width="12" height="10" rx="1" fill="currentColor" stroke="none" />
	{:else if name === 'navlog'}
		<!-- The nav log's own sheet, drawn the way NavLogSheet lays it out (the
		     launcher icon everywhere the log opens from): a header band, the
		     narrow leg block on the left, and the waypoint reports on the right
		     as left-pointing banners. Their "<" tips sit ON the leg seams, half
		     a band above and below the banner seam between them, which is the
		     offset that makes a report straddle the two legs it separates; two
		     consecutive arms meet at their base, so the notch column is one
		     zigzag, exactly as the sheet's stacked .rep-bevel strokes read.
		     Every leg seam stops at the tip it meets and the banner seam starts
		     at the base, as they do on the sheet. -->
		<rect x="3" y="4" width="18" height="16" rx="2" />
		<path d="M3 8h18" />
		<path d="M12 8 9 11l3 3-3 3 3 3" />
		<path d="M12 14h9" />
		<path d="M3 11h6M3 17h6" />
	{:else if name === 'profile'}
		<!-- A terrain silhouette: the vertical profiles' concept icon (route,
		     trace and point profiles alike). -->
		<path d="M3 20 L9 7 L13 13 L16.5 8.5 L21 20 Z" />
	{:else if name === 'clipboard-check'}
		<!-- The pre-flight checklist: the flight-preparation launcher. -->
		<rect x="8" y="2" width="8" height="4" rx="1" />
		<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
		<path d="m9 14 2 2 4-4" />
	{/if}
</svg>
