/* The `accept` attribute of a file input, corrected for Android.
 *
 * Android's file chooser filters by MIME TYPE, and Android's MIME table has no
 * entry for `yaml`, `yml`, `gpx` or `igc`. Both Android faces of this app then turn a
 * perfectly ordinary accept list into a filter that matches nothing, so every
 * file the user came for is greyed out:
 *
 *  - the Capacitor WebView (BridgeWebChromeClient.getValidTypes) DROPS the
 *    accept entries whose extension it cannot resolve, keeps the literal
 *    `text/yaml`, and sets it as both the intent type and EXTRA_MIME_TYPES.
 *    A .yaml that came through a download or a share sheet is typed
 *    `application/octet-stream` by its provider, so it never matches;
 *  - Chrome for Android, which also serves the installed PWA
 *    (SelectFileDialog.ensureMimeType), passes the literal `.yaml` through as
 *    if it were a MIME type, which matches nothing either.
 *
 * So the fix cannot hide behind isNativeApp(): the bug belongs to Android's
 * chooser, not to the native shell. On Android we ask for everything and let
 * the parser reject what it cannot read; every other platform keeps the
 * extension filter, where it works as intended.
 *
 * ALL_FILES below rather than no attribute at all: the wildcard is the one
 * value both engines handle identically (a single, valid MIME type, so no
 * EXTRA_MIME_TYPES is written and getValidTypes never indexes an empty array).
 */

const ALL_FILES = '*/*';

function isAndroid(): boolean {
	if (typeof navigator === 'undefined') {
		return false;
	}
	const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
	if (data?.platform) {
		return data.platform === 'Android';
	}
	return /Android/i.test(navigator.userAgent);
}

export function pickerAccept(accept: string): string {
	return isAndroid() ? ALL_FILES : accept;
}
