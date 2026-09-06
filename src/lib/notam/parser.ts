import {
	AEROBATIC_CORRIDOR_WIDTH_M,
	aerobaticCorridorRing,
	parseAerobaticAxis,
} from './aerobatics';
import { classifyObstacle } from './classify';
import { classifyServiceStatus } from './serviceStatus';
import { parseDMSCoordinate } from './coordinates';
import {
	expandArcs,
	isSelfIntersecting,
	makeSimplePolygon,
	normalizePolygonLongitudes,
	tagArcCenter,
} from './geometry';
import {
	computeAirportAnchoredPosition,
	extractAirportAnchor,
	extractRadiusFromText,
} from './radius';
import { fromNotamLimit } from '$lib/vertical/limits';
import type {
	LatLon,
	Notam,
	NotamCoordinate,
	NotamDates,
	NotamSections,
	ParseOptions,
	QualifierLine,
	SectionLetter,
} from './types';

// Area-keyword detection. Translations cover the languages seen in real data.
const lateralLimitsTranslations = [
	'LATERAL\\s+LIMITS?', // English
	'LIMITES?\\s+LATERALES?', // French
	'GRANICE\\s+POZIOME', // Polish
];
const areaTranslations = [
	'AREA', // English
	'SAHA', // Turkish
];
const areaKeywordsPattern = new RegExp(
	'\\b(' +
		lateralLimitsTranslations.join('|') +
		'|' +
		areaTranslations.join('|') +
		'|WI\\s+COORDS?|FLW\\s+COORDS)\\b',
	'i',
);
const areaExclusionPattern = /\bRESTRICTED\s+IN\s+AREA\b/i;
// Two full DMS coords joined by a dash. Each digit group accepts a decimal
// fraction ("025001.90N 1014850.72E"), mirroring the scanner's coordPattern.
const dashConnectedCoordsPattern =
	/\d{4,7}(?:[.,]\d+)?[NS](?:\s+|\s*,\s*)\d{5,8}(?:[.,]\d+)?[EW]\s*[-]\s*\d{4,7}(?:[.,]\d+)?[NS](?:\s+|\s*,\s*)\d{5,8}(?:[.,]\d+)?[EW]/i;

/** Parse NOTAM content into ICAO sections (Q, A, B, C, D, E, F, G). */
export function parseSections(content: string): NotamSections {
	const sections: NotamSections = {};
	// Match ICAO section markers preceded by start-of-string or whitespace, so
	// "2A)" or "(E)" are not false positives. Each letter is accepted once;
	// later occurrences (enumerated items inside E) are treated as text.
	const re = /(?:^|\s)([QABCDEFG])\)\s?/g;
	const markers: {
		letter: SectionLetter;
		matchStart: number;
		contentStart: number;
	}[] = [];
	const seen = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		if (seen.has(m[1])) {
			continue;
		}
		seen.add(m[1]);
		markers.push({
			letter: m[1] as SectionLetter,
			matchStart: m.index,
			contentStart: m.index + m[0].length,
		});
	}
	for (let i = 0; i < markers.length; i++) {
		const start = markers[i].contentStart;
		const end =
			i + 1 < markers.length ? markers[i + 1].matchStart : content.length;
		sections[markers[i].letter] = content.substring(start, end).trim();
	}
	return sections;
}

/**
 * Parse a Q) section into a structured qualifier line.
 * Format: FIR / CODE / TRAFFIC / PURPOSE / SCOPE / LOWER/UPPER / COORDINATES
 */
