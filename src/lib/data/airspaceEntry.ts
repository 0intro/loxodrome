/* The published entry conditions of a restricted area, read from its AIP
 * remark.
 *
 * ICAO Annex 2 3.1.10 and SERA.3145 word the rule identically: no flight in
 * a published P / R except in accordance with the CONDITIONS OF THE
 * RESTRICTIONS or by State permission. AIP France ENR 5.1 prints those
 * conditions in its "Organisme, conditions de penetration / Operating
 * authority, penetrating conditions" column, and the SIA AIXM export carries
 * that column verbatim (English, `#` line separators) as the airspace remark.
 * This module is the single reading of that text, shared by the live alert
 * evaluator (nav/alertRules.ts) and the route profile's forbidden-crossing
 * tier (route/routeProfile.ts) so the two cannot disagree about what is
 * forbidden.
 *
 * Pure and dependency-free by design: both consumers import it, and it is
 * parsed once at load like the vertical limits. Conservative by construction:
 * anything it cannot read returns null, which every consumer grades as
 * avoidance. */

/** The condition a published clause imposes on entry.
 *  - forbidden: avoidance / prohibition, or entry reserved to a named group
 *    (the app cannot know the reader belongs to it).
 *  - clearance: an authorization, permission or prior-notice gate.
 *  - radio: a positive requirement to establish contact or keep a watch.
 *  - radio-ats: the same, but the clause EXEMPTS aircraft already working an
 *    ATS / A-A frequency (LF-R 324's identification zone). An IFR flight is
 *    always on one, so this is the only radio form that means nothing to it. */
export type EntryCondition = 'forbidden' | 'clearance' | 'radio' | 'radio-ats';

/** Severity order; a clause set grades by its strictest member. */
const RANK: Record<EntryCondition, number> = {
	forbidden: 3,
	clearance: 2,
	radio: 1,
	'radio-ats': 1,
};

/** True when `a` binds at least as strictly as `b` (null = nothing read). */
export function stricter(
	a: EntryCondition | null,
	b: EntryCondition | null,
): EntryCondition | null {
	if (a == null) {
		return b;
	}
	if (b == null) {
		return a;
	}
	return RANK[a] >= RANK[b] ? a : b;
}

/** An avoidance or prohibition clause. Both word orders occur in the SIA
 *  corpus ("avoidance mandatory", "compulsory avoidance", "mandatory
 *  bypassing", "bypassing mandatory"), and a zone "reserved for" a named
 *  group is a prohibition for everyone else: the 33 LF-R 3100 / 3103 rows
 *  reserved to club pilots holding a protocol are not enterable on a
 *  clearance. RESE\w*VED also swallows the corpus's "reseverved" typo. */
const FORBIDDEN_RE =
	/AVOIDANCE (IS )?(MANDATORY|COMPULSORY)|(MANDATORY|COMPULSORY) (AVOIDANCE|BYPASSING)|BYPASSING (IS )?MANDATORY|CONTOURNEMENT OBLIGATOIRE|EVITEMENT OBLIGATOIRE|PENETRATION (PROHIBITED|INTERDITE)|ENTRY (PROHIBITED|FORBIDDEN)|PROHIBITED TO AIRCRAFT|INTERDITE? AUX|\bRESE\w*VED (STRICTLY )?(FOR|TO)\b|\bRESERVEE?S? AUX\b/;
/** An authorization gate: "upon X authorisation", PPR and prior-notice
 *  wording, "upon notification" (LF-R 322 below FL160). */
const CLEARANCE_RE =
	/AUTORISATION|AUTHORI[SZ]|CLEARANCE|CLAIRANCE|SUBORDONNEE|PERMISSION|APPROBATION|APPROVAL|NOTIFICATION|PRIOR NOTICE|PREAVIS|AGREEMENT|\bPPR\b/;
/** A radio / listening-watch requirement. */
const RADIO_RE =
	/RADIO CONTACT|CONTACT RADIO|LISTENING WATCH|VEILLE RADIO|VEILLE OBLIGATOIRE|ECOUTE OBLIGATOIRE|STANDBY OF FREQUENC|MANDATORY .{0,40}(LISTENING|WATCH)/;
