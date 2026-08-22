/* Q-code decode tables. The canonical English tables stay in $lib/notam
 * (pure fallback for locale-free code paths); this domain re-exports them so
 * the French mirror is key-checked against the same literal keys, and the
 * locale-aware decode (decodeQ in state/i18n.svelte.ts) reads t.qcode. */

import { Q_CONDITIONS, Q_SUBJECTS } from '$lib/notam/qcode';

export const qcode = {
	conditions: Q_CONDITIONS,
	subjects: Q_SUBJECTS,
};
