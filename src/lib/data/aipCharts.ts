/* The chart indexes cmd/eaip writes for the States whose AIP is a
 * generated eAIP package (public/data/<id>-adcharts.json, cmd/eaip -only
 * adcharts): per aerodrome page the package lists, that page and the charts
 * its AD 2.24 links, in at-adcharts.json's shape. Where a State's small
 * aerodromes sit in a publication of their own (PANSA's AIP VFR, ANS CR's
 * VFR Manual), their pages join the same index, stored as whole URLs; and
 * Spain's, Romania's and Denmark's, in the same shape, are read off
 * ENAIRE's AIP viewer by cmd/es, ROMATSA's directory of PDFs by cmd/ro and
 * Naviair's document tree by cmd/dk.
 *
 * They are LINKS to the publisher's own files, which is why a State held
 * for its data (docs/eaip-states.md) still has one: nothing is copied
 * (docs/aip-sources.md, "Chart links are not copies"). So an index is found
 * by the aerodrome's ICAO location indicator, never by the publisher of the
 * airport row: an OurAirports baseline field in Czechia gets its official
 * chart like any other. */

import { loadAipLinks, type AerodromeAipLinks } from '$lib/data/atAdcharts';

/** One index: the file prefix, the ICAO prefixes of the aerodromes it
 *  covers, and the publisher it links, as the publisher names itself. */
export interface AipChartIndex {
	readonly id: string;
	readonly prefixes: readonly string[];
	readonly publisher: string;
	/** The ISO 3166 region the About card names it by, where the Layers
	 *  catalog has no name for it (the held States). */
	readonly region: string;
	/** Every territory the index covers, where it is more than its region:
	 *  the About card names them all, Naviair's tree holding the Faroe
	 *  Islands' and Greenland's AIPs beside Denmark's. */
	readonly regions?: readonly string[];
}

// i18n-ignore-start: locale-invariant publisher names and region codes
export const AIP_CHART_INDEXES = [
	{ id: 'sk', prefixes: ['LZ'], publisher: 'LPS SR', region: 'SK' },
	{ id: 'ie', prefixes: ['EI'], publisher: 'AirNav Ireland', region: 'IE' },
	// SMATSA publishes one AIP for Serbia and Montenegro, both LY.
	{ id: 'rs', prefixes: ['LY'], publisher: 'SMATSA', region: 'RS' },
	{ id: 'xk', prefixes: ['BK'], publisher: 'KANS', region: 'XK' },
	{ id: 'fi', prefixes: ['EF'], publisher: 'Fintraffic ANS', region: 'FI' },
	{ id: 'is', prefixes: ['BI'], publisher: 'Avians', region: 'IS' },
	// Their airspace is open data read elsewhere (cmd/se, cmd/nl); the eAIP
	// gives the charts.
	{ id: 'se', prefixes: ['ES'], publisher: 'LFV', region: 'SE' },
	{ id: 'nl', prefixes: ['EH'], publisher: 'LVNL', region: 'NL' },
	// Not a generated package but ENAIRE's AIP viewer (cmd/es -only
	// adcharts): Spain's own series, the mainland, the Canaries, Ceuta and
	// Melilla.
	{ id: 'es', prefixes: ['LE', 'GC', 'GE'], publisher: 'ENAIRE', region: 'ES' },
	// A PDF AIP in an open directory (cmd/ro), the titles read out of each
	// field's own AD 2.24 list.
	{ id: 'ro', prefixes: ['LR'], publisher: 'ROMATSA', region: 'RO' },
	// Naviair's document tree (cmd/dk): Denmark's AIP and VFR Flight Guide,
	// and the AIPs of the Faroe Islands (EK too) and Greenland.
	{ id: 'dk', prefixes: ['EK', 'BG'], publisher: 'Naviair', region: 'DK', regions: ['DK', 'FO', 'GL'] },
	{ id: 'hu', prefixes: ['LH'], publisher: 'HungaroControl', region: 'HU' },
	{ id: 'pt', prefixes: ['LP'], publisher: 'NAV Portugal', region: 'PT' },
	{ id: 'cz', prefixes: ['LK'], publisher: 'ANS CR', region: 'CZ' },
	{ id: 'pl', prefixes: ['EP'], publisher: 'PANSA', region: 'PL' },
	{ id: 'ba', prefixes: ['LQ'], publisher: 'BHANSA', region: 'BA' },
	{ id: 'si', prefixes: ['LJ'], publisher: 'Slovenia Control', region: 'SI' },
	{ id: 'al', prefixes: ['LA'], publisher: 'ALBCONTROL', region: 'AL' },
	{ id: 'ee', prefixes: ['EE'], publisher: 'EANS', region: 'EE' },
	{ id: 'lv', prefixes: ['EV'], publisher: 'LGS', region: 'LV' },
	{ id: 'no', prefixes: ['EN'], publisher: 'Avinor', region: 'NO' },
] as const satisfies readonly AipChartIndex[];
// i18n-ignore-end

/** The index covering an ICAO location indicator, or null. */
export function aipChartIndexFor(ident: string): AipChartIndex | null {
	const i = ident.trim().toUpperCase();
	if (i.length !== 4) {
		return null;
	}
	return AIP_CHART_INDEXES.find((x) => (x.prefixes as readonly string[]).includes(i.slice(0, 2))) ?? null;
}

/** An index's dataset URL, current slot or the next one. */
export function aipChartsUrl(id: string, next = false): string {
	return `/data/${id}-adcharts${next ? '.next' : ''}.json`;
}

/** Load one index. Fail-soft like the Austrian one: a missing file reads as
 *  an empty index, so the panel simply shows no chart row, and a failure
 *  worth asking again rejects, for its retry. */
export function loadAipCharts(url: string): Promise<AerodromeAipLinks[]> {
	return loadAipLinks(url);
}
