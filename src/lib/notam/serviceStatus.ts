/**
 * Classify a NOTAM as declaring its subject UNSERVICEABLE (out of service) or
 * RESTORED (back in service), from the Q-code condition and the E-text.
 *
 * The Q-code condition (e.g. QND**AS** = unserviceable) is authoritative; the
 * free-text phrases - in English, French and Spanish, the languages of the
 * FR / UK / ES NOTAM corpus this app handles - decide only when the condition
 * is generic. Restored signals are checked first so a "back in service" NOTAM
 * that recalls the prior outage ("REMISE EN SERVICE ... PRECEDEMMENT HORS
 * SERVICE") doesn't read as unserviceable.
 *
 * Mirrors classifyObstacle in classify.ts: uppercased text, word-boundary
 * regexes, unaccented (the NOTAM corpus is all-caps ASCII).
 */

import type { ServiceStatus } from './types';
import { isUnserviceableCondition, isRestoredCondition } from './qcode';

// Back in / kept in service. EN + FR + ES.
const RESTORED_RE =
	/\b(?:BACK|RETURNED|RESTORED)\s+(?:IN|TO)\s+(?:SERVICE|SVC|OPERATION)\b|\bREINSTATED\b|\bREMIS(?:E|ES)?\s+EN\s+(?:SERVICE|SVC)\b|\bRETOUR\s+EN\s+(?:SERVICE|SVC)\b|\bRETABLIE?S?\b|\bVUELT[OA]\s+AL\s+SERVICIO\b|\bRESTABLECID[OA]S?\b/;

// Out of service. EN + FR + ES.
const UNSERVICEABLE_RE =
	/\bU\s*\/\s*S\b|\bUNSERVICEABLE\b|\bUNUSABLE\b|\bOUT\s+OF\s+(?:SERVICE|SVC|ORDER|USE)\b|\bNOT\s+(?:AVAILABLE|AVBL|USABLE)\b|\bUNAVAILABLE\b|\bINOPERATIVE\b|\bINOP\b|\bWITHDRAWN\b|\bDECOMMISSIONED\b|\bHORS\s+(?:SERVICE|SVC)\b|\bHORS\s+D'?USAGE\b|\bINDISPONIBLE\b|\bINUTILISABLE\b|\bRETIRE\s+DU\s+SERVICE\b|\bFUERA\s+DE\s+SERVICIO\b|\bNO\s+DISPONIBLE\b|\bINUTILIZABLE\b/;

/** Out-of-service status inferred from the NOTAM free text alone. Restored
 *  phrases win over unserviceable ones. */
export function serviceStatusFromText(eText: string | null | undefined): ServiceStatus {
	if (!eText) {
		return '';
	}
	const t = eText.toUpperCase();
	if (RESTORED_RE.test(t)) {
		return 'restored';
	}
	if (UNSERVICEABLE_RE.test(t)) {
		return 'unserviceable';
	}
	return '';
}

/** Combine the authoritative Q-code condition with the free-text phrases. The
 *  condition wins; the text decides only when the condition is generic. */
export function classifyServiceStatus(
	eText: string | null | undefined,
	qCode: string,
): ServiceStatus {
	if (isUnserviceableCondition(qCode)) {
		return 'unserviceable';
	}
	if (isRestoredCondition(qCode)) {
		return 'restored';
	}
	return serviceStatusFromText(eText);
}
