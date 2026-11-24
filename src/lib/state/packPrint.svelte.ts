/* How the flight-prep packs are asked for: the preparation pack (the four
 * pages), the flight dossier and every route's profile sheet, printed by
 * PackPrintHost, mounted once in App, from wherever they are asked for, the
 * workbook open or not.
 * Import-free like wxPrint.svelte.ts, so the surface state modules can
 * import it one way.
 *
 * A request runs the host's registered runner IN THE CALLER'S TICK. A menu
 * row that closes its menu then hands its history entry to the progress
 * card (backClose's same-tick reuse), where a counter an effect reads would
 * mount the card a microtask after the menu's release, its entry pushed
 * under a back still in flight. */

export type PackMode = 'prep' | 'dossier' | 'profiles';

export const packPrint = $state<{
	/** True from a request to the job's afterprint: every print row stands
	 *  down (printBusy). */
	preparing: boolean;
}>({ preparing: false });

let runner: ((mode: PackMode) => void) | null = null;

/** The host's runner, for as long as the host is mounted. */
export function registerPackPrint(run: (mode: PackMode) => void): () => void {
	runner = run;
	return () => {
		if (runner === run) {
			runner = null;
		}
	};
}

export function requestPackPrint(mode: PackMode): void {
	runner?.(mode);
}
