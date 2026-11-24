/* The stage geometry, published as CSS custom properties on <html>.
 *
 * "Stage" is the workspace region between the sidebar and the detail panel,
 * the space a docked or paged surface may use. Surface boxes are portaled to
 * <body> and positioned `fixed` (which is what keeps every print flow
 * working, see docs/workspace-surfaces.md), so they cannot be laid out by the
 * stage's own flex box; they read its measurements instead. The space they
 * cover is reserved in flow by empty spacers inside the stage, which is what
 * actually shrinks the Leaflet container.
 *
 * The properties go on documentElement, not on .app: they have to inherit
 * into the portaled boxes, which are siblings of #app.
 *
 * ResizeObserver callbacks run after layout and before paint, so a box
 * repositioned from one never lags a frame behind the element it tracks.
 */

export interface StageGeometry {
	/** The stage box in viewport coordinates. */
	left: number;
	top: number;
	width: number;
	height: number;
	/** Bottom dock height, 0 when that slot is empty. */
	dockB: number;
	/** Right dock width, 0 when that slot is empty. */
	dockR: number;
}

/** The custom properties for a geometry, as a name -> value record. Pure, so
 *  the mapping is testable without a DOM. */
export function stageVars(g: StageGeometry): Record<string, string> {
	return {
		'--stage-l': `${Math.round(g.left)}px`,
		'--stage-t': `${Math.round(g.top)}px`,
		'--stage-w': `${Math.round(g.width)}px`,
		'--stage-h': `${Math.round(g.height)}px`,
		'--dock-b': `${Math.round(g.dockB)}px`,
		'--dock-r': `${Math.round(g.dockR)}px`,
	};
}

export function applyStageVars(g: StageGeometry): void {
	if (typeof document === 'undefined') {
		return;
	}
	const style = document.documentElement.style;
	for (const [name, value] of Object.entries(stageVars(g))) {
		style.setProperty(name, value);
	}
}

/** Observe an element's box, calling back on every size change. Returns the
 *  teardown. */
export function observeBox(el: HTMLElement, onResize: () => void): () => void {
	const ro = new ResizeObserver(onResize);
	ro.observe(el);
	return () => ro.disconnect();
}
