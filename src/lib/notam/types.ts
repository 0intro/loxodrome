/** Shared types for the NOTAM parser core. */

import type { VLimit } from '$lib/vertical/limits';

export interface LatLon {
	lat: number;
	lon: number;
}

export type RadiusUnit = 'NM' | 'KM' | 'M';

export type CoordType = 'psn' | 'qualifierLine';

/** A single coordinate extracted from a NOTAM. */
export interface NotamCoordinate extends LatLon {
	/** The raw coordinate text it was parsed from. */
	original: string;
	type: CoordType;
	/** Radius of a circle centred on this position, if the NOTAM gives one. */
	radius?: number | undefined;
	radiusUnit?: RadiusUnit | undefined;
	/** Set when this coord is the centre of an arc segment of the boundary. */
	arcRadius?: number;
	arcRadiusUnit?: RadiusUnit;
	/** The arc runs anticlockwise ("REVERSE CLOCKWISE ARC", "ARC
	 *  ANTI-HORAIRE"); clockwise when absent. */
	arcCcw?: boolean;
}

export type SectionLetter = 'Q' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

/** NOTAM content split into ICAO sections. */
export type NotamSections = Partial<Record<SectionLetter, string>>;

/** Structured Q) qualifier line. */
export interface QualifierLine {
	fir: string;
	code: string;
	traffic: string;
	purpose: string;
	scope: string;
	lower: number;
	upper: number;
	lat: number;
	lon: number;
	radius: number | null;
}

export interface NotamDates {
	start: Date | null;
	end: Date | null;
	permanent: boolean;
	estimated: boolean;
}

/** An airport-anchored position spec, e.g. "RDL 031/5.4NM ARP LFAI". */
export interface AirportAnchor {
	bearing: number;
	distance: number;
	distanceUnit: RadiusUnit;
	ident: string;
}

export type AirportLookup = (ident: string) => LatLon | null;

export interface ParseOptions {
	lookupAirport?: AirportLookup;
}

/** Service status declared by a NOTAM: 'unserviceable' (out of service),
 *  'restored' (back in service), or '' (neither / not a service notice).
 *  Derived from the Q-code condition + multilingual E-text; see
 *  classifyServiceStatus in serviceStatus.ts. */
export type ServiceStatus = 'unserviceable' | 'restored' | '';

/** A parsed NOTAM. One source NOTAM may yield several of these; one per
 *  coordinate group (a polygon or a standalone position). */
export interface Notam {
	id: string;
	/** The full NOTAM text, whitespace-normalised. */
	fullContent: string;
	coordinates: NotamCoordinate[];
	icaoCodes: string[];
	isPolygon: boolean;
	startDate: Date | null;
	endDate: Date | null;
	permanent: boolean;
	estimated: boolean;
	/** The 5-letter Q-code, or '' when absent. */
	qCode: string;
	/** Coarse obstacle/activity classification of the E) section, or ''. */
	obstacleType: string;
	/** Whether the NOTAM declares its subject unserviceable / restored, or ''
	 *  (Q-code condition + multilingual E-text; see serviceStatus.ts). */
	serviceStatus: ServiceStatus;
	/** The full parsed Q) qualifier line, or null. */
	qualifier: QualifierLine | null;
	/** Vertical limits parsed from the F) / G) items: the operational
	 *  values, which take precedence over the coarse Q-line band per
	 *  OPADD. Null when the item is absent or no limit grammar matched. */
	fgLower: VLimit | null;
	fgUpper: VLimit | null;
	/** When this NOTAM is a NOTAMR replacement ("<self> NOTAMR <other>" on
	 *  the header line), the id it supersedes; null otherwise. Captured
	 *  by the parser from the header so consumers don't have to peek at
	 *  the leading line of fullContent. */
	replaces: string | null;
}
