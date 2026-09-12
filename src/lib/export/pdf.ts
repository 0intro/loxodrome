import type { Map as LeafletMap } from 'leaflet';
import { downloadBlob } from '$lib/ui/dom';
import { APP_SUBJECT, fileName, fileStampUtc } from '$lib/files/fileName';
import { routesFileBaseName } from '$lib/route/routeLabel';
import { routes } from '$lib/state/route.svelte';

// Longest PDF page edge, millimetres (the A4 long edge). The page is sized to
// the captured view's own aspect ratio with this as its longer side, so the
// whole view fills the page with nothing cropped and no letterbox margins.
const PAGE_LONG_MM = 297;

/**
 * Capture the map as it is on screen and save it to a PDF, WYSIWYG: the page is
 * shaped like the visible map and filled with it, so nothing is cropped. The
 * detail-panel overlay's covered strip is excluded (see visibleMapWidth).
 * html2canvas-pro (the maintained html2canvas fork, same API) and jsPDF are
 * dynamically imported so they stay out of the main bundle.
 */
export async function exportMapPdf(map: LeafletMap): Promise<void> {
	const container = map.getContainer();
	const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
		import('html2canvas-pro'),
		import('jspdf'),
	]);

	// Hide the map controls during capture.
	const controls = container.querySelectorAll<HTMLElement>(
		'.leaflet-control-zoom, .leaflet-control-layers',
	);
	controls.forEach((el) => {
		el.style.display = 'none';
	});
	map.invalidateSize();
	await new Promise((resolve) => setTimeout(resolve, 400));

	// Make the activation-overlay hatching capturable (see injectHatchDefs).
	const injectedDefs = injectHatchDefs(map);

	try {
		const canvas = await html2canvas(container, {
			useCORS: true,
			allowTaint: true,
			logging: false,
			ignoreElements: (el) =>
				el.classList.contains('leaflet-control-container'),
		});

		// Keep exactly the visible map: full height, and width trimmed to drop
		// the strip hidden behind the detail panel (visibleMapWidth; the sidebar
		// is in-flow, so already outside the capture). No aspect-ratio crop, so
		// nothing the user sees is lost.
		const visW = Math.round(visibleMapWidth(container, canvas));
		const visH = canvas.height;

		const cropped = document.createElement('canvas');
		cropped.width = visW;
		cropped.height = visH;
		const ctx = cropped.getContext('2d');
		if (!ctx) {
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			throw new Error('2D canvas context unavailable');
		}
		ctx.drawImage(canvas, 0, 0, visW, visH, 0, 0, visW, visH);

		// Size the page to the captured view so the image fills it edge to edge
		// (no crop, no margins). The longer side is the A4 long edge.
		const aspect = visW / visH;
		const landscape = aspect >= 1;
		const pdf = new jsPDF({
			orientation: landscape ? 'landscape' : 'portrait',
			unit: 'mm',
			format: landscape
				? [PAGE_LONG_MM, PAGE_LONG_MM / aspect]
				: [PAGE_LONG_MM * aspect, PAGE_LONG_MM],
		});
		// Use the page dimensions jsPDF actually created (it may normalise the
		// format to the orientation) so the image always fills the whole page.
		const pageW = pdf.internal.pageSize.getWidth();
		const pageH = pdf.internal.pageSize.getHeight();
		pdf.addImage(
			cropped.toDataURL('image/jpeg', 0.95),
			'JPEG',
			0,
			0,
			pageW,
			pageH,
		);
		// Through the shared saver: pdf.save()'s own anchor download is a
		// silent no-op inside the Android shell's WebView.
		//
		// Named for the plan on screen when there is one, and stamped either
		// way: a fixed name is the failure mode this grammar exists to avoid,
		// and every repeat export used to land as "loxodrome-map (2).pdf".
		downloadBlob(
			pdf.output('blob'),
			fileName(
				[routesFileBaseName(routes.list) || APP_SUBJECT, 'map', fileStampUtc(Date.now())],
				'pdf',
			),
			'application/pdf',
		);
	} finally {
		injectedDefs.forEach((el) => el.remove());
		controls.forEach((el) => {
			el.style.display = '';
		});
	}
}

/**
 * Clone the page's hatch `<pattern>` defs into each activation-overlay SVG pane
 * and return the inserted nodes (so the caller can strip them after capture).
 *
 * The activated-airspace and SUP AIP overlays fill their paths with
 * `url(#hatch-…)`, where the patterns are defined once in a standalone
 * `<svg class="hatch-defs">` that sits outside the map container
 * (MapView.svelte). In the live document that resolves fine (id lookup is
 * document-wide), but html2canvas rasterizes each `<svg>` element on its own,
 * so a fill reference only resolves to a `<pattern>` inside the SAME `<svg>`.
 * Without this, the hatching prints blank, and any airspace shown only as a
 * hatch (its category toggle off) vanishes from the export entirely.
 */
function injectHatchDefs(map: LeafletMap): Element[] {
	// i18n-ignore: DOM selector, not display text
	const defs = document.querySelector('.hatch-defs defs');
	if (!defs) {
		return [];
	}
	const injected: Element[] = [];
	for (const pane of ['airspaces-activated', 'supaip-activated']) {
		const paneEl = map.getPane(pane);
		paneEl?.querySelectorAll('svg').forEach((svg) => {
			const clone = defs.cloneNode(true) as Element;
			svg.appendChild(clone);
			injected.push(clone);
		});
	}
	return injected;
}

/**
 * Width, in capture-canvas pixels, of the map the user actually sees.
 *
 * The detail panel is an absolute overlay pinned to the right of the map
 * (App.svelte mounts it as a sibling of the map; DetailPanel.svelte pins it
 * `right: 0`), so `map.getContainer()` spans the full width *behind* it. The
 * strip behind the panel isn't actually visible, so trim the captured width to
 * the panel's left edge when it's open and overlaps the map. Falls back to the
 * full width when nothing overlaps (panel closed, so translated off-screen) or
 * when an overlay covers most of the map (the mobile full-screen panel), where
 * a sliver would be worse than the whole.
 */
function visibleMapWidth(container: HTMLElement, canvas: HTMLCanvasElement): number {
	const rect = container.getBoundingClientRect();
	const panel = document.querySelector('aside.detail');
	if (panel) {
		const pr = panel.getBoundingClientRect();
		if (pr.width > 0 && pr.left > rect.left && pr.left < rect.right) {
			// rect.width maps to canvas.width; scale the CSS offset to match.
			const visW = ((pr.left - rect.left) / rect.width) * canvas.width;
			if (visW >= canvas.width * 0.4) {
				return visW;
			}
		}
	}
	return canvas.width;
}
