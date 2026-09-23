import L from 'leaflet';
import { GLYPH_ART, type ActivityGlyphKind } from './activityGlyphData';
import type { CoordType } from '$lib/notam/types';

// The activity kinds render the official SIA pictograms (activityGlyphData:
// the Legende2026 chart-legend traces, plus the 250k-chart vectors for the
// two rows the 500k legend lacks), the same artwork the airspace-deco layer
// paints. Keys match classifyObstacle().
const ACTIVITY_PINS: Record<string, ActivityGlyphKind> = {
	voltige: 'aerobatics',
	parachute: 'parachute',
	balloon: 'balloon',
	glider: 'glider',
	aeromodelisme: 'modelAircraft',
	paragliding: 'paraglider',
	drone: 'drone',
	ulm: 'ulm',
};

// Obstacle / hazard glyph path data, 24×24 viewBox, Material Design Icons
// (Apache 2.0). Keys match classifyObstacle(); the activity kinds are NOT
// here, they ride ACTIVITY_PINS above.
const OBSTACLE_GLYPHS: Record<string, string> = {
	crane: 'M20,6V5A1,1 0 0,0 19,4H9V3H6V4H5V6H6V15H5V13H3V15H2V17H3V21H5V17H10V21H12V19.92L12,17H13V15H12V13H10V15H9V6H17V10.62C16.53,10.79 16.19,11.23 16.19,11.76C16.19,12.2 16.43,12.6 16.8,12.82V14H17.42C17.76,14 18.03,14.28 18.03,14.62C18.03,14.96 17.76,15.24 17.42,15.24C17.2,15.24 17,15.12 16.89,14.93C16.71,14.64 16.34,14.54 16.05,14.71C15.75,14.87 15.65,15.25 15.82,15.55C16.15,16.11 16.76,16.47 17.42,16.47C18.43,16.47 19.26,15.64 19.26,14.62C19.26,13.84 18.76,13.14 18.03,12.88V12.82C18.41,12.6 18.65,12.2 18.65,11.76C18.65,11.3 18.38,10.91 18,10.7V6H20M8,13.66L7,14.66V13.24L8,12.24V13.66M8,10.71L7,11.71V10.29L8,9.29V10.71M7,8.71V7.29L8,6.29V7.71L7,8.71Z',
	turbine: 'M13.33,11.67L16.21,14.58C17.62,13.16 16.21,11.75 16.21,11.75L14.72,10.24C14.9,9.86 15,9.44 15,9C15,7.95 14.46,7.03 13.64,6.5L15,2.11C13.09,1.53 12.5,3.44 12.5,3.44L11.69,6.03C10.46,6.16 9.46,7 9.13,8.18L4.67,9.63C5.31,11.53 7.2,10.9 7.2,10.9L9.27,10.23C9.61,10.97 10.23,11.54 11,11.82V19C11,19 9,19 9,21C9,21.5 9,21.81 9,22H15V21C15,21 15,19 13,19V11.82C13.12,11.78 13.23,11.72 13.33,11.67M10.5,9A1.5,1.5 0 0,1 12,7.5A1.5,1.5 0 0,1 13.5,9A1.5,1.5 0 0,1 12,10.5A1.5,1.5 0 0,1 10.5,9Z',
	metmast: 'M7 5V13L22 11V7L7 5M10 6.91L13 7.31V10.69L10 11.09V6.91M16 7.71L19 8.11V9.89L16 10.29V7.71M5 10V11H6V12H5V21H3V4C3 3.45 3.45 3 4 3S5 3.45 5 4V6H6V7H5V10Z',
	antenna: 'M12 7.5C12.69 7.5 13.27 7.73 13.76 8.2S14.5 9.27 14.5 10C14.5 11.05 14 11.81 13 12.28V21H11V12.28C10 11.81 9.5 11.05 9.5 10C9.5 9.27 9.76 8.67 10.24 8.2S11.31 7.5 12 7.5M16.69 5.3C17.94 6.55 18.61 8.11 18.7 10C18.7 11.8 18.03 13.38 16.69 14.72L15.5 13.5C16.5 12.59 17 11.42 17 10C17 8.67 16.5 7.5 15.5 6.5L16.69 5.3M6.09 4.08C4.5 5.67 3.7 7.64 3.7 10S4.5 14.3 6.09 15.89L4.92 17.11C3 15.08 2 12.7 2 10C2 7.3 3 4.94 4.92 2.91L6.09 4.08M19.08 2.91C21 4.94 22 7.3 22 10C22 12.8 21 15.17 19.08 17.11L17.91 15.89C19.5 14.3 20.3 12.33 20.3 10S19.5 5.67 17.91 4.08L19.08 2.91M7.31 5.3L8.5 6.5C7.5 7.42 7 8.58 7 10C7 11.33 7.5 12.5 8.5 13.5L7.31 14.72C5.97 13.38 5.3 11.8 5.3 10C5.3 8.2 5.97 6.64 7.31 5.3Z',
	chimney: 'M4,18V20H8V18H4M4,14V16H14V14H4M10,18V20H14V18H10M16,14V16H20V14H16M16,18V20H20V18H16M2,22V8L7,12V8L12,12V8L17,12L18,2H21L22,12V22H2Z',
	powerline: 'M8.28,5.45L6.5,4.55L7.76,2H16.23L17.5,4.55L15.72,5.44L15,4H9L8.28,5.45M18.62,8H14.09L13.3,5H10.7L9.91,8H5.38L4.1,10.55L5.89,11.44L6.62,10H17.38L18.1,11.45L19.89,10.56L18.62,8M17.77,22H15.7L15.46,21.1L12,15.9L8.53,21.1L8.3,22H6.23L9.12,11H11.19L10.83,12.35L12,14.1L13.16,12.35L12.81,11H14.88L17.77,22M11.4,15L10.5,13.65L9.32,18.13L11.4,15M14.68,18.12L13.5,13.64L12.6,15L14.68,18.12Z',
	cableway: 'M14,17V19H22V21H2V19H10V17H3V5H8V3H16V5H21V17H14M5,7V15H10V7H5M19,7H16V8H14V9H16V10H14V11H16V12H14V13H16V14H14V15H19V7Z',
	terrain: 'M14,6L10.25,11L13.1,14.8L11.5,16C9.81,13.75 7,10 7,10L1,18H23L14,6Z',
	trees: 'M10,21V18H3L8,13H5L10,8H7L12,3L17,8H14L19,13H16L21,18H14V21H10Z',
	firing: 'M11,2V4.07C7.38,4.53 4.53,7.38 4.07,11H2V13H4.07C4.53,16.62 7.38,19.47 11,19.93V22H13V19.93C16.62,19.47 19.47,16.62 19.93,13H22V11H19.93C19.47,7.38 16.62,4.53 13,4.07V2M11,6.08V8H13V6.09C15.5,6.5 17.5,8.5 17.92,11H16V13H17.91C17.5,15.5 15.5,17.5 13,17.92V16H11V17.91C8.5,17.5 6.5,15.5 6.08,13H8V11H6.09C6.5,8.5 8.5,6.5 11,6.08M12,11A1,1 0 0,0 11,12A1,1 0 0,0 12,13A1,1 0 0,0 13,12A1,1 0 0,0 12,11Z',
	blasting: 'M11.25,6A3.25,3.25 0 0,1 14.5,2.75A3.25,3.25 0 0,1 17.75,6C17.75,6.42 18.08,6.75 18.5,6.75C18.92,6.75 19.25,6.42 19.25,6V5.25H20.75V6A2.25,2.25 0 0,1 18.5,8.25A2.25,2.25 0 0,1 16.25,6A1.75,1.75 0 0,0 14.5,4.25A1.75,1.75 0 0,0 12.75,6H14V7.29C16.89,8.15 19,10.83 19,14A7,7 0 0,1 12,21A7,7 0 0,1 5,14C5,10.83 7.11,8.15 10,7.29V6H11.25M22,6H24V7H22V6M19,4V2H20V4H19M20.91,4.38L22.33,2.96L23.04,3.67L21.62,5.09L20.91,4.38Z',
	bird: 'M23 11.5L19.95 10.37C19.69 9.22 19.04 8.56 19.04 8.56C17.4 6.92 14.75 6.92 13.11 8.56L11.63 10.04L5 3C4 7 5 11 7.45 14.22L2 19.5C2 19.5 10.89 21.5 16.07 17.45C18.83 15.29 19.45 14.03 19.84 12.7L23 11.5M17.71 11.72C17.32 12.11 16.68 12.11 16.29 11.72C15.9 11.33 15.9 10.7 16.29 10.31C16.68 9.92 17.32 9.92 17.71 10.31C18.1 10.7 18.1 11.33 17.71 11.72Z',
	laser: 'M9 13L5 16C4 16.88 3.86 18.12 4 19C4.13 20 4.91 21.22 6 21.68C7.57 22.35 9.09 21.9 10.04 20.92L19 13C20.86 11.62 20 9 18 9H12L19.46 4.61C19.9 4.29 20.08 3.82 20.06 3.37C20 2.67 19.46 2 18.6 2H18.54C18.19 2 17.86 2.11 17.56 2.29L5 9C4.19 9.46 3.94 10.24 4 11C4.05 12.03 4.74 13 6 13M5 18.5C5 17.12 6.12 16 7.5 16S10 17.12 10 18.5 8.88 21 7.5 21 5 19.88 5 18.5Z',
	balisage: 'M12,6A6,6 0 0,1 18,12C18,14.22 16.79,16.16 15,17.2V19A1,1 0 0,1 14,20H10A1,1 0 0,1 9,19V17.2C7.21,16.16 6,14.22 6,12A6,6 0 0,1 12,6M14,21V22A1,1 0 0,1 13,23H11A1,1 0 0,1 10,22V21H14M20,11H23V13H20V11M1,11H4V13H1V11M13,1V4H11V1H13M4.92,3.5L7.05,5.64L5.63,7.05L3.5,4.93L4.92,3.5M16.95,5.63L19.07,3.5L20.5,4.93L18.37,7.05L16.95,5.63Z',
};

