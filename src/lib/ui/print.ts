/* The one way to open the print dialog (docs/android.md).
 *
 * On the web this is window.print(). In the Android shell window.print() is a
 * WebView no-op, so the custom Print plugin (PrintPlugin.java) hands the
 * WebView's print adapter to Android's print framework (system dialog, Save
 * as PDF), which renders with the same @media print CSS. The plugin call
 * resolves when the print JOB ends, and only then is a synthetic `afterprint`
 * dispatched: every print flow keys its teardown (claims, isolation classes,
 * portaled documents) on that event, so the page keeps its print state up
 * while Android renders. A real adapter-fired afterprint arriving first is
 * harmless: the listeners are one-shot and the releases idempotent.
 *
 * The ORIENTATION has to travel with the call, and it is the one thing the
 * two platforms do not share. On the web `@page { size: A4 landscape }` picks
 * the sheet. On Android the sheet comes from the PrintAttributes the app
 * hands the framework, and CSS cannot reach it: Chromium still lays the page
 * out at the size `@page` asks for, then SCALES that box onto whatever media
 * the framework chose. Measured on the Redmi with an empty PrintAttributes:
 * the landscape flight-prep Overview landed on an A4 PORTRAIT sheet shrunk to
 * ~71%, filling the top 41% and spilling its last box onto a second sheet.
 * So every caller states the orientation and the native side sets it as an
 * attribute; the parameter is required, so a new print flow cannot silently
 * inherit the wrong sheet. Both orientations pin A4, because every `@page` in
 * the app names it, the static portrait one in NavLogModal / FlightPrepModal
 * included: leaving portrait to the framework default only looked right on an
 * A4 device, and would have scaled the same way on a Letter one. */

import { isNativeApp } from '$lib/native/platform';

export type PageOrientation = 'portrait' | 'landscape';

/* The chart geometry the profile surfaces print at.
 *
 * A profile is an SVG built from an explicit pixel size, and every label it
 * places (a band's name, its vertical limits) is fitted at BUILD time: a
 * chart built small prints truncated labels however large the paper is. The
 * surfaces size it from the on-screen box, so the printed chart used to
 * inherit the dock: measured, a phone's 714x75 viewBox printed 37 SVG text
 * nodes where the desktop's 908x90 printed 43, losing every "SFC – … ft AMSL"
 * line and one whole band. Printing builds it at the page instead.
 *
 * A4 landscape at the 10mm margin both surfaces declare is 1046.9 x 718.1 px
 * of content (1122.5 x 793.7 less 37.8 a side, at 96 dpi). The width is the
 * same for both; the height is what is left under each surface's own chrome,
 * so they differ, and both leave real slack rather than filling that box:
 *
 *  - the chart is unbreakable, so anything that does not fit the space left
 *    on the sheet moves to the next one WHOLE, printing a page of chrome and
 *    a page of chart (measured at 555: the phone did exactly that),
 *  - the chrome above it is not fixed. The route profile's crossings strip
 *    grows a row per airspace the route meets, so a longer route than the
 *    one measured pushes the chart down,
 *  - the plot stack carries ~37px of its own below the chart, and Android's
 *    print framework applies its own minMargins on top of the CSS page box:
 *    measured on the Redmi, the usable band is ~707px, not 718.
 *
 * PrintDoc's dossier profile keeps its own 1030 x 640: it is a full-page
 * chart with nothing above it. */
export const PRINT_PLOT_W = 1040;
/** Route profile: title, the forbidden-crossing banner and the crossings
 *  strip sit above the chart (133px for the measured route). */
export const PRINT_ROUTE_PLOT_H = 480;
/** Nav profile: title only, so the chart takes more of the sheet. */
export const PRINT_NAV_PLOT_H = 600;

interface NativePrinter {
	print(options: { name: string; landscape: boolean }): Promise<void>;
}

let printer: NativePrinter | null = null;

/** The orientation an `@page` block asks for; portrait when it asks for
 *  nothing, which is what the flows carrying only the static portrait `@page`
 *  mean (it cannot be class-scoped, so they register no pageCss). Reading it
 *  off the very CSS a flow installs is what keeps the sheet Android is asked
 *  for from drifting away from the one the layout assumes. */
export function pageOrientation(pageCss: string | null): PageOrientation {
	return pageCss !== null && /@page[^{}]*\{[^{}]*\blandscape\b/i.test(pageCss)
		? 'landscape'
		: 'portrait';
}

export function printPage(orientation: PageOrientation): void {
	if (!isNativeApp()) {
		window.print();
		return;
	}
	void nativePrint(orientation);
}

async function nativePrint(orientation: PageOrientation): Promise<void> {
	try {
		if (!printer) {
			const { registerPlugin } = await import('@capacitor/core');
			printer = registerPlugin<NativePrinter>('Print');
		}
		await printer.print({ name: document.title, landscape: orientation === 'landscape' });
	} catch {
		/* print service unavailable; the afterprint below still releases the
		 * flow's print state */
	} finally {
		window.dispatchEvent(new Event('afterprint'));
	}
}
