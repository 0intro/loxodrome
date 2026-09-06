/* gen-brand.js: writes the Loxodrome mark and every SVG master built from it.
 *
 * A loxodrome is the course that crosses every meridian at a constant angle.
 * Seen from the pole, meridians are rays and a curve crossing all of them at
 * one angle is, by definition, a logarithmic spiral:
 *
 *	r(t) = r0 * exp(-t * cot B)
 *
 * so the mark is not a drawing of the idea, it is the curve itself at
 * B = 84 degrees over 1.3 turns, converging on a pole dot. That is why this
 * is generated: the path is a hundred numbers no one can maintain by hand,
 * and the six constants below are the part a reader needs.
 *
 * The mark is ONE stroke. Two additions were drawn and rejected against
 * renders at every shipped size: four meridian rays to the rim made a
 * gunsight, and a course arrow at the terminus read as a bird's head at the
 * stroke weight the small sizes need. The spiral alone carries it, and its
 * own outer turn closes the silhouette into the circle the wordmark needs
 * for its O.
 *
 * Emits (run `npm run gen:brand`):
 *
 *	assets/logo.svg			1024, the icon/splash source @capacitor/assets reads
 *	assets/mark.svg			1024, the mark on transparency, the wordmark's O
 *	assets/og.svg			1200x630 social preview
 *	assets/feature-graphic.svg	1024x500 Play feature graphic
 *	public/favicon.svg		32, same geometry, weights tuned for 16px
 *	android .../ic_launcher_monochrome.xml	themed-icon layer
 *	android .../ic_stat_navrec.xml		recording-notification icon
 *
 * The two Android files are VectorDrawables, which take the same path grammar
 * as SVG but no <circle>, so every circle here is emitted as a path.
 *
 * Rasterising (inkscape + magick) is docs/brand.md; this writes vectors only.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* The domain printed on the social preview. Nothing is registered yet, so it
 * is a parameter rather than a literal buried in the markup. */
const DOMAIN = process.env.BRAND_DOMAIN ?? 'loxodrome.fr';

/* Chart blue: the app's --accent (src/styles/theme.css) and the manifest
 * theme_color. White on it measures 6.16:1, so the mark clears AA as line
 * art. */
const BLUE = '#1f5fbf';
const INK = '#111418';
const MUTED = '#5a6472';

const BETA = 84; // the constant course angle to every meridian
const TURNS = 1.3;

/* Stroke and pole as fractions of the outer radius, so the mark keeps its
 * proportions at whatever size it is instantiated. Tuned by rendering: below
 * about 0.26 the spiral goes wiry at 16px, above 0.29 its own turns touch. */
const STROKE = 0.276;
const DOT = 0.162;
const PHASE = 100; // where the outbound end sits, just west of north

/* The 1024 master. The number that matters is the INK, not the path: the
 * stroke is centred, so the mark reaches r0 * (1 + STROKE/2) = r0 * 1.138.
 * At r0 = 334 the ink spans 334 * 1.138 * 0.82 * 2 / 1024 = 60.9% of the
 * canvas.
 *
 * What that 60.9% is measured against differs per consumer, and only one of
 * them binds. Android: the mipmaps are the 108dp adaptive canvas, the XML
 * insets them 16.7% so they fill the 72dp visible face, and the 66dp safe
 * zone is therefore 91.7% OF THE PNG, which this clears with room to spare.
 * PWA: icon-192/512 are declared "any maskable", where the safe zone is 80%
 * of the tile, cleared too. So the size here is not set by a safe zone at
 * all, it is set by the mark it replaces, which measured 63.0%: a rename
 * should not quietly resize the icon on anyone's home screen. */
const R_LOGO = 334;

/* The favicon carries no safe-zone shrink, so it runs a little larger in its
 * own canvas, and that is the whole difference between the two masters. */
const R_FAVICON = 10.5;

const rad = (deg) => (deg * Math.PI) / 180;
const n = (v) => {
	const s = v.toFixed(2);
	return s.replace(/\.?0+$/, '') || '0';
};

/* The spiral, sampled into cubic Beziers. Hermite tangents scaled by h/3 give
 * the standard arc approximation; at 22.5 degrees a segment the error is far
 * under a pixel at any size this is rendered. */