/** On-screen floor for the artwork's hairline strokes (css px), matching
 *  MIN_STROKE_PX in airspaceGlyphs.ts so pin and deco keep one look. */
const MIN_STROKE_PX = 0.8;

/** Air kept between a pictogram and its 16 px window inside the disc (the
 *  disc is only half a px wider than the window, so the margin lives in the
 *  viewBox). */
const GLYPH_PAD = 1.06;

const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

// One rendered fragment per (kind, colour); pinGlyph runs on every icon
// cache miss, so the fragment build is memoised on its own.
const activityGlyphCache = new Map<string, string>();

/** An official SIA pictogram as a nested-SVG fragment for the pin: fills in
 *  the pin colour (interior holes via even-odd), the chart's white detail
 *  overpaint as paper white over the disc, hairline strokes floored to stay
 *  visible at 16 px. The viewBox is the glyph's padded tight box, so the
 *  default preserveAspectRatio centres and fits it. */
function activityGlyphSvg(kind: ActivityGlyphKind, color: string): string {
	const key = `${kind}|${color}`;
	let svg = activityGlyphCache.get(key);
	if (!svg) {
		const art = GLYPH_ART[kind];
		const hx = art.halfW * GLYPH_PAD;
		const hy = art.halfH * GLYPH_PAD;
		const pxPerUnit = 16 / (2 * Math.max(hx, hy));
		// i18n-ignore-start: SVG icon markup, not display text
		const parts = art.parts.map((p) => {
			const ink = p.knockout ? '#fff' : color;
			if (p.op === 'stroke') {
				const lw = Math.max(p.lw ?? 0, MIN_STROKE_PX / pxPerUnit);
				return (
					`<path d="${p.d}" fill="none" stroke="${ink}" stroke-width="${fmt(lw)}" ` +
					'stroke-linecap="round" stroke-linejoin="round"/>'
				);
			}
			return `<path d="${p.d}" fill="${ink}"${p.eo ? ' fill-rule="evenodd"' : ''}/>`;
		});
		svg =
			'<svg x="4.5" y="4.5" width="16" height="16" ' +
			`viewBox="${fmt(-hx)} ${fmt(-hy)} ${fmt(2 * hx)} ${fmt(2 * hy)}">` +
			parts.join('') +
			'</svg>';
		// i18n-ignore-end
		activityGlyphCache.set(key, svg);
	}
	return svg;
}

