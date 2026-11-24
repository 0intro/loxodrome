/* What a NOTAM that creates an area says of the area's activity: in force
 * over its period, activable within it ("ZRT ACTIVABLE H24 AVEC UN PREAVIS
 * DE 24 HEURES", "ZRT MAY BE ACTIVATED H24 WITH A 24HR PN", R0564/26), its
 * real activity known from a unit, or activated by a further NOTAM. The words read in the two languages the SIA publishes in, so the
 * French and the English text of one NOTAM read alike
 * (tests/notamAreaActivity.spec.ts). Pure. */

import { notamEText } from './sections';
import type { Notam } from './types';

/** Activation by a further NOTAM: "ACTIVABLE PAR NOTAM", "ACTIVATED BY
 *  NOTAM", "ACTIVITE ANNONCEE PAR VOIE DE NOTAM". */
const BY_NOTAM_RE =
	/\b(?:ACTIVABLES?|ACTIVATION|ACTIVATED|ACTIVEE?S?|ACTIVITE|ACTIVITY|ANNONCEE?S?|ANNOUNCED)\s+(?:PAR|BY)\s+(?:VOIE\s+DE\s+)?NOTAMS?\b/;

/** Activable: "ACTIVABLE", "ACTIVATABLE" (R3509/26), "PEUT ETRE ACTIVEE",
 *  "SUSCEPTIBLE D'ETRE ACTIVEE", "MAY BE ACTIVATED", "MAY BE ACT"
 *  (R2633/26), "CAN BE ACTIVED" (R2170/26), "POSSIBLE ACTIVATION". */
const ACTIVABLE_RE =
	/\b(?:ACTIVA(?:TA)?BLES?|(?:PEUT|PEUVENT|POURRA|POURRONT)\s+ETRE\s+ACTIVEE?S?|SUSCEPTIBLES?\s+D.?\s*ETRE\s+ACTIVEE?S?|(?:MAY|CAN|COULD)\s+BE\s+(?:ACTIVATED|ACTIVED|ACT)|POSSIBLE\s+ACTIVATION|ACTIVATION\s+POSSIBLE)\b/;

/** The real activity known from a unit, which knows when the area is
 *  active within its period: "ACTIVITE REELLE CONNUE DE" (R2307/26),
 *  "ACTIVITE CONNUE SUR" (W2502/26), "ACTUAL ACTIVITY AVBL AT", "ACT KNOWN
 *  FROM" (W1912/26), "ACTUAL TIME OF ACTIVITY ANNOUNCED ON" (R2909/26),
 *  "ACTIVITY INFO AVBL ON", and the misspellings the SIA prints ("RELLE",
 *  R1041/26, "REELE", R3504/26, "ACTAUL", W0229/26). The template's "ZRT,
 *  QUI LORSQU'ELLE EST ACTIVE" heads every ZRT, an H24 one too (R3114/26),
 *  and says nothing of when. */
const KNOWN_FROM_RE =
	/\b(?:ACTIVITES?\s+(?:RE?E?L+E?S?\s+)?(?:CONNUES?|DISPONIBLES?|COMMUNIQUEES?|DIFFUSEES?|FOURNIES?|ANNONCEES?)|(?:(?:ACTUAL|ACTAUL|REAL)\s+(?:TIME\s+OF\s+)?)?(?:ACTIVITY|ACT)\s+(?:INFO\s+)?(?:KNOWN|AVBL|AVAILABLE|ANNOUNCED|PROVIDED)|(?:ACTUAL|ACTAUL|REAL)\s+(?:ACTIVITY|ACT)\s+(?:INFO|FREQ))\b/;

/** The mode the area's E) text states: by NOTAM where its activations
 *  come by NOTAM, activable where it may be activated or its real
 *  activity is known from a unit, else firm, in force over its whole
 *  period. */
export function areaMode(n: Notam): 'firm' | 'activable' | 'notam' {
	const e = notamEText(n).toUpperCase().replace(/\s+/g, ' ');
	if (BY_NOTAM_RE.test(e)) {
		return 'notam';
	}
	return ACTIVABLE_RE.test(e) || KNOWN_FROM_RE.test(e) ? 'activable' : 'firm';
}
