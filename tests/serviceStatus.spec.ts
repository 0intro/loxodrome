import { describe, it, expect } from 'vitest';
import { parseNotams } from '$lib/notam';
import { isUnserviceableCondition, isRestoredCondition } from '$lib/notam/qcode';
import { serviceStatusFromText, classifyServiceStatus } from '$lib/notam/serviceStatus';

describe('isUnserviceableCondition', () => {
	it('accepts out-of-service conditions', () => {
		expect(isUnserviceableCondition('QNDAS')).toBe(true); // unserviceable
		expect(isUnserviceableCondition('QNVAU')).toBe(true); // not available
		expect(isUnserviceableCondition('QICUI')).toBe(true); // out of service (ops)
		expect(isUnserviceableCondition('QNBAW')).toBe(true); // completely withdrawn
	});

	it('rejects operational / restored / malformed', () => {
		expect(isUnserviceableCondition('QNDAK')).toBe(false); // resumed
		expect(isUnserviceableCondition('QNDAO')).toBe(false); // operational
		expect(isUnserviceableCondition('QNDCE')).toBe(false); // erected, exists
		expect(isUnserviceableCondition('')).toBe(false);
		expect(isUnserviceableCondition('QND')).toBe(false);
	});
});

describe('isRestoredCondition', () => {
	it('accepts back-in-service conditions', () => {
		expect(isRestoredCondition('QNDAK')).toBe(true); // resumed normal ops
		expect(isRestoredCondition('QNDAO')).toBe(true); // operational
		expect(isRestoredCondition('QNDER')).toBe(true); // restored
	});

	it('rejects unserviceable / malformed', () => {
		expect(isRestoredCondition('QNDAS')).toBe(false);
		expect(isRestoredCondition('')).toBe(false);
	});
});

describe('serviceStatusFromText', () => {
	it('detects English out-of-service phrasings', () => {
		expect(serviceStatusFromText("DME 'CGN' CH100Y U/S.")).toBe('unserviceable');
		expect(serviceStatusFromText('VOR UNSERVICEABLE')).toBe('unserviceable');
		expect(serviceStatusFromText('NDB OUT OF SERVICE')).toBe('unserviceable');
		expect(serviceStatusFromText('ILS NOT AVAILABLE')).toBe('unserviceable');
		expect(serviceStatusFromText('TACAN INOP')).toBe('unserviceable');
	});

	it('detects French out-of-service phrasings', () => {
		expect(serviceStatusFromText('VOR/DME HORS SERVICE')).toBe('unserviceable');
		expect(serviceStatusFromText('BALISE INDISPONIBLE')).toBe('unserviceable');
		expect(serviceStatusFromText('RADIOBORNE RETIRE DU SERVICE')).toBe('unserviceable');
	});

	it('detects Spanish out-of-service phrasings', () => {
		expect(serviceStatusFromText('VOR FUERA DE SERVICIO')).toBe('unserviceable');
		expect(serviceStatusFromText('DME NO DISPONIBLE')).toBe('unserviceable');
	});

	it('prefers a restored signal over a recalled outage', () => {
		expect(serviceStatusFromText('VOR BACK IN SERVICE')).toBe('restored');
		expect(serviceStatusFromText('VOR REMIS EN SERVICE')).toBe('restored');
		expect(
			serviceStatusFromText('VOR REMISE EN SERVICE, PRECEDEMMENT HORS SERVICE'),
		).toBe('restored');
	});

	it('returns empty for unrelated / empty text', () => {
		expect(serviceStatusFromText('RWY 27 CLOSED')).toBe('');
		expect(serviceStatusFromText('')).toBe('');
		expect(serviceStatusFromText(null)).toBe('');
	});
});

describe('classifyServiceStatus', () => {
	it('lets the Q-code condition decide with no text', () => {
		expect(classifyServiceStatus(null, 'QNDAS')).toBe('unserviceable');
		expect(classifyServiceStatus(null, 'QNDAK')).toBe('restored');
	});

	it('uses text when the condition is generic', () => {
		expect(classifyServiceStatus('VOR HORS SERVICE', 'QNDXX')).toBe('unserviceable');
		expect(classifyServiceStatus('VOR BACK IN SERVICE', 'QNDXX')).toBe('restored');
		expect(classifyServiceStatus('NOTHING RELEVANT HERE', 'QNDXX')).toBe('');
	});

	it('lets an operational Q-code override a recalled U/S mention', () => {
		expect(classifyServiceStatus('PREVIOUSLY U/S, NOW OK', 'QNDAO')).toBe('restored');
	});
});

describe('parser populates serviceStatus', () => {
	it('flags the QNDAS DME U/S sample as unserviceable', () => {
		const text = `LFFA-Z9999/25
DU: 01 01 2026 00:00 AU: 31 12 2026 23:59
A) LFPG
Q) LFFF / QNDAS / IV / BO / AE / 000/195 / 4901N00230E025
E) DME 'CGN' CH100Y U/S.
`;
		const notams = parseNotams(text);
		expect(notams).toHaveLength(1);
		expect(notams[0].serviceStatus).toBe('unserviceable');
	});
});
