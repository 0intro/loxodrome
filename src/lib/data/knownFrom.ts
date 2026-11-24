/* Who knows a zone's real activity, as its publication names them: LF-R
 * 174's remark "Activity known on BASEL INFO 130.9 MHz", LF-R 505's "Actual
 * activity known on : - OCHEY APP, - STRASBOURG INFO, - LORRAINE TWR.", LF-R
 * 3101 A's "Activité connue de : ORLY APP", and a NOTAM's "ACTIVITE REELLE
 * CONNUE DE LILLE INFO 132.540MHZ" or "ACTUAL TIMES OF ACTIVITY ANNOUNCED ON
 * 'LILLE INFO' 132.540MHZ" (R0564/26).
 *
 * The list after those words is read item by item, an aside in
 * parentheses ending one ("VANNES INFO (ATS SKED)", LF-R 220 A's "GRENOBLE
 * TWR (BLW or = 3500ft AMSL) LYON INFO"). A unit is an item of a
 * few words naming a service (APP, INFO, TWR, ACC, RAI ...) or printing a
 * frequency, which it keeps when a light aircraft can set it, 118 to 137
 * MHz ("AVORD APP or RAI 119.7" is two units). An item printing a
 * telephone is a unit known by telephone, named by its own words or the
 * short item before it ("Beynes camp duty office. TEL : +33(0)1 34 91 21
 * 64", LF-R 28). Another short item is passed over (LF-R 39's
 * "CARCASSONNE"), and the list ends at the first longer one, or at words
 * opening a list of their own (LF-R 95 A's "Actual activity known on LE LUC
 * APP", read in its turn). Pure. */

import { formatFreqMHz } from '$lib/format/radio';

export interface KnownUnit {
	/** "BASEL INFO", "AVORD APP", "RAI", "BEYNES CAMP DUTY OFFICE". */
	unit: string;
	/** "130.900", null where the text prints none. */
	freq: string | null;
	/** "+33 1 34 91 21 64" for a unit known by telephone, else null. */
	phone: string | null;
}

/** The words that open the list, in the AIP's English and French and the
 *  NOTAMs' capitals. */
const LEAD_RE =
	/\b(?:(?:(?:ACTUAL |REAL )?(?:ACTIVITY|ACT|TIMES OF ACTIVITY) )?(?:KNOWN|ANNOUNCED|NOTIFIED) (?:ON|FROM|BY|OF)|ACTIVITE (?:REELLE )?(?:CONNUE|ANNONCEE) (?:DE|SUR|PAR)|ANNONCEE SUR)\b\s*:?/g;
/** A service a unit is named by. */
const SERVICE_RE =
	/\b(?:APP|APPROACH|APPROCHE|INFO|INFORMATION|TWR|TOUR|TOWER|ACC|UAC|FIC|FIS|SIV|CONTROL|CONTROLE|RADAR|AFIS|ATIS|RAI|CDC|CCMAR)\b/;
/** A frequency, "130.9", "119.700 MHz", "135,15", "317.5 MHz". */
const FREQ_RE = /\b(\d{3})[.,](\d{1,3})\s*(?:MHZ)?\b/;
/** The civil VHF band, MHz. */
const VHF_LOW = 118;
const VHF_HIGH = 137;
const PHONE_RE = /(?:\+\s?33\s?|\b0)[1-9](?:[\s.]?\d\d){4}\b/;
/** The items a list is cut into: commas between words (never inside
 *  "135,15"), list marks, "or", "and", sentence ends. */