function spiralPath(c, r0) {
	const k = 1 / Math.tan(rad(BETA));
	const total = TURNS * 2 * Math.PI;
	const count = Math.ceil(total / (Math.PI / 8));
	const h = total / count;
	const at = (t) => {
		const r = r0 * Math.exp(-k * t);
		const a = rad(PHASE) + t;
		return [c + r * Math.cos(a), c - r * Math.sin(a)];
	};
	const deriv = (t) => {
		const r = r0 * Math.exp(-k * t);
		const a = rad(PHASE) + t;
		return [
			r * (-k * Math.cos(a) - Math.sin(a)),
			r * (k * Math.sin(a) - Math.cos(a)),
		];
	};
	const [x0, y0] = at(0);
	let d = `M${n(x0)} ${n(y0)}`;
	for (let i = 0; i < count; i++) {
		const t0 = i * h;
		const t1 = t0 + h;
		const [px, py] = at(t0);
		const [qx, qy] = at(t1);
		const [dx0, dy0] = deriv(t0);
		const [dx1, dy1] = deriv(t1);
		d +=
			`C${n(px + (h / 3) * dx0)} ${n(py + (h / 3) * dy0)}` +
			` ${n(qx - (h / 3) * dx1)} ${n(qy - (h / 3) * dy1)}` +
			` ${n(qx)} ${n(qy)}`;
	}
	return d;
}

/* VectorDrawable has no <circle>, so the pole travels as a path. */
function circlePath(cx, cy, r) {
	return (
		`M${n(cx - r)} ${n(cy)}` +
		`a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0` +
		`a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`
	);
}

function markBody(c, r0, colour, indent = '\t\t') {
	return [
		`<path d="${spiralPath(c, r0)}" fill="none" stroke="${colour}" stroke-width="${n(r0 * STROKE)}" stroke-linecap="round"/>`,
		`<circle cx="${n(c)}" cy="${n(c)}" r="${n(r0 * DOT)}" fill="${colour}"/>`,
	]
		.map((p) => indent + p)
		.join('\n');
}

const HEAD = (w, h, label) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${label}">`;

const GENERATED = 'GENERATED by scripts/gen-brand.js; edit the geometry there.';

/* assets/logo.svg. No background rect: @capacitor/assets paints the launcher
 * background from --iconBackgroundColor, and the 0.82 group is the adaptive
 * safe zone. */
function logoSvg() {
	return `${HEAD(1024, 1024, 'Loxodrome')}
	<!-- ${GENERATED}
	     A loxodrome seen from the pole: the logarithmic spiral
	     r = ${R_LOGO}*exp(-t*cot ${BETA}deg) over ${TURNS} turns, converging on the pole.
	     The 0.82 group holds the ink at 60.9% of the canvas, inside
	     Android's 61.1% adaptive safe zone. -->
	<g transform="translate(512 512) scale(0.82) translate(-512 -512)">
${markBody(512, R_LOGO, '#fff')}
	</g>
</svg>
`;
}

/* assets/mark.svg: the mark alone, for the wordmark's O and for print. */
function markSvg() {
	return `${HEAD(1024, 1024, 'Loxodrome')}
	<!-- ${GENERATED} -->
${markBody(512, R_LOGO, BLUE, '\t')}
</svg>
`;
}

/* public/favicon.svg: same construction, full-bleed blue. */
function faviconSvg() {
	return `${HEAD(32, 32, 'Loxodrome')}
	<!-- ${GENERATED}
	     The same spiral as assets/logo.svg, at the larger radius a browser
	     tab allows (no adaptive safe zone to respect). Checked by eye at
	     16px, which is the size that decides everything here. -->
	<rect width="32" height="32" fill="${BLUE}"/>
${markBody(16, R_FAVICON, '#fff', '\t')}
</svg>
`;
}

/* The wordmark: LOXODROME with the mark as the first O. Inter Display is
 * installed locally and is what the current og.png matches. The letters are
 * set in two runs so the mark takes a letter's slot exactly. */
function lockup({ x, y, cap, colour, markColour }) {
	const track = cap * 0.06;
	const advance = cap * 0.78 + track;
	/* A cap-height O would be r = cap/2. The mark runs larger because it is
	 * open line work against solid caps: at the letter's own radius it reads
	 * as a small icon dropped between two letters rather than as one of them,
	 * and scaling it also thickens its stroke toward the letter weight. */
	const r = cap * 0.62;
	const gap = cap * 0.05;
	const mx = x + advance + gap + r;
	const ax = mx + r + gap;
	const scale = r / R_LOGO;
	const font =
		'font-family="Inter Display, Inter, system-ui, sans-serif" font-weight="800"';
	return `	<g>
		<text x="${n(x)}" y="${n(y)}" ${font} font-size="${n(cap * 1.36)}" letter-spacing="${n(track)}" fill="${colour}" dominant-baseline="central">L</text>
		<g transform="translate(${n(mx - 512 * scale)} ${n(y - 512 * scale)}) scale(${scale.toFixed(5)})">
${markBody(512, R_LOGO, markColour, '\t\t\t')}
		</g>
		<text x="${n(ax)}" y="${n(y)}" ${font} font-size="${n(cap * 1.36)}" letter-spacing="${n(track)}" fill="${colour}" dominant-baseline="central">XODROME</text>
	</g>`;
}

