import { describe, it, expect, beforeEach } from 'vitest';
import { parseNotams } from '$lib/notam';
import { notamState } from '$lib/state/notam.svelte';
import {
	isActiveTrigger,
	isTriggeredFramework,
	notamTriggers,
	notamTriggeredBy,
} from '$lib/state/notamLinks.svelte';

// Real pairs from /home/djc/tmp/france.txt. Both ends cite the SAME
// AIP SUP number in their body; that's the bridge (the framework
// describes what the SUP creates in prose; the activation cites the
// SUP inline when it activates a specific zone the SUP defines).

// Pair 1: SUP 167/25 (Nancy Ochey ZRT). Framework + activation.
const FRAMEWORK_167 = `R2166/25
Q) LFEE/QRTTT/IV/BO/AW/000/036/4835N00557E011
A) LFSO
B) 2509290533 C) 2612311550
E) TRIGGER NOTAM - AIP SUP 167/25 : ARRIVALS, DEPARTURES AND PLATFORM
TRAINING REQUIRING THE CREATION OF A TEMPORARY RESTRICTED AREA ON
NANCY OCHEY AD.
F) SFC
G) 3600FT AMSL
`;
const ACTIVATION_167 = `R0916/26
Q) LFEE/QRTCA/IV/BO/AW/000/075/4835N00557E007
A) LFSO
B) 2603300518 C) 2609301718
E) TEMPO RESTRICTED AREA (ZRT) 'COUTEAU DELTA' ON NANCY OCHEY AD :
ZRT, WHEN ACT, REPLACES OVERLAPPING AIRSPACES.
ZRT OCHEY (AIP SUP 167/25).
F) SFC
G) FL075
`;

// Pair 2: SUP 93/26 (Lourdes ZRT). The activation cites the SUP
// explicitly in its E-section (very direct example).
const FRAMEWORK_93 = `R1420/26
Q) LFBB/QRTTT/IV/BO/AW/000/055/4305N00003W005
A) LFBT
B) 2605220000 C) 2610102359
E) TRIGGER NOTAM - AIP SUP 093/26.
CREATION OF A TEMPORARY RESTRICTED AREA AROUND 'LOURDES' ('ZRT
LOURDES') FOR PROTECTING THE SANCTUARY.
F) SFC
G) 5500FT AMSL
`;
const ACTIVATION_93 = `R1484/26
Q) LFBB/QRTCA/IV/BO/AW/000/055/4305N00003W005
A) LFBT
B) 2605220000 C) 2605242359
E) AIP SUP 093/26 : 'ZRT LOURDES' ACT
F) SFC
G) 5500FT AMSL
`;

// Activation for an unrelated SUP; should not pair with FRAMEWORK_167
// or FRAMEWORK_93.
const ACTIVATION_OTHER = `R1554/26
Q) LFFF/QRRCA/IV/BO/AW/000/025/4712N00032E007
A) LFOJ
B) 2605260600 C) 2605292159
E) AIP SUP 999/26 : 'OTHER ZONE' ACTIVATED.
F) SFC
G) 2500FT AMSL
`;

// Obstacle-subject TRIGGER NOTAM. Cites a real SUP but qCode subject
// is OB; hasRestrictedAreaSubject rejects, so it's not a framework
// candidate for the bridge.
const NON_AIRSPACE_TRIGGER = `D9999/26
Q) LFFF/QOBTT/IV/M/A/000/005/4900N00210E001
A) LFFF B) 2601010000 C) PERM
E) TRIGGER NOTAM - AIP SUP 093/26.
NEW OBSTACLE TO BE CHARTED.
F) SFC
G) 200FT AGL
`;

// Activation NOTAM without any AIP SUP citation in its body. Real
// example pattern: the activator just names the airspace, leaving
// the SUP link implicit. The bridge cannot fire for these.
const ACTIVATION_NO_SUP = `R1441/26
Q) LFFF/QRRCA/IV/BO/AW/000/050/4811N00138E004
A) LFOJ B) 2605180600 C) 2605292000
E) LF-R119A BOUARD AREA : ACTIVATED.
F) SFC
G) 5000FT AMSL
`;

function seed(...texts: string[]): void {
	notamState.notams = texts.flatMap((t) => parseNotams(t));
	notamState.parsedAt = Date.now();
}

beforeEach(() => {
	notamState.notams = [];
	notamState.parsedAt = 0;
});