/** The pictogram fragment for a pin, or '' when the kind has none. */
function pinGlyph(obstacleType: string, color: string): string {
	const activity = ACTIVITY_PINS[obstacleType];
	if (activity) {
		return activityGlyphSvg(activity, color);
	}
	const d = OBSTACLE_GLYPHS[obstacleType];
	if (!d) {
		return '';
	}
	// i18n-ignore-start: SVG icon markup, not display text
	return (
		`<svg x="4.5" y="4.5" width="16" height="16" viewBox="0 0 24 24" fill="${color}">` +
		`<path d="${d}"/></svg>`
	);
	// i18n-ignore-end
}

const PIN_BODY =
	'M12.5 0 C5.6 0 0 5.6 0 12.5 C0 21.9 12.5 41 12.5 41 C12.5 41 25 21.9 25 12.5 C25 5.6 19.4 0 12.5 0 Z';

const COLORS: Record<CoordType, string> = {
	psn: '#cb2026',
	qualifierLine: '#1f5fbf',
};

function pinSvg(color: string, glyph: string, count: number): string {
	let badge = '';
	// i18n-ignore-start: SVG icon markup, not display text
	if (count > 1) {
		// Stack badge at the top-right of the pin head; white fill, the
		// pin's colour as outline + numeral. Fits inside the 25-wide
		// viewBox so the marker's anchor/size don't have to change.
		// Counts above 9 collapse to "9+" so the digit stays readable.
		const label = count > 9 ? '9+' : String(count);
		const fontSize = label.length > 1 ? 7.5 : 9;
		badge =
			`<circle cx="19" cy="6" r="6" fill="#fff" stroke="${color}" stroke-width="1.5"/>` +
			`<text x="19" y="9" text-anchor="middle" font-size="${fontSize}" ` +
			`font-weight="700" font-family="ui-sans-serif, system-ui, sans-serif" fill="${color}">${label}</text>`;
	}
	return (
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 41" width="25" height="41">' +
		`<path d="${PIN_BODY}" fill="${color}" stroke="#fff" stroke-width="1"/>` +
		'<circle cx="12.5" cy="12.5" r="8.5" fill="#fff"/>' +
		glyph +
		badge +
		'</svg>'
	);
	// i18n-ignore-end
}