export function parseQualifierLine(qContent: string): QualifierLine | null {
	const fields = qContent.split(/\s*\/\s*/);
	if (fields.length < 8) {
		return null;
	}

	const fir = fields[0];
	const code = fields[1];
	const traffic = fields[2];
	const purpose = fields[3];
	const scope = fields[4];
	// Per ICAO Doc 8126, fields 5 and 6 are 3-digit FL bands. A malformed
	// band degrades to NaN (every reader guards with Number.isFinite)
	// instead of nulling the whole qualifier: FIR, scope, coordinates and
	// radius survive, and the Q-line centre stays available as the
	// last-resort coordinate source, so the NOTAM itself is not dropped.
	const lower = /^\d{3}$/.test(fields[5]) ? parseInt(fields[5], 10) : NaN;
	const upper = /^\d{3}$/.test(fields[6]) ? parseInt(fields[6], 10) : NaN;

	// Coordinate: DDMMN/S DDDMME/W + optional 3-digit radius in NM.
	const coordStr = fields[7];
	const coordMatch = coordStr.match(/^(\d{4})([NS])(\d{5})([EW])(\d{3})?$/i);
	if (!coordMatch) {
		return null;
	}

	const latDeg = parseInt(coordMatch[1].substring(0, 2), 10);
	const latMin = parseInt(coordMatch[1].substring(2, 4), 10);
	const lonDeg = parseInt(coordMatch[3].substring(0, 3), 10);
	const lonMin = parseInt(coordMatch[3].substring(3, 5), 10);

	let lat = latDeg + latMin / 60;
	let lon = lonDeg + lonMin / 60;
	if (coordMatch[2].toUpperCase() === 'S') {
		lat = -lat;
	}
	if (coordMatch[4].toUpperCase() === 'W') {
		lon = -lon;
	}

	const radius = coordMatch[5] ? parseInt(coordMatch[5], 10) : null;

	return { fir, code, traffic, purpose, scope, lower, upper, lat, lon, radius };
}

/** Parse NOTAM validity dates from B)/C) sections or a SOFIA-Briefing DU/AU line. */
export function parseNotamDates(
	sections: NotamSections,
	content: string,
): NotamDates {
	let start: Date | null = null;
	let end: Date | null = null;
	let permanent = false;
	let estimated = false;

	const parseBCDate = (str: string): Date | null => {
		let m = str.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
		if (m) {
			return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
		}
		m = str.match(/\b(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\b/);
		if (m) {
			return new Date(Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
		}
		return null;
	};

	if (sections.B) {
		start = parseBCDate(sections.B);
	}
	if (sections.C) {
		if (/\bPERM\b/i.test(sections.C)) {
			permanent = true;
		} else {
			const cStr = sections.C.replace(/\s*\bEST\b/i, '');
			if (cStr !== sections.C) {
				estimated = true;
			}
			end = parseBCDate(cStr);
			// Some publishers (autorouter, a few national AIPs) use a
			// Y2038-style sentinel (2038-01-19 03:14 UTC, INT_MAX
			// seconds since epoch) in place of the literal "PERM"
			// keyword from ICAO Annex 15 Appendix 6. Any C) date in
			// 2038 or later is a sentinel in practice -- the AIRAC
			// cycle horizon is months, not decades -- so collapse it
			// to permanent.
			if (end && end.getUTCFullYear() >= 2038) {
				permanent = true;
				end = null;
				estimated = false;
			}
		}
	}

	// Fall back to a SOFIA-Briefing DU/AU line (format: DD MM YYYY HH:MM).
	if (!start && !end && !permanent) {
		const duMatch = content.match(
			/DU:\s*(\d{2})\s+(\d{2})\s+(\d{4})\s+(\d{2}):(\d{2})/,
		);
		if (duMatch) {
			start = new Date(
				Date.UTC(+duMatch[3], +duMatch[2] - 1, +duMatch[1], +duMatch[4], +duMatch[5]),
			);
		}

		const auMatch = content.match(/AU:\s*(.*?)(?:\n|$)/);
		if (auMatch) {
			const auStr = auMatch[1].trim();
			if (/\bPERM\b/i.test(auStr)) {
				permanent = true;
			} else {
				if (/\bEST\b/i.test(auStr)) {
					estimated = true;
				}
				const m = auStr.match(/(\d{2})\s+(\d{2})\s+(\d{4})\s+(\d{2}):(\d{2})/);
				if (m) {
					end = new Date(
						Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]),
					);
				}
				// Same Y2038-sentinel normalisation as the ICAO C)
				// branch above; SOFIA-Briefing's AU line can also
				// carry the 2038 stand-in for PERM.
				if (end && end.getUTCFullYear() >= 2038) {
					permanent = true;
					end = null;
					estimated = false;
				}
			}
		}
	}

	return { start, end, permanent, estimated };
}

