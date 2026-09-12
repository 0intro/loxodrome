/* The browser facts the app needs from the host platform: which vertical datum
 * a GNSS altitude arrives on, and whether this is the one system that can be
 * carrying SendFPL.
 *
 * Both tests are per OPERATING SYSTEM, not per browser. Apple's Core Location
 * reports `altitude` above mean sea level, and every browser on macOS, iOS and
 * iPadOS obtains its position through it, so Safari, Chrome and Firefox all
 * report MSL there; everywhere else the W3C definition (height above the WGS84
 * ellipsoid) holds. That also makes the long-standing iPadOS ambiguity
 * harmless: an iPad presenting itself as a Mac lands in the same bucket it
 * belongs to.
 *
 * A wrong answer here is a ~150 ft error, so it is a DEFAULT, never a verdict:
 * the Display tab pins the datum explicitly (docs/nav-live.md). */

import type { AltDatum } from '$lib/nav/altitudeDatum';

interface UADataLike {
	platform?: string;
}

/** The datum this platform's `coords.altitude` is on. */
export function platformAltDatum(): AltDatum {
	if (typeof navigator === 'undefined') {
		return 'ellipsoid';
	}
	// userAgentData.platform is the unspoofed, structured answer where it
	// exists (Chromium); everywhere else the UA string still carries the OS.
	const nav = navigator as Navigator & { userAgentData?: UADataLike };
	const hinted = nav.userAgentData?.platform ?? '';
	if (hinted) {
		return /^(macos|ios|ipados)$/i.test(hinted) ? 'msl' : 'ellipsoid';
	}
	return /\b(Macintosh|Mac OS X|iPhone|iPad|iPod)\b/.test(nav.userAgent) ? 'msl' : 'ellipsoid';
}

/** Whether the host system is Android, the only one SendFPL runs on
 *  (docs/sendfpl.md). A wrong answer is a default here too: a missed Android
 *  leaves the route on the clipboard, and a false one opens a share sheet
 *  SendFPL is absent from. */
export function isAndroidOs(): boolean {
	if (typeof navigator === 'undefined') {
		return false;
	}
	const nav = navigator as Navigator & { userAgentData?: UADataLike };
	const hinted = nav.userAgentData?.platform ?? '';
	if (hinted) {
		return /^android$/i.test(hinted);
	}
	return /\bAndroid\b/.test(nav.userAgent);
}