/* public/og.png source. The lockup already carries the mark, so there is no
 * separate icon tile: showing both would print the mark twice. */
function ogSvg() {
	return `${HEAD(1200, 630, 'Loxodrome')}
	<!-- ${GENERATED} -->
	<rect width="1200" height="630" fill="#fff"/>
	<rect width="1200" height="10" fill="${BLUE}"/>
${lockup({ x: 96, y: 262, cap: 92, colour: INK, markColour: BLUE })}
	<text x="96" y="392" font-family="Inter, system-ui, sans-serif" font-size="34" fill="${MUTED}">Aeronautical information, flight preparation and</text>
	<text x="96" y="440" font-family="Inter, system-ui, sans-serif" font-size="34" fill="${MUTED}">navigation, on one chart-faithful map.</text>
	<text x="96" y="524" font-family="Inter, system-ui, sans-serif" font-weight="700" font-size="32" fill="${BLUE}">${DOMAIN}</text>
</svg>
`;
}

/* Play feature graphic. Play crops this on some surfaces, so nothing that has
 * to be read goes near an edge and there is no domain line at all. */
function featureSvg() {
	/* The ghost bleeds off three edges on purpose: contained, it reads as a
	 * second logo someone forgot to delete. */
	const scale = 0.86;
	return `${HEAD(1024, 500, 'Loxodrome')}
	<!-- ${GENERATED} Flatten on export: Play rejects an alpha channel here. -->
	<rect width="1024" height="500" fill="${BLUE}"/>
	<g opacity="0.13" transform="translate(${n(900 - 512 * scale)} ${n(250 - 512 * scale)}) scale(${scale})">
${markBody(512, R_LOGO, '#fff', '\t\t')}
	</g>
${lockup({ x: 84, y: 214, cap: 76, colour: '#fff', markColour: '#fff' })}
	<text x="84" y="316" font-family="Inter, system-ui, sans-serif" font-size="30" fill="#dbe6fa">Charts, NOTAMs, weather, flight preparation</text>
	<text x="84" y="360" font-family="Inter, system-ui, sans-serif" font-size="30" fill="#dbe6fa">and live navigation for VFR pilots.</text>
</svg>
`;
}

/* Android VectorDrawables. Alpha-only white, which is the contract for a
 * status-bar small icon and for the themed-icon layer alike. */
function vectorXml(comment, r0) {
	return `<!-- ${comment}
     ${GENERATED} -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="1024"
    android:viewportHeight="1024">
    <path
        android:pathData="${spiralPath(512, r0)}"
        android:fillColor="#00000000"
        android:strokeColor="#FFFFFFFF"
        android:strokeWidth="${n(r0 * STROKE)}"
        android:strokeLineCap="round" />
    <path
        android:pathData="${circlePath(512, 512, r0 * DOT)}"
        android:fillColor="#FFFFFFFF" />
</vector>
`;
}

const RES = join(ROOT, 'android/app/src/main/res/drawable');

const OUT = [
	[join(ROOT, 'assets/logo.svg'), logoSvg()],
	[join(ROOT, 'assets/mark.svg'), markSvg()],
	[join(ROOT, 'assets/og.svg'), ogSvg()],
	[join(ROOT, 'assets/feature-graphic.svg'), featureSvg()],
	[join(ROOT, 'public/favicon.svg'), faviconSvg()],
	[
		join(RES, 'ic_launcher_monochrome.xml'),
		/* The themed layer is masked like the adaptive icon, so it is drawn at
		 * the same 0.82 the launcher expects. */
		vectorXml('Themed-icon layer for Android 13+.', R_LOGO * 0.82),
	],
	[
		join(RES, 'ic_stat_navrec.xml'),
		/* Unlike the themed layer, this one is masked by nothing and inset by
		 * nothing: it is a bare 24dp glyph, so it fills its box the way a
		 * status-bar icon should. 351 puts the ink at 78%, leaving the ~2dp
		 * of padding the platform expects. */
		vectorXml('Status-bar icon for the recording notification.', 351),
	],
];

for (const [path, body] of OUT) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
	console.log(`wrote ${path.slice(ROOT.length + 1)}`);
}