/** Normalise NOTAM whitespace while preserving line structure. */
export function cleanNotamContent(content: string): string {
	return content
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join('\n');
}

/**
 * Join lines that split a DMS coordinate across a wrap (French SUP AIP trigger
 * NOTAMs wrap polygons mid-coordinate). Rejoins only when the digits before
 * the break are preceded by a polygon-separator dash and the digits after form
 * a complete lat/lon pair.
 */
export function rejoinSplitCoordLines(text: string): string {
	return text.replace(
		/(-\d{0,6})\n(\d{1,7}[NS])(\s*[,\s]\s*\d{4,8}[EW])/g,
		(m: string, a: string, b: string, c: string) =>
			/^\d{4,7}[NS]$/.test(a.slice(1) + b) ? a + b + c : m,
	);
}

/**
 * The NOTAMR header consumes "<self-id> NOTAMR" but leaves the predecessor id
 * on its own line at the start of the body. Pull it into `replaces` and strip
 * it from the content so fullContent stays clean.
 */
function extractReplaces(
	typeIndicator: string,
	content: string,
): { replaces: string | null; content: string } {
	if (typeIndicator !== 'NOTAMR') {
		return { replaces: null, content };
	}
	const leadMatch = content.match(
		/^\s*((?:[A-Z]{4}[\s-])?[A-Z]\d+\/\d+)\s*(?:\n|$)/,
	);
	if (!leadMatch) {
		return { replaces: null, content };
	}
	return {
		replaces: leadMatch[1].trim(),
		content: content.slice(leadMatch[0].length),
	};
}

/** Area keywords count only when not negated by "RESTRICTED IN AREA". */
function hasAreaKeyword(eContent: string): boolean {
	return areaKeywordsPattern.test(eContent) && !areaExclusionPattern.test(eContent);
}

/**
 * True when the E) section carries one of the cues that licenses coordinate
 * extraction: an explicit PSN / CENTRE marker, obstacle wording or an
 * obstacle Q-code, area keywords, or a dash-connected coordinate pair.
 */
function hasCoordinateExtractionCue(
	eContent: string,
	qSection: string | undefined,
): boolean {
	const hasPsnKeyword = /\bPSN\b/i.test(eContent);
	// CENTRE/CENTRED/CENTREE (British) + CENTER/CENTERED (American).
	const hasCentreKeyword = /\bCENT(?:RE|ER)E?D?\b/i.test(eContent);
	// OBST alone misses the French spelling ("FEUX D'OBSTACLE",
	// "OBSTACLES PERCANT"), and obstacle-LIGHT NOTAMs carry subject OL,
	// not OB: the English world briefing extracted a wind farm's ten
	// turbine positions while the French translation of the same NOTAM
	// (P2092/26) fell back to its Q-line point.
	const hasObstKeyword = /\bOBST(?:ACLES?)?\b/i.test(eContent);
	const hasObstQCode = qSection != null && /\/\s*QO[BL]/.test(qSection);
	return (
		hasPsnKeyword ||
		hasCentreKeyword ||
		hasObstKeyword ||
		hasObstQCode ||
		hasAreaKeyword(eContent) ||
		dashConnectedCoordsPattern.test(eContent)
	);
}

/**
 * When area keywords are present, the extraction zone starts at the first
 * keyword directly followed by coordinates; non-PSN coords before it are
 * skipped.
 */
function areaExtractionStart(eContent: string): number {
	const areaSearchPattern = new RegExp(areaKeywordsPattern.source, 'gi');
	let areaMatch: RegExpExecArray | null;
	while ((areaMatch = areaSearchPattern.exec(eContent)) !== null) {
		const after = eContent.substring(
			areaMatch.index + areaMatch[0].length,
		);
		if (
			/^.{0,40}?(?:\d{4,7}(?:\.\d+)?[NS]\s+\d{5,8}(?:\.\d+)?[EW]|\d{6}[NS]\d{7}[EW])/is.test(
				after,
			)
		) {
			return areaMatch.index;
		}
	}
	return 0;
}

