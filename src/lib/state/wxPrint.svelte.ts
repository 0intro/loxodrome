/* Request / cancel state for the Weather tab's standalone briefing print
 * (the meteo part of the flight dossier: METAR / TAF cards, then the
 * flight-relevant TEMSI and WINTEM charts). WxPrintHost, mounted once in
 * App, owns the whole prefetch + print lifecycle and keys on `seq`; this
 * module stays dumb so the portaled modal states can import cancelWxPrint
 * one-way (their open() calls cancel a pending briefing print, keeping the
 * "only one portaled document ever prints" invariant without a cycle). */

export const wxPrint = $state<{
	/** Bumped by requestWxPrint; WxPrintHost runs one job per bump. */
	seq: number;
	/** True while the host prefetches; the Weather tab disables its button
	 *  and shows a status line. */
	preparing: boolean;
	/** 'empty' when the last request found nothing to print. */
	note: 'empty' | null;
}>({ seq: 0, preparing: false, note: null });

export function requestWxPrint(): void {
	if (wxPrint.preparing) {
		return;
	}
	wxPrint.note = null;
	wxPrint.seq++;
}

/** Abandon a pending briefing print (a portaled modal is opening). The host
 *  checks `preparing` after its prefetch settles and stands down. */
export function cancelWxPrint(): void {
	wxPrint.preparing = false;
}
