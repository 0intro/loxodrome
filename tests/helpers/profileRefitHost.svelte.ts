/* Hosts for the route profile's refit timing
 * (components/profileRefit.svelte.ts): the settled refit alone over plain
 * $state inputs, and the chain the modal and the chart make together, the
 * chart's hold report writing the modal's held flag, each side in its own
 * root so the chart can go away under a held leg as a closed surface makes
 * it. */
import { useHoldReport, useSettledRefit } from '$lib/components/profileRefit.svelte';

export interface RefitInputs {
	changes: number;
	held: boolean;
	ready: boolean;
	/** Read by the refit itself: writing it must schedule nothing. */
	readByRefit: number;
}

export interface RefitHost {
	s: RefitInputs;
	refits: () => number;
	stop: () => void;
}

export function mountRefitHost(init: Partial<RefitInputs> = {}): RefitHost {
	const s = $state<RefitInputs>({ changes: 0, held: false, ready: true, readByRefit: 0, ...init });
	let refits = 0;
	const stop = $effect.root(() => {
		useSettledRefit({
			changes: () => s.changes,
			held: () => s.held,
			ready: () => s.ready,
			refit: () => {
				void s.readByRefit;
				refits++;
			},
		});
	});
	return { s, refits: () => refits, stop };
}

export interface HoldChain {
	/** The modal's side: the edits, the gate, and the flag the chart writes. */
	modal: { changes: number; ready: boolean; held: boolean };
	/** The chart's side: whether a leg is being dragged. */
	chart: { dragging: boolean };
	refits: () => number;
	/** Unmount the chart alone, as closing the surface does mid-drag. */
	stopChart: () => void;
	stop: () => void;
}

/** `readingSink`: a sink that READS the flag before writing it, which the
 *  modal's is careful not to be; the report must survive one anyway. */
export function mountHoldChain(opts: { readingSink?: boolean } = {}): HoldChain {
	const modal = $state({ changes: 0, ready: true, held: false });
	const chart = $state({ dragging: false });
	let refits = 0;
	// The modal's sink: one identity for the chart's lifetime.
	const onLegHold = opts.readingSink
		? (held: boolean): void => {
				if (modal.held !== held) {
					modal.held = held;
				}
			}
		: (held: boolean): void => {
				modal.held = held;
			};
	const stopModal = $effect.root(() => {
		useSettledRefit({
			changes: () => modal.changes,
			held: () => modal.held,
			ready: () => modal.ready,
			refit: () => {
				refits++;
			},
		});
	});
	const stopChart = $effect.root(() => {
		useHoldReport(
			() => chart.dragging,
			() => onLegHold,
		);
	});
	return {
		modal,
		chart,
		refits: () => refits,
		stopChart,
		stop: () => {
			stopChart();
			stopModal();
		},
	};
}