// One icon per (colour, glyph, stack-count) tuple; markers of the same
// kind share it. Counts above 9 collapse to a single "9+" bucket.
const iconCache = new Map<string, L.DivIcon>();

/**
 * A teardrop-pin icon for a NOTAM position. PSN markers carry an activity /
 * obstacle pictogram when type icons are enabled; qualifier-line markers are
 * always plain. The selected state is toggled via a CSS class on the
 * marker's element (see applyHighlight in notamLayer.ts), so we only need
 * one icon per (type, glyph, stack-count) tuple.
 *
 * `count` > 1 paints a small count badge in the top-right corner so a stack
 * of NOTAMs at the same coordinate is visible at a glance. Click semantics
 * on a stacked marker live in notamLayer.ts.
 */
export function positionIcon(
	type: CoordType,
	obstacleType: string,
	typeIcons: boolean,
	count = 1,
): L.DivIcon {
	const color = COLORS[type];
	const glyph =
		type === 'psn' && typeIcons ? pinGlyph(obstacleType, color) : '';
	// Counts > 9 share one cached icon; they all render the "9+" badge.
	const countBucket = count > 9 ? 10 : count;
	const key = `${color}|${glyph ? obstacleType : ''}|${countBucket}`;
	let icon = iconCache.get(key);
	if (!icon) {
		icon = L.divIcon({
			html: pinSvg(color, glyph, count),
			className: 'notam-pin',
			iconSize: [25, 41],
			iconAnchor: [12, 41],
			popupAnchor: [1, -34],
		});
		iconCache.set(key, icon);
	}
	return icon;
}
