/* Width-aware waypoint-ident fitting for the route profile chart
 * (RouteProfile.svelte), pure so tests/routeProfileFit.spec.ts can pin it.
 *
 * The old rule kept a label whenever its TICK sat 46px past the previous
 * kept tick, which ignores how wide the labels themselves are: two long
 * free-point names 50px apart overprinted each other into garble (measured
 * on the phone, where the chart is narrow), and an end label could
 * overprint the last interior one. This pass measures every label at the
 * chart's own metric (CHAR_W, the 9px ui-monospace advance the band and
 * feature fitters already use) and places greedily left to right:
 *
 * - the two END items render whole, anchored outward (start / end), so
 *   they never clip at the plot edge and always win over neighbours;
 * - an interior label (middle-anchored) gets the room between the
 *   previously kept label and the destination label's left edge, capped
 *   by the plot edges; it ellipsizes into that room via the pinned
 *   `truncate` (word-boundary aware, ellipsis included in the budget) and
 *   drops below MIN_CHARS;
 * - blank labels never reserve space, the old rule kept.
 */
import { truncate } from './verticalProfile';

export interface WpLabelIn {
	/** The waypoint tick's x, already mapped to plot px. */
	x: number;
	/** The ident / name; '' never renders and never reserves space. */
	label: string;
}

export interface WpLabelOut {
	text: string;
	anchor: 'start' | 'middle' | 'end';
}

/** Px advance per character at the 9px ui-monospace label font. */
const CHAR_W = 5.4;
/** Minimum clear px between two kept labels. */
const GAP = 8;
/** An ellipsized interior label shorter than this says nothing. */
const MIN_CHARS = 4;

/** One entry per input, null = not shown. `leftPx`/`rightPx` bound the
 *  drawable strip (PAD_L .. plot right edge). */
export function fitWpLabels(
	items: WpLabelIn[],
	leftPx: number,
	rightPx: number,
): (WpLabelOut | null)[] {
	const out = new Array<WpLabelOut | null>(items.length).fill(null);
	if (items.length === 0) {
		return out;
	}

	const last = items.length - 1;
	// The destination's left edge (it renders whole, right-anchored); the
	// bound interiors must respect. A blank destination frees the edge.
	const lastW = items[last].label.length * CHAR_W;
	const lastLeft = items[last].label ? items[last].x - lastW : rightPx;

	// The departure, whole and left-anchored.
	let prevRight = leftPx;
	if (items[0].label) {
		out[0] = { text: items[0].label, anchor: 'start' };
		prevRight = items[0].x + items[0].label.length * CHAR_W;
	}

	for (let i = 1; i < last; i++) {
		const it = items[i];
		if (!it.label) {
			continue;
		}
		// Middle-anchored: the budget is twice the smaller free side.
		const roomL = it.x - Math.max(prevRight + GAP, leftPx);
		const roomR = Math.min(lastLeft - GAP, rightPx) - it.x;
		const maxChars = Math.floor((2 * Math.min(roomL, roomR)) / CHAR_W);
		if (maxChars < MIN_CHARS) {
			continue;
		}
		const text = it.label.length <= maxChars ? it.label : truncate(it.label, maxChars);
		out[i] = { text, anchor: 'middle' };
		prevRight = it.x + (text.length * CHAR_W) / 2;
	}

	if (last > 0 && items[last].label) {
		out[last] = { text: items[last].label, anchor: 'end' };
	}
	return out;
}
