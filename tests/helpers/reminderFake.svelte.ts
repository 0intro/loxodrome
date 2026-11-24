/* The verdict and gates the reminder's spec sets by hand
 * (tests/briefingReminder.client.spec.ts), reactive as the app's are. */

import type { BriefingReason } from '$lib/notam/briefingVerdict';

export const fake = $state<{ reasons: BriefingReason[]; replaceable: boolean; sourceReady: boolean }>({
	reasons: [],
	replaceable: true,
	sourceReady: true,
});
