/* The plan's state in words (state/planDocument planState is the code), for
 * the plan chip's title and the plan menu's state line. A shared computer's
 * workspace goes when its session ends, so "kept on this device" would be
 * untrue there. */
import { isoDateUtc } from '$lib/nav/logbook';
import { fmtClockUtc } from '$lib/route/format';
import { activePlan } from '$lib/state/activePlan.svelte';
import { t } from '$lib/state/i18n.svelte';
import { planState } from '$lib/state/planDocument.svelte';
import { sharedDeviceFlag } from '$lib/sync/keys';

export function planStateText(): string {
	const state = planState();
	switch (state) {
		case 'empty':
			return t.plan.stateEmpty;
		case 'new':
			return sharedDeviceFlag() ? t.plan.stateNewShared : t.plan.stateNew;
		case 'dirty':
			return t.plan.stateDirty;
		case 'lossy':
			return t.plan.stateLossy;
		case 'saved': {
			const at = activePlan.source?.savedAtMs ?? 0;
			return t.plan.stateSaved(`${isoDateUtc(at)} ${fmtClockUtc(at)}Z`);
		}
		default: {
			const never: never = state;
			return never;
		}
	}
}