/** The LF-R 324 exemption: entry conditioned on a watch EXCEPT for aircraft
 *  already working an A/A, ATS or ATC frequency. */
const RADIO_ATS_EXEMPT_RE =
	/(EXCEPT|UNLESS|SAUF)[^.]{0,160}(\bATS\b|\bATC\b|A\/A|OPERATIONAL FREQUENC|FREQUENCE OPERATIONNELLE)/;
/** A radio phrase in a DESCRIPTIVE construction is not a requirement: TFR 2
 *  reads "avoidance recommended due to the presence of ACFT without any radio
 *  contact nor any transponder onboard", where reading a contact requirement
 *  out of it would tell the pilot to call a frequency the hazard is defined by
 *  not having. */
const RADIO_DESCRIPTIVE_RE = /WITHOUT|DUE TO|PRESENCE OF|NOT EQUIPPED|SANS |EN RAISON|NON EQUIPE/;
/** How far back a descriptive marker still governs the radio phrase. */
const DESCRIPTIVE_WINDOW = 60;

/** Uppercase, accent-free form the patterns run on, horizontal whitespace
 *  collapsed. Line breaks SURVIVE: they are the publication's clause
 *  boundaries, and the parenthesis rule below needs them. */
export function normalizeClause(text: string): string {
	return text
		.normalize('NFD')
		.replace(/\p{Mn}/gu, '')
		.toUpperCase()
		.replace(/[^\S\n]+/g, ' ')
		.trim();
}

/** Parenthesised text qualifies a clause, it is not the clause: LF-R 41's
 *  "entry subject to MADIRAN authorization 129.900 MHz (during activity, ACFT
 *  without radio bypassing mandatory)" imposes a clearance on everyone and
 *  avoidance only on the non-radio aircraft in the parenthesis.
 *  A qualifier never crosses a clause boundary, which is what keeps an
 *  UNBALANCED parenthesis local: LF-R 173 A opens one in its administrator
 *  block ("MARSEILLE ACC (> FL175") and never closes it, and pairing it with
 *  the next ")" three clauses later would swallow the IFR avoidance rule
 *  in between. */
