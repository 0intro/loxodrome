/* Shared formatting for COM radio frequencies (airport + airspace). The single
 * chokepoint for "always three decimals everywhere": every frequency the SPA
 * shows passes through formatFreqMHz. */

/** Minimal structural shape shared by AirportRadio and AirspaceRadio. */
export interface Radio {
	freq: string;
	unit: string;
	call: string;
}

/** Display order for service labels: tower / ground / delivery first, then
 *  info services, then approach / area, then the rest. Used to sort both the
 *  airport panel rows and the coalesced nav-log labels. Tunable; labels not
 *  listed sort last (in first-seen order). */
const LABEL_RANK: Record<string, number> = {
	TWR: 0,
	GND: 1,
	DEL: 2,
	ATIS: 3,
	AFIS: 4,
	'A/A': 5,
	APP: 6,
	DEP: 7,
	ARR: 8,
	ACS: 9,
	FIS: 10,
	INFO: 11,
	GONIO: 12,
};

function rank(label: string): number {
	const r = LABEL_RANK[label.toUpperCase()];
	return r === undefined ? 99 : r;
}

/** Format a published MHz string to exactly three decimals (the 8.33 kHz
 *  channel resolution): "119.3" -> "119.300", "123" -> "123.000". Returns the
 *  trimmed input unchanged when it isn't a finite number. */
export function formatFreqMHz(freq: string): string {
	const s = freq.trim();
	const v = Number(s);
	if (s === '' || !Number.isFinite(v)) {
		return s;
	}
	return v.toFixed(3);
}

/** Stable copy of `radios` sorted by canonical service order. */
export function sortRadios<T extends Radio>(radios: readonly T[]): T[] {
	return radios
		.map((r, i) => ({ r, i }))
		.sort((a, b) => rank(a.r.unit) - rank(b.r.unit) || a.i - b.i)
		.map((x) => x.r);
}

/** Group radios by frequency value, joining the distinct service labels with
 *  " / ": [TWR 121.1, A/A 121.1] -> [{label:"TWR / A/A", freq:"121.100"}].
 *  Groups and within-group labels follow the canonical order. Used by the
 *  airport panel summary and the nav-log report cell. */
export function coalesceRadios(radios: readonly Radio[]): { label: string; freq: string }[] {
	const order: string[] = [];
	const byFreq = new Map<string, string[]>();
	for (const r of sortRadios(radios)) {
		const freq = formatFreqMHz(r.freq);
		const unit = r.unit.trim();
		if (!freq || !unit) {
			continue;
		}
		let labels = byFreq.get(freq);
		if (!labels) {
			labels = [];
			byFreq.set(freq, labels);
			order.push(freq);
		}
		if (!labels.includes(unit)) {
			labels.push(unit);
		}
	}
	return order.map((freq) => ({ label: byFreq.get(freq)!.join(' / '), freq }));
}

/** General radio coalescing, both directions at once: several stations on one
 *  frequency are shown together ("TWR / AFIS / A/A: 118.200"), and one station on
 *  several frequencies has them joined ("TWR: 118.200 / 120.700"). `label` picks
 *  each radio's station name and is the one knob that makes this reusable: the
 *  airport cell keys off the service `unit` (TWR / APP / ...), the airspace radio
 *  schedule off the `call` sign (SEINE - APPROCHE). Frequencies are 3-dp; labels
 *  follow the canonical service order. */
