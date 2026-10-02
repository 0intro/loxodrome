/* Geometry of the CG envelope chart (CgEnvelopeChart.svelte), pure so
 * tests/cgChart.spec.ts can pin it: the (arm, mass) scale and the placement
 * of the point labels.
 *
 * A label used to sit 8 px right of its dot whatever the room there, its
 * collisions pushed downward only. A point near the aft limit at a high mass
 * (F-GORQ with 150 kg in front and 105 kg behind on full tanks: takeoff
 * 897 kg at 0.519 m) ran its "Takeoff 897 kg" past the chart's right edge,
 * where the SVG clips it, and a stack near the floor could be pushed under
 * the arm axis. A label now goes right of its dot when it fits and left of it,
 * anchored at its end, when it does not, and the stack is kept between the
 * plot's top and its floor.
 *
 * Widths are estimated at a fixed advance per character (LABEL_CHAR_W), the
 * routeProfileFit.ts practice. The labels set in the proportional UI face, so
 * the advance is a bound, measured over the longest labels in both languages
 * in their bold (out of envelope) form. */

/** The chart's viewBox width and its plot padding, px. */
export const CG_W = 480;
export const CG_PAD = { left: 50, right: 14, top: 12, bottom: 30 } as const;

/** Px advance per character at the 10 px label font, bold included: a bound
 *  over the faces the app's stack resolves to (measured in Chromium over the
 *  six labels in both languages: DejaVu Sans Bold, the widest, advanced
 *  6.25 px per character on "Landing 1542 kg"; Noto Sans, Liberation Sans,
 *  Inter, Adwaita Sans, Cantarell and Roboto all ran narrower). */
export const LABEL_CHAR_W = 6.4;
/** Dot centre to the near end of its label. */
const GAP = 8;
/** Minimum distance between two labels' baselines. */
const LINE = 13;
/** A label's baseline sits this far below its dot's centre. */
const BASELINE = 4;
/** How far a 10 px label rises above its baseline and drops below it. */
const ASCENT = 8;
const DESCENT = 3;

interface ArmMass {
	armM: number;
	massKg: number;
}

export interface CgScale {
	/** The plot's width and height inside the padding. */
	innerW: number;
	innerH: number;
	x: (armM: number) => number;
	y: (massKg: number) => number;
	armTicks: number[];
	massTicks: number[];
}

/** A nice 1/2/5 step covering the span with ~n ticks. */
function niceStep(span: number, n: number): number {
	const raw = span / n;
	const mag = 10 ** Math.floor(Math.log10(raw));
	for (const m of [1, 2, 5, 10]) {
		if (raw <= m * mag) {
			return m * mag;
		}
	}
	return 10 * mag;
}

function ticks(lo: number, hi: number, n: number): number[] {
	const step = niceStep(hi - lo, n);
	const out: number[] = [];
	for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
		out.push(v);
	}
	return out;
}

/** The (arm, mass) to px mapping: the envelope and the points, padded 8 %
 *  of their span on every side. */
export function cgScale(
	envelope: readonly ArmMass[],
	points: readonly ArmMass[],
	heightPx: number,
): CgScale {
	const arms = [...envelope.map((p) => p.armM), ...points.map((p) => p.armM)];
	const masses = [...envelope.map((p) => p.massKg), ...points.map((p) => p.massKg)];
	const minArm = Math.min(...arms);
	const maxArm = Math.max(...arms);
	const minMass = Math.min(...masses);
	const maxMass = Math.max(...masses);
	const aPad = (maxArm - minArm || 0.1) * 0.08;
	const mPad = (maxMass - minMass || 100) * 0.08;
	const a0 = minArm - aPad;
	const a1 = maxArm + aPad;
	const m0 = minMass - mPad;
	const m1 = maxMass + mPad;
	const innerW = CG_W - CG_PAD.left - CG_PAD.right;
	const innerH = heightPx - CG_PAD.top - CG_PAD.bottom;
	return {
		innerW,
		innerH,
		x: (armM) => CG_PAD.left + ((armM - a0) / (a1 - a0)) * innerW,
		y: (massKg) => CG_PAD.top + (1 - (massKg - m0) / (m1 - m0)) * innerH,
		armTicks: ticks(a0, a1, 6),
		massTicks: ticks(m0, m1, 5),
	};
}

export interface CgLabelIn {
	/** The dot's centre, px. */
	x: number;
	y: number;
	text: string;
}

export interface CgLabelOut {
	/** The text's anchor point (its baseline) and which end it anchors. */
	x: number;
	y: number;
	anchor: 'start' | 'end';
}

/** The room the labels must stay in, px. */
export interface CgLabelBox {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/** The plot area, the right padding included (a label may run into it, the
 *  SVG ends 2 px later). */
export function cgLabelBox(heightPx: number): CgLabelBox {
	return {
		left: CG_PAD.left,
		right: CG_W - 2,
		top: CG_PAD.top,
		bottom: heightPx - CG_PAD.bottom,
	};
}

/** Estimated width of a label, px. */
export function cgLabelWidth(text: string): number {
	return text.length * LABEL_CHAR_W;
}

/** One placement per item, index-aligned. */
export function placeCgLabels(items: readonly CgLabelIn[], box: CgLabelBox): CgLabelOut[] {
	// Vertical: by the dots' order, at least LINE apart, pushed down, then
	// back up from the floor, then down from the top when even that does not
	// fit (the top wins: a label above the plot would cover nothing).
	const order = items
		.map((it, i) => ({ i, y: it.y + BASELINE }))
		.sort((a, b) => a.y - b.y || a.i - b.i);
	for (let k = 1; k < order.length; k++) {
		order[k].y = Math.max(order[k].y, order[k - 1].y + LINE);
	}
	const floor = box.bottom - DESCENT;
	for (let k = order.length - 1; k >= 0; k--) {
		const cap = k === order.length - 1 ? floor : order[k + 1].y - LINE;
		order[k].y = Math.min(order[k].y, cap);
	}
	const ceiling = box.top + ASCENT;
	for (let k = 0; k < order.length; k++) {
		const low = k === 0 ? ceiling : order[k - 1].y + LINE;
		order[k].y = Math.max(order[k].y, low);
	}
	const ys: number[] = [];
	for (const o of order) {
		ys[o.i] = o.y;
	}

	return items.map((it, i) => {
		const w = cgLabelWidth(it.text);
		const right = it.x + GAP;
		if (right + w <= box.right) {
			return { x: right, y: ys[i], anchor: 'start' };
		}
		const left = it.x - GAP;
		if (left - w >= box.left) {
			return { x: left, y: ys[i], anchor: 'end' };
		}
		// Neither side holds it whole: the roomier side, clamped inside.
		return box.right - right >= left - box.left
			? { x: Math.max(box.left, box.right - w), y: ys[i], anchor: 'start' }
			: { x: Math.min(box.right, box.left + w), y: ys[i], anchor: 'end' };
	});
}