/** Build a PSN coordinate, attaching the nearby radius when one was found. */
function psnCoordinate(
	coordStr: string,
	pos: LatLon,
	radiusInfo: ReturnType<typeof extractRadiusFromText>,
): NotamCoordinate {
	const coord: NotamCoordinate = {
		original: coordStr.trim(),
		lat: pos.lat,
		lon: pos.lon,
		type: 'psn',
	};
	if (radiusInfo) {
		coord.radius = radiusInfo.radius;
		coord.radiusUnit = radiusInfo.radiusUnit;
	}
	return coord;
}

/**
 * Scan the E) section for coordinates. Standalone PSNs and polygons closed by
 * a repeated coordinate become finished groups; the trailing unclosed
 * coordinates are returned as `open` for the caller to fold in.
 */
function scanCoordinates(
	eContent: string,
	extractionStartIndex: number,
): { groups: NotamCoordinate[][]; open: NotamCoordinate[] } {
	const groups: NotamCoordinate[][] = [];
	const open: NotamCoordinate[] = [];
	const seenPositions = new Set<string>();

	// Coordinate-like patterns in the E) section.
	const coordPattern =
		/(\d{4,7}(?:[.,]\d+)?)\s*([NS])(?:\s+|\s*[,-]\s*)?(\d{5,8}(?:[.,]\d+)?)\s*([EW])/gi;
	let match: RegExpExecArray | null;
	let groupClosed = false;

	while ((match = coordPattern.exec(eContent)) !== null) {
		const coordStr = match[1] + match[2] + ' ' + match[3] + match[4];
		const coords = parseDMSCoordinate(coordStr);
		if (!coords) {
			continue;
		}

		// A standalone PSN has the keyword on the same line but is not
		// dash-connected to the next coordinate (a polygon series).
		const before = eContent.substring(
			Math.max(0, match.index - 30),
			match.index,
		);
		const sameLine = before.includes('\n')
			? before.substring(before.lastIndexOf('\n') + 1)
			: before;
		const after = eContent.substring(match.index + match[0].length);
		const isStandalonePsn =
			/\bPSN\b/i.test(sameLine) && !/^\s*-\s*\d{4,7}/i.test(after);

		if (isStandalonePsn) {
			const radiusInfo = extractRadiusFromText(
				eContent,
				match.index,
				match.index + match[0].length,
			);
			groups.push([psnCoordinate(coordStr, coords, radiusInfo)]);
			continue;
		}

		// Skip non-PSN coordinates before the area extraction zone.
		if (match.index < extractionStartIndex) {
			continue;
		}

		// Position key for deduplication (~1 m precision).
		const posKey = `${coords.lat.toFixed(6)}_${coords.lon.toFixed(6)}`;

		if (seenPositions.has(posKey)) {
			// A duplicate coordinate signals polygon closure.
			if (!groupClosed && open.length > 0) {
				groups.push([...open]);
				open.length = 0;
				seenPositions.clear();
				groupClosed = true;
			}
		} else {
			groupClosed = false;
			seenPositions.add(posKey);
			const radiusInfo = extractRadiusFromText(
				eContent,
				match.index,
				match.index + match[0].length,
			);
			const coord = psnCoordinate(coordStr, coords, radiusInfo);
			tagArcCenter(coord, eContent, match.index);
			open.push(coord);
		}
	}

	return { groups, open };
}

/**
 * Fold the trailing unclosed coordinates into the group list. When every one
 * carries a radius (circle centres), emit each as its own group.
 */
function foldOpenGroup(
	groups: NotamCoordinate[][],
	open: NotamCoordinate[],
): void {
	if (open.length === 0) {
		return;
	}
	if (open.length >= 2 && open.every((c) => c.radius != null)) {
		for (const c of open) {
			groups.push([c]);
		}
	} else {
		groups.push(open);
	}
}

/**
 * Drop polygon-shaped groups whose coord sequence is coarsely identical to an
 * earlier group. Only groups of length >= 3 are candidates.
 */
