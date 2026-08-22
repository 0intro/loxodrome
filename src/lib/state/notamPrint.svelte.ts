/* Request state for the List-tab "print all NOTAMs" bulletin. NotamPrintHost,
 * mounted once in App, runs one print job per `seq` bump. Deliberately dumb (no
 * async prefetch, unlike wxPrint): the NOTAMs are already in memory, so the host
 * mounts the doc and prints within a couple of frames. */

export const notamPrint = $state<{ seq: number }>({ seq: 0 });

/** Print the currently visible NOTAMs as a SOFIA-Briefing-style bulletin. */
export function requestNotamPrint(): void {
	notamPrint.seq++;
}