describe('isActiveTrigger', () => {
	it('flags an activation that cites an AIP SUP', () => {
		const [n] = parseNotams(ACTIVATION_93);
		expect(isActiveTrigger(n)).toBe(true);
	});

	it('flags an activation that names an airspace id', () => {
		const [n] = parseNotams(ACTIVATION_NO_SUP);
		// R1441/26 has no SUP citation but names LF-R119A; the body-id
		// gate accepts either side.
		expect(isActiveTrigger(n)).toBe(true);
	});

	it('rejects a framework NOTAM (qCode condition is TT, not CA/GA/...)', () => {
		const [n] = parseNotams(FRAMEWORK_93);
		expect(isActiveTrigger(n)).toBe(false);
	});

	it('rejects an activation qCode whose body names nothing concrete', () => {
		const text = `R0000/26
Q) LFFF/QRRCA/IV/BO/AW/000/050/4811N00138E004
A) LFOJ B) 2605180600 C) 2605292000
E) AREA ACTIVATED FOR MILITARY EXERCISE.
F) SFC
G) 5000FT AMSL
`;
		const [n] = parseNotams(text);
		expect(isActiveTrigger(n)).toBe(false);
	});

	it('rejects an obstacle NOTAM even if it cites an AIP SUP', () => {
		// Q-code subject is OB; isActivationQCode rejects it before the
		// body gate runs.
		const [n] = parseNotams(NON_AIRSPACE_TRIGGER);
		expect(isActiveTrigger(n)).toBe(false);
	});
});

describe('isTriggeredFramework', () => {
	it('accepts a "TRIGGER NOTAM" body with restricted-area qCode (QRTTT)', () => {
		const [n] = parseNotams(FRAMEWORK_167);
		expect(isTriggeredFramework(n)).toBe(true);
	});

	it('rejects a TRIGGER NOTAM whose qCode subject is obstacle', () => {
		const [n] = parseNotams(NON_AIRSPACE_TRIGGER);
		expect(isTriggeredFramework(n)).toBe(false);
	});

	it('rejects an activation NOTAM (QR_CA + no TRIGGER body keyword)', () => {
		const [n] = parseNotams(ACTIVATION_167);
		expect(isTriggeredFramework(n)).toBe(false);
	});
});

describe('notamTriggeredBy (SUP-number bridge)', () => {
	it('pairs Lourdes framework with the matching activation by AIP SUP 93/26', () => {
		seed(FRAMEWORK_93, ACTIVATION_93, ACTIVATION_OTHER);
		const [framework] = parseNotams(FRAMEWORK_93);
		const result = notamTriggeredBy(framework);
		expect(result.map((it) => it.notam.id)).toEqual(['R1484/26']);
	});

	it('pairs Nancy Ochey framework via "AIP SUP 167/25" cited in the body', () => {
		seed(FRAMEWORK_167, ACTIVATION_167, ACTIVATION_OTHER);
		const [framework] = parseNotams(FRAMEWORK_167);
		const result = notamTriggeredBy(framework);
		expect(result.map((it) => it.notam.id)).toEqual(['R0916/26']);
	});

	it('returns [] for a non-framework NOTAM', () => {
		seed(FRAMEWORK_93, ACTIVATION_93);
		const [activation] = parseNotams(ACTIVATION_93);
		expect(notamTriggeredBy(activation)).toEqual([]);
	});

	it('returns [] when no activation cites the framework\'s SUP', () => {
		seed(FRAMEWORK_93, ACTIVATION_OTHER);
		const [framework] = parseNotams(FRAMEWORK_93);
		expect(notamTriggeredBy(framework)).toEqual([]);
	});

	it('returns [] when an activation has no SUP citation (real R1441/26 case)', () => {
		// R1441/26 activates LF-R119A but doesn't cite any AIP SUP;
		// without a SUP key on the activation side the bridge cannot fire.
		seed(FRAMEWORK_93, ACTIVATION_NO_SUP);
		const [framework] = parseNotams(FRAMEWORK_93);
		expect(notamTriggeredBy(framework)).toEqual([]);
	});
});

describe('notamTriggers (SUP-number bridge)', () => {
	it('an activation returns the framework that cites the same SUP', () => {
		seed(FRAMEWORK_93, ACTIVATION_93);
		const [activation] = parseNotams(ACTIVATION_93);
		const result = notamTriggers(activation);
		expect(result.map((it) => it.notam.id)).toEqual(['R1420/26']);
	});

	it('returns [] for a framework NOTAM (gated by isActivationQCode)', () => {
		seed(FRAMEWORK_93, ACTIVATION_93);
		const [framework] = parseNotams(FRAMEWORK_93);
		expect(notamTriggers(framework)).toEqual([]);
	});

	it('returns [] when no framework cites the activation SUP', () => {
		seed(ACTIVATION_93); // framework not loaded
		const [activation] = parseNotams(ACTIVATION_93);
		expect(notamTriggers(activation)).toEqual([]);
	});

	it('skips obstacle-subject TRIGGER NOTAMs even when SUP numbers match', () => {
		seed(NON_AIRSPACE_TRIGGER, ACTIVATION_93);
		const [activation] = parseNotams(ACTIVATION_93);
		expect(notamTriggers(activation)).toEqual([]);
	});
});

describe('symmetry', () => {
	it('framework -> activation and activation -> framework agree', () => {
		seed(FRAMEWORK_93, ACTIVATION_93, ACTIVATION_OTHER);
		const [framework] = parseNotams(FRAMEWORK_93);
		const [activation] = parseNotams(ACTIVATION_93);
		const fwdIds = notamTriggeredBy(framework).map((it) => it.notam.id);
		const backIds = notamTriggers(activation).map((it) => it.notam.id);
		expect(fwdIds).toEqual(['R1484/26']);
		expect(backIds).toEqual(['R1420/26']);
	});
});