function dropRepeatedPolygons(
	groups: NotamCoordinate[][],
): NotamCoordinate[][] {
	if (groups.length <= 1) {
		return groups;
	}
	const keyOf = (c: LatLon): string =>
		`${c.lat.toFixed(3)}_${c.lon.toFixed(3)}`;
	const seqOf = (g: LatLon[]): string => g.map(keyOf).join('|');
	const seenSeqs = new Set<string>();
	const filtered: NotamCoordinate[][] = [];
	for (const group of groups) {
		if (group.length < 3) {
			filtered.push(group);
			continue;
		}
		const seq = seqOf(group);
		if (seenSeqs.has(seq)) {
			continue;
		}
		seenSeqs.add(seq);
		filtered.push(group);
	}
	return filtered;
}

/** Extract the coordinate groups (PSNs, polygons, circles) from an E) section. */
function collectCoordinateGroups(
	eContent: string | null,
	qSection: string | undefined,
): NotamCoordinate[][] {
	if (!eContent || !hasCoordinateExtractionCue(eContent, qSection)) {
		return [];
	}
	const extractionStartIndex = hasAreaKeyword(eContent)
		? areaExtractionStart(eContent)
		: 0;
	const { groups, open } = scanCoordinates(eContent, extractionStartIndex);
	foldOpenGroup(groups, open);
	return dropRepeatedPolygons(groups);
}

/**
 * Aerobatic ("VOLTIGE") display lines give an axis bearing, a length along it
 * and a centre PSN, but no width. Draw the box as a thin fixed-width corridor
 * rectangle centred on the PSN (the source has no width). Only fires for a
 * voltige NOTAM whose axis + length parse and that extracted exactly one
 * centre coordinate; otherwise the NOTAM is left as a point (e.g. circular
 * voltige with a RAYON, or a SUPPRIMEE notice with only a PSN). Returns true
 * when the centre group was replaced by the corridor ring.
 */
function applyAerobaticCorridor(
	groups: NotamCoordinate[][],
	eContent: string | null,
	obstacleType: ReturnType<typeof classifyObstacle>,
): boolean {
	if (
		!eContent ||
		obstacleType !== 'voltige' ||
		groups.length !== 1 ||
		groups[0].length !== 1
	) {
		return false;
	}
	const axis = parseAerobaticAxis(eContent);
	if (!axis) {
		return false;
	}
	groups[0] = aerobaticCorridorRing(
		groups[0][0],
		axis,
		axis.widthM ?? AEROBATIC_CORRIDOR_WIDTH_M,
	);
	return true;
}

/**
 * Position computed from an "RDL <bearing>/<distance> ARP <ICAO>" spec and
 * the airport lookup, as a one-coordinate group; null when no anchor parses
 * or the airport is unknown.
 */
function airportAnchoredGroup(
	eContent: string | null,
	lookupAirport: ParseOptions['lookupAirport'],
): NotamCoordinate[] | null {
	if (!eContent || !lookupAirport) {
		return null;
	}
	const anchor = extractAirportAnchor(eContent);
	if (!anchor) {
		return null;
	}
	const ap = lookupAirport(anchor.ident);
	if (!ap) {
		return null;
	}
	const pos = computeAirportAnchoredPosition(anchor, ap);
	return [
		{
			original: `RDL ${anchor.bearing}/${anchor.distance}${anchor.distanceUnit} ARP ${anchor.ident}`,
			lat: pos.lat,
			lon: pos.lon,
			type: 'psn',
		},
	];
}

/** The Q-line centre point as the last-resort coordinate group. */
function qualifierLineGroup(
	qSection: string,
	qualifier: QualifierLine,
): NotamCoordinate[] {
	return [
		{
			original: qSection.split(/\s*\/\s*/).pop() ?? '',
			lat: qualifier.lat,
			lon: qualifier.lon,
			// Q-line radius is always in NM per ICAO Doc 8126.
			radius: qualifier.radius ?? undefined,
			radiusUnit: qualifier.radius != null ? 'NM' : undefined,
			type: 'qualifierLine',
		},
	];
}

