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
//
// The French NON DISPONIBLE is spelled out beside the Spanish NO DISPONIBLE
// rather than folded into it: `\bNO\s+` cannot reach across the N of NON, so
// for want of three letters "AVGAS NON DISPONIBLE" classified in English and
// not in French (D3065/26 LFKO), which is the one thing an extractor here may
// not do. The plural is the Goma form, "SERVICES ... NON DISPONIBLES".
//
// INDISPONIBLE and INUTILISABLE carry it for the same reason. French agrees
// the adjective with its subject and the SIA writes plenty of plural ones,
// "POSTES DE STATIONNEMENT PO-14 A PO-16 INDISPONIBLES" (D3226/26) against
// the English half's "STANDS PO-14 TO PO-16 NOT AVBL"; three France pairs of
// the 2026-06-10 fixtures classified in English and not in French for want of
// one letter, and one of the three withdraws a FIS service, which this status
// is the tier gate for (notam/serviceClosure.ts).
const UNSERVICEABLE_RE =
	/\bU\s*\/\s*S\b|\bUNSERVICEABLE\b|\bUNUSABLE\b|\bOUT\s+OF\s+(?:SERVICE|SVC|ORDER|USE)\b|\bNOT\s+(?:AVAILABLE|AVBL|USABLE)\b|\bUNAVAILABLE\b|\bINOPERATIVE\b|\bINOP\b|\bWITHDRAWN\b|\bDECOMMISSIONED\b|\bHORS\s+(?:SERVICE|SVC)\b|\bHORS\s+D'?USAGE\b|\bINDISPONIBLES?\b|\bINUTILISABLES?\b|\bRETIRE\s+DU\s+SERVICE\b|\bFUERA\s+DE\s+SERVICIO\b|\bNONS?\s+DISPONIBLES?\b|\bNO\s+DISPONIBLE\b|\bINUTILIZABLE\b/;

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