const ITEM_RE = /\s*(?:,(?!\d)|[;#|\n\\]|\s-\s|^-\s|\bOR\b|\bOU\b|\bAND\b|\bET\b|\.(?=\s|$))\s*/;
const SHORT_WORDS = 4;
const UNIT_WORDS = 5;

/** The units a text names as knowing, or announcing, a zone's real
 *  activity, in the order it names them, each once. */
export function knownFrom(text: string): KnownUnit[] {
	const s = fold(text);
	const out: KnownUnit[] = [];
	const seen = new Set<string>();
	const add = (u: KnownUnit): void => {
		if (u.unit !== '' && !seen.has(u.unit)) {
			seen.add(u.unit);
			out.push(u);
		}
	};
	for (const lead of s.matchAll(LEAD_RE)) {
		let owner = '';
		const tail = s
			.slice((lead.index ?? 0) + lead[0].length)
			.replace(/\+\s?33\s?\(0\)\s?/g, '+33 ')
			.replace(/\(([A-Z]+)\)/g, ' $1')
			.replace(/\s*\([^)]*\)?\s*/g, ' # ');
		for (const item of tail.split(ITEM_RE)) {
			const t = item.replace(/^[-\s:]+|[\s:.]+$/g, '').replace(/['"]/g, '').trim();
			if (t === '') {
				continue;
			}
			if (t.search(LEAD_RE) >= 0) {
				break;
			}
			const phone = PHONE_RE.exec(t);
			if (phone) {
				const own = t.slice(0, phone.index).replace(/\b(?:TEL|PHONE|TELEPHONE)\b|[:\s]+$/g, ' ').trim();
				add({ unit: own || owner, freq: null, phone: phone[0].replace(/\s+/g, ' ') });
				owner = '';
				continue;
			}
			const f = FREQ_RE.exec(t);
			const name = (f ? t.slice(0, f.index) : t).replace(/[\s:]+$/, '').replace(/\s+(?:ON|SUR|FREQ(?:UENCY)?)$/, '').trim();
			// Words after a colon are a sentence, a frequency the unit's own.
			const sentence = /:/.test(name) || name.split(' ').length > UNIT_WORDS;
			if ((f || SERVICE_RE.test(t)) && !sentence) {
				const mhz = f ? Number(f[1]) : 0;
				const vhf = f !== null && mhz >= VHF_LOW && mhz < VHF_HIGH;
				add({ unit: name || 'RAI', freq: vhf ? `${f[1]}.${f[2].padEnd(3, '0')}` : null, phone: null });
				owner = '';
				continue;
			}
			if (t.split(' ').length > SHORT_WORDS || /:/.test(t)) {
				break;
			}
			owner = t;
		}
	}
	return out;
}

/** A channel a unit is matched against: a band contact's radio. */
export interface KnownChannel {
	freq: string;
	unit: string;
	call: string;
}

/** The unit an alert names among those that know a zone's activity, in
 *  order: the one on the channel the band has set (`current`), the RAI, the
 *  one on the next contact's channel, the first named with a radio. A unit
 *  matches a channel by its frequency or its name, and one printed with no
 *  frequency takes its channel's. `phone` where the text names a telephone
 *  alone, null where it names nobody. */
export function whoKnows(
	units: readonly KnownUnit[],
	current: readonly KnownChannel[],
	next: readonly KnownChannel[],
): { unit: string; freq: string | null } | 'phone' | null {
	const radio = units.filter((k) => k.phone === null);
	const on = (chans: readonly KnownChannel[]): { unit: string; freq: string | null } | null => {
		for (const k of radio) {
			const c = chans.find(
				(ch) =>
					(k.freq !== null && k.freq === formatFreqMHz(ch.freq)) ||
					sameUnit(k.unit, ch.call) ||
					sameUnit(k.unit, ch.unit),
			);
			if (c) {
				return { unit: k.unit, freq: k.freq ?? formatFreqMHz(c.freq) };
			}
		}
		return null;
	};
	const rai = radio.find((k) => k.unit === 'RAI' && k.freq !== null);
	const first = radio[0];
	return (
		on(current) ??
		(rai ? { unit: rai.unit, freq: rai.freq } : null) ??
		on(next) ??
		(first ? { unit: first.unit, freq: first.freq } : null) ??
		(units.length > 0 ? 'phone' : null)
	);
}

/** Do two unit names name one station: "SEINE INFO", "Seine Information". */
function sameUnit(a: string, b: string): boolean {
	const key = (s: string) =>
		fold(s)
			.replace(/\bINFORMATION\b/g, 'INFO')
			.replace(/[^A-Z0-9]+/g, ' ')
			.trim();
	return b.trim() !== '' && key(a) === key(b);
}

/** Upper case, accents off, spaces made one: the AIP's mixed case and the
 *  NOTAMs' capitals read alike. */
function fold(s: string): string {
	return s
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[‘’]/g, "'")
		.toUpperCase()
		.replace(/[ \t]+/g, ' ');
}

/** The unit to ask about a zone's activity, as text, with no channel set:
 *  whoKnows's choice with its frequency, or the first telephone where the
 *  zone names one alone. Null where it names nobody. Locale-invariant: a
 *  unit's name and its figures. */
export function askUnitText(known: readonly KnownUnit[]): string | null {
	const k = whoKnows(known, [], []);
	if (k === 'phone') {
		const p = known.find((u) => u.phone !== null);
		return p ? `${p.unit} ${p.phone}` : null;
	}
	return k ? (k.freq ? `${k.unit} ${k.freq}` : k.unit) : null;
}