/** ICAO location indicators from the A) section (one or several). */
function icaoCodesFromA(aSection: string | undefined): string[] {
	if (!aSection) {
		return [];
	}
	const icaoMatch = aSection.match(/([A-Z]{4}(?:\s+[A-Z]{4})*)/i);
	return icaoMatch ? icaoMatch[1].split(/\s+/) : [];
}

/**
 * A group is drawn as a polygon when the aerobatic-corridor builder made it
 * one, or when the E) text shows area phrasing, a parenthesised closing
 * coordinate, dash-connected coordinate pairs (with enough points), or the
 * ring closes on itself.
 */
function inferIsPolygon(
	groupCoords: NotamCoordinate[],
	eContent: string | null,
	aerobaticCorridor: boolean,
): boolean {
	if (aerobaticCorridor && groupCoords.length >= 3) {
		return true;
	}
	if (groupCoords.length < 3 || !eContent) {
		return false;
	}

	// A parenthesised closing coordinate.
	const hasClosingCoord = /\(\s*\d{4,7}\s*[NS]\s+\d{5,8}\s*[EW]\s*\)/i.test(
		eContent,
	);
	const hasDashConnectedCoords = dashConnectedCoordsPattern.test(eContent);

	// First and last coords match (closed without parentheses).
	const firstCoord = groupCoords[0];
	const lastCoord = groupCoords[groupCoords.length - 1];
	const isClosed =
		Math.abs(firstCoord.lat - lastCoord.lat) < 0.001 &&
		Math.abs(firstCoord.lon - lastCoord.lon) < 0.001;

	// A tagged clockwise-arc centre is boundary language by itself: an arc
	// only ever describes a zone's lateral limits, so the group is an area
	// even when the text lacks an area keyword ("ZONE INTERDITE TEMPORAIRE
	// ..." bodies that never say LIMITES LATERALES; without this the arc
	// would also never expand, expandArcs running on polygons only).
	const hasArcCenter = groupCoords.some((c) => c.arcRadius != null);

	return (
		hasAreaKeyword(eContent) ||
		hasClosingCoord ||
		(hasDashConnectedCoords && groupCoords.length >= 4) ||
		isClosed ||
		hasArcCenter
	);
}

/**
 * Parse NOTAMs and extract those with coordinates. When opts.lookupAirport is
 * provided, NOTAMs with no DMS coord but an "RDL <bearing>/<distance> ARP
 * <ICAO>" spec gain a position computed from the airport coord.
 */
