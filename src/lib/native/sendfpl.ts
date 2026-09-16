/* The one way to hand a route to SendFPL (docs/sendfpl.md).
 *
 * Three ways out, and the menu rows word themselves from the same answer the
 * hand-off acts on, so a row cannot promise what this platform will not do:
 *
 * - `intent`: in the Android shell the SendFpl plugin (SendFplPlugin.java)
 *   fires an explicit ACTION_SEND at app.sendfpl, so the button opens SendFPL
 *   itself rather than a sheet of everything that takes text. Any failure --
 *   SendFPL not installed, the activity gone -- degrades to the ordinary share
 *   sheet, which SendFPL also claims for text/plain, so the route still reaches
 *   it wherever it is and reaches something useful when it is absent.
 * - `share`: an Android BROWSER reaches that same sheet through
 *   navigator.share, and SendFPL's own ACTION_SEND / text/plain filter is what
 *   puts it in there, so the route is one tap from the navigator with no shell
 *   at all. The raw WebView has no navigator.share, which is why the shell
 *   keeps its plugin; the installed PWA is not the shell and takes this tier.
 * - `clipboard`: everywhere else there is no SendFPL to open, so the route goes
 *   to the clipboard, which pastes verbatim into SendFPL's own route box. */

import { isNativeApp } from '$lib/native/platform';
import { isAndroidOs } from '$lib/ui/platform';
import { copyText } from '$lib/ui/clipboard';

/** What actually happened, as a code the caller words itself: the route left
 *  for another app, or it is on the clipboard and the user carries it, or
 *  neither worked. */
export type SendOutcome = 'sent' | 'copied' | 'failed';

/** Which of the three ways out this platform has. */
export type Handoff = 'intent' | 'share' | 'clipboard';

/** The ladder, pure: the shell first, then the sheet, but only where SendFPL
 *  can be in it. A desktop share sheet holds no SendFPL and would be worse
 *  than the clipboard, so the OS decides and not the API alone. */
export function handoffFor(native: boolean, android: boolean, shares: boolean): Handoff {
	if (native) {
		return 'intent';
	}
	return android && shares ? 'share' : 'clipboard';
}

/** This platform's answer. Constant for the session, read by the rows for
 *  their wording as much as by the hand-off for its route. */
export function sendFplHandoff(): Handoff {
	const shares = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
	return handoffFor(isNativeApp(), isAndroidOs(), shares);
}

interface NativeSender {
	send(options: { route: string }): Promise<void>;
}

let sender: NativeSender | null = null;

export async function sendRouteToSendFpl(route: string): Promise<SendOutcome> {
	const how = sendFplHandoff();
	if (how === 'intent') {
		return sendThroughPlugin(route);
	}
	if (how === 'share') {
		return shareRoute(route);
	}
	return (await copyText(route)) ? 'copied' : 'failed';
}

async function sendThroughPlugin(route: string): Promise<SendOutcome> {
	try {
		if (!sender) {
			const { registerPlugin } = await import('@capacitor/core');
			sender = registerPlugin<NativeSender>('SendFpl');
		}
		await sender.send({ route });
		return 'sent';
	} catch {
		/* SendFPL is not installed, or would not start: fall through. */
	}
	try {
		const { Share } = await import('@capacitor/share');
		await Share.share({ text: route });
	} catch {
		/* The sheet was dismissed, which is not a failure, and nothing here can
		 * tell that from one; downloadBlob's nativeSave swallows it the same way. */
	}
	return 'sent';
}

/** The browser's own sheet. AbortError is what the platform throws BOTH for a
 *  dismissed chooser and for no target at all, and nothing here can tell those
 *  apart either, so it is swallowed the way the native dismissal is; any other
 *  rejection is the API refusing, and the clipboard still carries the route. */
async function shareRoute(route: string): Promise<SendOutcome> {
	try {
		await navigator.share({ text: route });
		return 'sent';
	} catch (err) {
		if ((err as { name?: string } | null)?.name === 'AbortError') {
			return 'sent';
		}
	}
	return (await copyText(route)) ? 'copied' : 'failed';
}