function withoutQualifiers(text: string): string {
	return text.replace(/\([^)#\n]*\)/g, ' ');
}

function radioCondition(text: string): EntryCondition | null {
	const m = RADIO_RE.exec(text);
	if (!m) {
		return null;
	}
	const before = text.slice(Math.max(0, m.index - DESCRIPTIVE_WINDOW), m.index);
	if (RADIO_DESCRIPTIVE_RE.test(before)) {
		return null;
	}
	return RADIO_ATS_EXEMPT_RE.test(text) ? 'radio-ats' : 'radio';
}

/** The condition one clause imposes, avoidance-dominant: several clauses bury
 *  a radio phrase inside an exception, and an alert must grade the strictest
 *  requirement the clause states. Null when nothing here parses. */
export function clauseCondition(raw: string): EntryCondition | null {
	const text = withoutQualifiers(normalizeClause(raw));
	if (!text) {
		return null;
	}
	if (FORBIDDEN_RE.test(text)) {
		return 'forbidden';
	}
	if (CLEARANCE_RE.test(text)) {
		return 'clearance';
	}
	return radioCondition(text);
}

/** The avoidance / prohibition phrase inside a NORMALIZED clause: a caller
 *  splitting subject from condition needs where the phrase starts, not just
 *  whether it is there. */
export function forbiddenMatch(text: string): RegExpExecArray | null {
	return FORBIDDEN_RE.exec(text);
}

/** The whole remark read as one clause: the fallback for a traffic category
 *  the publication does not address separately, and the reading for every
 *  publisher but France (audited: UK / ES / BE / DE / AT / FAA carry no
 *  per-category conditions at all). */
export function remarkCondition(rmk: string): EntryCondition | null {
	return rmk ? clauseCondition(rmk) : null;
}

/** The published conditions of one zone, per traffic category. AIP France
 *  ENR 5.1 states them separately for CAG IFR and CAG VFR (and for the
 *  military CAM, which this app never plans), and ICAO Annex 2 3.1.10 makes
 *  entry lawful "in accordance with the conditions of the restrictions": the
 *  clause addressed to the flight's own category IS its condition.
 *  null = the publication addresses that category with nothing this parser
 *  reads, which every consumer grades as avoidance. */
export interface EntryConditions {
	vfr: EntryCondition | null;
	ifr: EntryCondition | null;
	/** The conditions are permanently in force (H24 / PERMANENT hours).
	 *  Parsed for type R only, and carried on the band as well as the alert
	 *  volume: the route profile has no activation model of its own for H24
	 *  zones, and without this bit it would disagree with the banner about
	 *  LF-R 275 on a day with no NOTAM. */
	permanent: boolean;
}

export const NO_ENTRY: EntryConditions = { vfr: null, ifr: null, permanent: false };

/** The traffic categories a clause head addresses, null when it names none
 *  (which closes the block: "Administrators :", "Activity known on :").
 *  Token PRESENCE decides, never position, because the corpus writes both
 *  orders ("GAT IFR" / "IFR GAT"), every separator (`/`, `-`, `,`, "and"),
 *  the French CAG / CAM, and one row with the labels swapped
 *  ("- OAT VFR/GAT V:"). The military OAT sub-categories stand in for the
 *  flight rules the way the AIP uses them: OAT V flies VFR, OAT I / T /
 *  A, B, C fly IFR. A head naming ONLY OAT / CAM addresses neither civil
 *  category and grades nothing, which is what keeps LF-R 108 C's
 *  "OAT: mandatory bypassing." off its VFR verdict. */
export function subjectProfiles(head: string): { vfr: boolean; ifr: boolean } | null {
	const vfr =
		/\bVFR\b/.test(head) ||
		/(GAT|CAG)\s*VFR/.test(head) ||
		/\bOAT\s*V\b/.test(head) ||
		/\bV\s*OAT\b/.test(head) ||
		/\bCAM\s*V\b/.test(head);
	const ifr =
		/\bIFR\b/.test(head) ||
		/(GAT|CAG)\s*IFR/.test(head) ||
		/\bOAT\b[^.]{0,20}\b[ITABC]\b/.test(head);
	const gat = /\b(GAT|CAG)\b/.test(head) || /(GAT|CAG)\s*[IV]FR/.test(head);
	const oat = /\b(OAT|CAM)\b/.test(head);
	if (!vfr && !ifr && !gat && !oat) {
		return null;
	}
	if (vfr || ifr) {
		return { vfr, ifr };
	}
	// General Air Traffic with no rule qualifier covers both; military-only
	// heads address neither.
	return gat ? { vfr: true, ifr: true } : { vfr: false, ifr: false };
}

/** A clause whose subject is ANOTHER published area: LF-R 205's
 *  "- LF-P 21 BRUYERES LE CHATEL, LF-P 23 PARIS ... : entry prohibited" and
 *  the "Except for LF-R 84A ... when active" geometry subtractions. Only a
 *  designator in SUBJECT position qualifies, so a clause that merely
 *  mentions a neighbour ("avoidance mandatory except for LF-R 84A") keeps
 *  its own grade. */
const ALIEN_SUBJECT_RE = /^(EXCEPT( FOR)?|EXCLUDING)?\s*LF\s?-?\s?[PRD]\s?\d/;
/** A head longer than this is a sentence, not a subject. */
const HEAD_MAX = 90;
/** How far into an unpunctuated line a subject may start (rule R7). */
const LEAD_MAX = 40;
const BULLET_RE = /^([-–—*•]|\d+\s*[-.)])\s*/;

function add(
	acc: { vfr: EntryCondition | null; ifr: EntryCondition | null },
	on: { vfr: boolean; ifr: boolean },
	cond: EntryCondition | null,
): void {
	if (cond == null) {
		return;
	}
	if (on.vfr) {
		acc.vfr = stricter(acc.vfr, cond);
	}
	if (on.ifr) {
		acc.ifr = stricter(acc.ifr, cond);
	}
}

/** The published entry conditions, read per traffic category.
 *
 * The remark is a list of clauses, one per category, sometimes with the
 * subject on its own line and the condition below it, and always with the
 * exemptions bulleted underneath. So: a line whose head names a category
 * OPENS a block, one whose head names something else CLOSES it, and anything
 * else CONTINUES the open one. Within a category the STRICTEST clause grades,
 * which is what makes the exemption bullets safe (an exemption can only add a
 * weaker grade, never soften its own header) and what keeps LF-R 205's
 * "- Other IFR GAT flights: Compulsory avoidance" dominating the permissive
 * clause above it.
 *
 * A category with no clause of its own falls back to the whole remark read as
 * one, which is today's reading and every other publisher's: the per-category
 * verdict can only differ where the publication explicitly addresses that
 * category. */
export function parseEntryConditions(rmk: string, workHr: string): EntryConditions {
	const permanent = permanentHours(workHr);
	if (!rmk) {
		return { vfr: null, ifr: null, permanent };
	}
	const acc: { vfr: EntryCondition | null; ifr: EntryCondition | null } = {
		vfr: null,
		ifr: null,
	};
	let block: { vfr: boolean; ifr: boolean } | null = null;
	// `\\` separates the FR / EN halves of a bilingual remark; both state the
	// same conditions, and the strictest-wins fold makes reading both idempotent.
	for (const raw of rmk.split(/\\\\|[#\n]/)) {
		const line = normalizeClause(raw);
		if (!line) {
			continue;
		}
		const bulleted = BULLET_RE.test(line);
		const body = line.replace(BULLET_RE, '');
		const colon = body.indexOf(':');
		const head = colon >= 0 ? body.slice(0, colon) : body;
		if (ALIEN_SUBJECT_RE.test(head)) {
			block = null;
			continue;
		}
		if (colon >= 0) {
			const subject = head.length <= HEAD_MAX ? subjectProfiles(head) : null;
			if (subject) {
				block = subject;
				add(acc, block, clauseCondition(body.slice(colon + 1)));
				continue;
			}
			// A heading of its own ("Entry conditions:", "Activity known on :")
			// ends the previous category's clause; a bulleted line is an
			// exemption inside it and must not.
			if (!bulleted) {
				block = null;
			}
			if (block) {
				add(acc, block, clauseCondition(body));
			}
			continue;
		}
		// An unpunctuated line may still carry its own subject
		// ("IFR/VFR/OAT Avoidance mandatory during activity"); a bulleted one
		// never does, it is an exemption of the block above.
		if (!bulleted) {
			const lead = subjectProfiles(body.slice(0, LEAD_MAX));
			const cond = lead && (lead.vfr || lead.ifr) ? clauseCondition(body) : null;
			if (lead && cond) {
				add(acc, lead, cond);
				continue;
			}
		}
		if (block) {
			add(acc, block, clauseCondition(body));
		}
	}
	const whole = remarkCondition(rmk);
	return { vfr: acc.vfr ?? whole, ifr: acc.ifr ?? whole, permanent };
}

/** THE reading of a zone's entry requirement for one flight, shared by the
 *  live alert tier (nav/alertRules.ts) and the route profile's
 *  forbidden-crossing set (route/routeProfile.ts) so the banner and the
 *  briefing cannot disagree. Null means the zone asks nothing of this flight
 *  right now. */
export function zoneEntryAction(
	zone: { type: string; rtba: boolean; entry: EntryConditions },
	opts: { vfr: boolean; active: boolean },
): EntryCondition | null {
	if (!opts.active && !zone.entry.permanent) {
		return null;
	}
	// RTBA is do-not-enter by doctrine (SIA ENR 5.1: no clearance exists
	// during an AZBA window), and a segregated TSA / TFR reserves the volume
	// for its user; neither publishes a per-category condition to read.
	if (zone.rtba || zone.type !== 'R') {
		return 'forbidden';
	}
	return (opts.vfr ? zone.entry.vfr : zone.entry.ifr) ?? 'forbidden';
}

/** Permanently in force: the requirement holds whenever the volume exists.
 *  The negation guard is load-bearing, NATS publishes "Not permanently
 *  active. ... Activated by NOTAM." and reading permanence out of that would
 *  make a NOTAM-activated area always hot. */
export function permanentHours(workHr: string): boolean {
	const w = normalizeClause(workHr);
	if (/\bNOT PERMANENT/.test(w)) {
		return false;
	}
	return w === 'H24' || w.includes('PERMANENT');
}