export function parseNotams(text: string, opts: ParseOptions = {}): Notam[] {
	const lookupAirport = opts.lookupAirport;
	const notams: Notam[] = [];
	const seenIds = new Set<string>();

	// Split into individual NOTAMs by the NOTAM ID pattern. Supports
	// SOFIA-Briefing (LFFF-A1234/25) and autorouter (LFFF A1234/25, A1234/25).
	// The optional NOTAM/NOTAMR/NOTAMN/NOTAMC type indicator is captured so we
	// can distinguish replacement headers ("<self> NOTAMR <other>") and pull
	// the predecessor id off the front of the content cleanly.
	const notamPattern =
		/(?:^|\n)\s*((?:[A-Z]{4}[\s-])?[A-Z]\d+\/\d+)\s*(NOTAM[NRC]?)?/gi;
	const parts = text.split(notamPattern);

	// Reassemble false headers: bodies routinely carry id-shaped tokens at a
	// line start (checklist entries, REF lists), which the split severed. A
	// candidate is a real header only when a NOTAM type indicator follows or
	// its chunk opens like a NOTAM body (a Q)/A) section, or the SIA DU:
	// validity line); anything else is glued back onto the preceding NOTAM's
	// content, so seenIds can't suppress the genuine NOTAM of that id later
	// in the text. Triples: [before, id1, type1, content1, id2, type2, …].
	const pieces: { id: string; type: string; content: string }[] = [];
	for (let i = 1; i + 1 < parts.length; i += 3) {
		const id = parts[i].trim();
		const type = (parts[i + 1] || '').toUpperCase();
		const chunk = parts[i + 2] || '';
		const isHeader = type !== '' || /^\s*(?:[QA]\)|DU\s*:)/.test(chunk);
		if (!isHeader && pieces.length > 0) {
			const prev = pieces[pieces.length - 1];
			prev.content += '\n' + id + (chunk ? ' ' + chunk : '');
		} else {
			pieces.push({ id, type, content: chunk });
		}
	}

	for (const piece of pieces) {
		const notamId = piece.id;
		if (seenIds.has(notamId)) {
			continue;
		}
		seenIds.add(notamId);
		const extracted = extractReplaces(piece.type, piece.content);
		const replaces = extracted.replaces;
		let content = extracted.content;

		// NOTAM content ends at an empty line, EXCEPT when a later ICAO
		// section marker shows the text after it still belongs to this NOTAM
		// (real briefings wrap E) coordinate blocks with whitespace-only
		// lines, e.g. WMKK A5568/25's polygon and F)/G) items).
		const emptyLineRe = /\n[^\S\n]*\n/g;
		let cut: RegExpExecArray | null;
		while ((cut = emptyLineRe.exec(content)) !== null) {
			if (!/(?:^|\s)[A-G]\)/.test(content.substring(cut.index + cut[0].length))) {
				content = content.substring(0, cut.index);
				break;
			}
		}

		const sections = parseSections(content);
		const dates = parseNotamDates(sections, content);
		const eContent = sections.E ? rejoinSplitCoordLines(sections.E) : null;
		const qSection = sections.Q;

		// Operational vertical limits from the F)/G) items (OPADD: they take
		// precedence over the coarse Q-line band wherever both exist).
		const fgLower = fromNotamLimit(sections.F ?? null);
		const fgUpper = fromNotamLimit(sections.G ?? null);

		const coordinateGroups = collectCoordinateGroups(eContent, qSection);

		// Parse the Q-line once: the classifier's subject fallback, the qCode
		// on the emit, and the fallback coord source below all read it.
		const qualifier = qSection ? parseQualifierLine(qSection) : null;

		// Coarse activity classification, reused below for the emit and to gate
		// the aerobatic-corridor geometry.
		const obstacleType = classifyObstacle(eContent, qualifier?.code);
		const aerobaticCorridor = applyAerobaticCorridor(
			coordinateGroups,
			eContent,
			obstacleType,
		);

		// Try an airport-anchored position before falling back to the Q-line.
		if (coordinateGroups.length === 0) {
			const anchored = airportAnchoredGroup(eContent, lookupAirport);
			if (anchored) {
				coordinateGroups.push(anchored);
			}
		}

		// Use qualifier-line coordinates only if no PSN coordinates were found.
		if (coordinateGroups.length === 0 && qualifier && qSection) {
			coordinateGroups.push(qualifierLineGroup(qSection, qualifier));
		}

		const icaoCodes = icaoCodesFromA(sections.A);

		// Emit a NOTAM entry for each coordinate group.
		for (const groupCoords of coordinateGroups) {
			const isPolygon = inferIsPolygon(groupCoords, eContent, aerobaticCorridor);

			let finalCoords =
				isPolygon && isSelfIntersecting(groupCoords)
					? makeSimplePolygon(groupCoords)
					: groupCoords;
			if (isPolygon) {
				finalCoords = expandArcs(finalCoords);
				normalizePolygonLongitudes(finalCoords);
			}
			notams.push({
				id: notamId,
				fullContent: cleanNotamContent(content),
				coordinates: finalCoords,
				icaoCodes: icaoCodes,
				isPolygon: isPolygon,
				startDate: dates.start,
				endDate: dates.end,
				permanent: dates.permanent,
				estimated: dates.estimated,
				qCode: qualifier ? qualifier.code : '',
				obstacleType: obstacleType,
				serviceStatus: classifyServiceStatus(eContent, qualifier ? qualifier.code : ''),
				qualifier: qualifier,
				fgLower: fgLower,
				fgUpper: fgUpper,
				replaces: replaces,
			});
		}
	}

	return notams;
}