export function coalesceRadioLines(
	radios: readonly Radio[],
	label: (r: Radio) => string = (r) => r.unit,
): { label: string; freq: string }[] {
	// 1. group by frequency, joining the distinct station labels that share it.
	const freqOrder: string[] = [];
	const labelsByFreq = new Map<string, string[]>();
	for (const r of sortRadios(radios)) {
		const freq = formatFreqMHz(r.freq);
		const name = label(r).trim();
		if (!freq || !name) {
			continue;
		}
		let names = labelsByFreq.get(freq);
		if (!names) {
			names = [];
			labelsByFreq.set(freq, names);
			freqOrder.push(freq);
		}
		if (!names.includes(name)) {
			names.push(name);
		}
	}
	// 2. group those frequencies by their joined station label, joining the freqs.
	const labelOrder: string[] = [];
	const freqsByLabel = new Map<string, string[]>();
	for (const freq of freqOrder) {
		const lab = labelsByFreq.get(freq)!.join(' / ');
		let freqs = freqsByLabel.get(lab);
		if (!freqs) {
			freqs = [];
			freqsByLabel.set(lab, freqs);
			labelOrder.push(lab);
		}
		if (!freqs.includes(freq)) {
			freqs.push(freq);
		}
	}
	return labelOrder.map((lab) => ({ label: lab, freq: freqsByLabel.get(lab)!.join(' / ') }));
}

/** One-line "label: freq" summary via coalesceRadioLines, entries joined with
 *  " · ": "TWR / A/A: 118.200 · APP: 134.875 / 118.050". Used by the nav-log
 *  radio schedule. `label` as in coalesceRadioLines. */
export function radioSummary(radios: readonly Radio[], label?: (r: Radio) => string): string {
	return coalesceRadioLines(radios, label)
		.map((e) => `${e.label}: ${e.freq}`)
		.join(' · ');
}

/** The civil VHF airband: the channels a light aircraft can tune. Published
 *  lines also carry military UHF and, at a few fields, VHF-low. */
const VHF_MIN_MHZ = 118;
const VHF_MAX_MHZ = 137;
/** Guarded by every tower and approach, worked by none, so it is never the
 *  channel to offer while the same unit publishes a working one. */
const GUARD_FREQS = new Set(['121.500', '243.000']);
/** Services a pilot listens to rather than calls. A field publishing one of
 *  these alongside something callable must still be shown the callable one as
 *  the frequency to set, which the canonical LABEL_RANK order does not give
 *  (it leads with the tower, then puts ATIS above AFIS and A/A). */
const LISTEN_ONLY = new Set(['ATIS', 'VOLMET', 'AWOS', 'ASOS']);

/** One coalesced service line reduced to the single channel to display. */
export interface ContactLine {
	/** "TWR", "AFIS / A/A", "SEINE - APPROCHE". */
	label: string;
	/** The one channel to set. */
	freq: string;
	/** Every channel published under this label, " / "-joined; equals `freq`
	 *  when there is only one. */
	all: string;
	/** The frequency a visible NOTAM moved this line off, when one did. */
	was?: string;
}

/** The channel to display for a line published on several. A unit on many
 *  channels is more than twice as wide as one, so a surface that shows a
 *  single frequency has to choose: the first channel in the civil VHF band
 *  that is not the emergency frequency, else the first VHF one, else the
 *  first published (a UHF-only line has nothing better to say). Without the
 *  band test a military field offers its UHF channel, and LFBY's tower reads
 *  40.800; without the guard test Luxembourg's reads 121.500. */
export function preferredChannel(joined: string): string {
	const freqs = joined.split(' / ');
	const vhf = freqs.filter((f) => {
		const v = Number(f);
		return Number.isFinite(v) && v >= VHF_MIN_MHZ && v < VHF_MAX_MHZ;
	});
	return vhf.find((f) => !GUARD_FREQS.has(f)) ?? vhf[0] ?? freqs[0];
}

/** The entries of a published radio list a light aircraft can actually work:
 *  the civil VHF airband, guard excluded. Unchanged when nothing survives, so a
 *  unit that publishes only UHF still says what it publishes rather than
 *  falling silent (which would also drop it from the surfaces that ask whether
 *  an airspace has a frequency at all).
 *
 *  For the surfaces that answer "what do I set on this leg": the nav log's
 *  enroute lines and the radio/airspace schedule, beside narrowToRai. The
 *  detail panels keep the AIP's own table, UHF and all. */
