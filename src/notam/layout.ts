/* The viewer shell's answer to the two layout media flips: the phone layout
 * coming or going (MOBILE_UI_MEDIA) and a phone turned sideways or back
 * (PHONE_LANDSCAPE_MEDIA).
 *
 * Flipping the two flags is not enough, because a surface already open keeps
 * the placement it was opened with. Turned sideways with the detail pane up,
 * the pane stayed a bottom dock clamped over a 300 px stage, leaving the map
 * 30 px tall, and its handle cycled the right dock the pane was not in; turned
 * back, it stayed a right column over a 392 px portrait, the map 76 px wide.
 * The flight app's shell re-places every open surface on the same flips, after
 * pushing the stage's live size (src/App.svelte), and this is that step for
 * this shell. Plain .ts over the shared workspace, so a spec drives it. */

import { ui } from '$lib/state/ui.svelte';
import { reflowSurfaces, setStageSize } from '$lib/state/workspace.svelte';

/** Record what the layout media answer now and, when either flag moved,
 *  re-place the open surfaces for the layout just entered. `stage` measures
 *  the stage's live box: the observer that publishes it runs a frame later,
 *  and the reflow must seed the new edge's size from the new geometry, not
 *  from the old orientation's. */
export function applyLayout(
	phone: boolean,
	landscape: boolean,
	stage: () => { width: number; height: number } | null,
): void {
	const sideways = phone && landscape;
	const flipped = phone !== ui.isMobile;
	const turned = sideways !== ui.isLandscapePhone;
	ui.isMobile = phone;
	ui.isLandscapePhone = sideways;
	if (!flipped && !turned) {
		return;
	}
	const box = stage();
	if (box) {
		setStageSize(box.width, box.height);
	}
	// Never interactive: a rotation must not prompt (the reflow's own rule).
	reflowSurfaces();
}