export function workableRadios<R extends { freq: string }>(radio: readonly R[]): R[] {
	const kept = radio.filter((r) => {
		const f = formatFreqMHz(r.freq);
		const v = Number(f);
		return Number.isFinite(v) && v >= VHF_MIN_MHZ && v < VHF_MAX_MHZ && !GUARD_FREQS.has(f);
	});
	return kept.length > 0 ? kept : [...radio];
}

/** Whether a coalesced label names only services you listen to. A slash-joined
 *  label ("AFIS / A/A") is callable as soon as one of its services is. */
function listenOnly(label: string): boolean {
	return label.split(' / ').every((u) => LISTEN_ONLY.has(u.trim().toUpperCase()));
}

/** A published set with the emergency frequencies taken out, empty when that is
 *  all it held. Guard is not an alternative to the channel a line offers: it is
 *  the one channel a pilot must not work. */
function withoutGuard(joined: string): string {
	return joined
		.split(' / ')
		.filter((f) => !GUARD_FREQS.has(f))
		.join(' / ');
}

/** An aerodrome's or an airspace's voice services, each reduced to the one
 *  channel to set, with the line to CALL first.
 *
 *  For an aerodrome the label is the service code and the callable line leads:
 *  the canonical order is a directory order, right for a listing and wrong for
 *  "the frequency to set", so a field publishing ATIS and AFIS would otherwise
 *  offer the ATIS. When nothing is callable the order stands, since a field
 *  that publishes only an ATIS still has that and nothing else.
 *
 *  For an airspace the label is the call sign and the order is left alone: the
 *  units are station names, unknown to LABEL_RANK and all ranked equal, so
 *  there is no callable/listen distinction to make.
 *
 *  Guard never survives here. Coalescing groups by FREQUENCY first, so a field
 *  publishing 243.000 under both its tower and its approach (Villacoublay,
 *  Solenzara, Saint-Dizier, Luxeuil, Hyères) gives that channel a "TWR / APP"
 *  label of its own with nothing else on it, and preferredChannel has nothing
 *  to prefer: the in-flight readout offered the military emergency frequency as
 *  a channel to set. Dropping guard from the line before the choice removes it
 *  from what a line offers as well; a line that held nothing else goes with it.
 *  A field publishing only guard is then a field with no contact line, which is
 *  the truth. */
export function contactLines(
	radios: readonly (Radio & { override?: { was: string }; closed?: boolean })[],
	kind: 'airspace' | 'aerodrome',
): ContactLine[] {
	// A frequency a service-closure NOTAM withdrew is not a channel to offer:
	// on a mixed unit (one row closed, another open) the open rows carry the
	// answer, and a unit whose every row is closed has no contact line, which
	// is the truth (its contact SPAN is gone too, buildContactSpans).
	radios = radios.filter((r) => !r.closed);
	const label = kind === 'airspace' ? (r: Radio): string => r.call || r.unit : undefined;
	// The prior frequency by label, so a coalesced line can say what a NOTAM
	// moved it off. Read from the rows, which carry the override the panels show.
	const wasByLabel = new Map<string, string>();
	for (const r of radios) {
		const name = (label ? label(r) : r.unit).trim();
		if (r.override && name && !wasByLabel.has(name)) {
			wasByLabel.set(name, r.override.was);
		}
	}
	const lines: ContactLine[] = coalesceRadioLines(radios, label).flatMap((l) => {
		const all = withoutGuard(l.freq);
		if (!all) {
			return [];
		}
		const was = l.label.split(' / ').map((u) => wasByLabel.get(u.trim())).find((w) => w != null);
		return [{ label: l.label, freq: preferredChannel(all), all, ...(was ? { was } : {}) }];
	});
	if (kind === 'aerodrome') {
		const call = lines.findIndex((l) => !listenOnly(l.label));
		if (call > 0) {
			lines.unshift(...lines.splice(call, 1));
		}
	}
	return lines;
}
