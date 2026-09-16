/* The route as an AceXML flight plan (.pln), the format Flight Simulator,
 * Prepar3D and their tooling read, and the fourth SDVFR takes.
 *
 * The header constants are the format's, not ours: `version="1,0"` with its
 * comma, the fixed `AceXML Document` description, and the FSX application
 * version 10 / 61637 that SDVFR also writes. A plan stamped with the newer
 * Flight Simulator build is refused by the older simulators, while every
 * consumer in the chain reads the FSX pair, so that is what a file meant for
 * interchange claims.
 *
 * Tested by tests/routeFormats.spec.ts. */

import { xmlEscape } from '$lib/nav/gpx';
import { asciiFold } from './routeFpl';
import { dmsParts } from '$lib/notam/format';
import { MIN_POINTS, levelsFlown, type RoutePoint } from './routePoints';

/** One axis as the simulator writes it: `N48° 49' 19.00"`, degrees padded to
 *  two (latitude) or three (longitude), minutes and seconds bare, seconds to
 *  two decimals. dmsParts rounds on the TOTAL, so 49.15 gives 49° 9' 0.00"
 *  and never the 49° 8' 60.00" that rounding the seconds alone produces, an
 *  invalid second SDVFR's own files carry. */
function dms(value: number, positive: string, negative: string, degDigits: number): string {
	const { deg, min, sec } = dmsParts(Math.abs(value));
	const hemi = value >= 0 ? positive : negative;
	return `${hemi}${String(deg).padStart(degDigits, '0')}° ${min}' ${sec}"`;
}

/** Feet as the LLA's third component: signed, six integer digits, two
 *  decimals ("+001500.00").
 *
 *  Rounded to the hundredth FIRST, then split: rounding the fraction on its
 *  own carries into a third digit at .999 and prints a field the simulators
 *  cannot read. Route altitudes are whole feet today, which is exactly why
 *  the trap would sit here unseen. */
function feet(altFt: number | null): string {
	const hundredths = Math.round(Math.abs(altFt ?? 0) * 100);
	const sign = (altFt ?? 0) < 0 ? '-' : '+';
	const whole = Math.floor(hundredths / 100);
	const rest = hundredths - whole * 100;
	return `${sign}${whole.toString().padStart(6, '0')}.${rest.toString().padStart(2, '0')}`;
}

/** A position as `WorldPosition` / `DepartureLLA` state it. */
function worldPosition(p: RoutePoint, altFt: number | null): string {
	return `${dms(p.lat, 'N', 'S', 2)},${dms(p.lon, 'E', 'W', 3)},${feet(altFt)}`;
}

/** What the simulator files a point under: its published identifier where it
 *  has one, else the identifier the export gave it. */
function pointId(p: RoutePoint): string {
	return p.code ?? p.ident;
}

export interface BuildPlnOpts {
	/** The file's own subject, and what the title falls back to. */
	subject: string;
	/** The plan's caption where it has one. Folded to ASCII: the simulators
	 *  read the file in their own encodings and the degree sign in a position
	 *  is the one byte above 7 bits this format needs. */
	title?: string | undefined;
	/** The flight rules the plan is drawn under (routeSettings.vfr). */
	vfr: boolean;
}

/** Serialise the route as an AceXML .pln document, or '' when there is no
 *  route to write. */
export function buildRoutePln(points: readonly RoutePoint[], opts: BuildPlnOpts): string {
	if (points.length < MIN_POINTS) {
		return '';
	}
	const levels = levelsFlown(points);
	const departure = points[0];
	const destination = points[points.length - 1];
	const cruise = Math.max(...levels.map((a) => a ?? 0));

	// i18n-ignore-start: AceXML markup, a wire format, never user-visible text
	const lines: string[] = [];
	lines.push('<?xml version="1.0" encoding="UTF-8"?>');
	lines.push('<SimBase.Document Type="AceXML" version="1,0">');
	lines.push('\t<Descr>AceXML Document</Descr>');
	lines.push('\t<FlightPlan.FlightPlan>');
	lines.push(`\t\t<Title>${xmlEscape(asciiFold(opts.title?.trim() || opts.subject))}</Title>`);
	lines.push(`\t\t<FPType>${opts.vfr ? 'VFR' : 'IFR'}</FPType>`);
	lines.push(`\t\t<CruisingAlt>${cruise}</CruisingAlt>`);
	lines.push(`\t\t<DepartureID>${xmlEscape(pointId(departure))}</DepartureID>`);
	lines.push(`\t\t<DepartureLLA>${worldPosition(departure, levels[0])}</DepartureLLA>`);
	lines.push(`\t\t<DestinationID>${xmlEscape(pointId(destination))}</DestinationID>`);
	lines.push(
		`\t\t<DestinationLLA>${worldPosition(destination, levels[levels.length - 1])}</DestinationLLA>`,
	);
	lines.push(`\t\t<Descr>${xmlEscape(`${pointId(departure)}, ${pointId(destination)}`)}</Descr>`);
	lines.push(`\t\t<DepartureName>${xmlEscape(departure.name)}</DepartureName>`);
	lines.push(`\t\t<DestinationName>${xmlEscape(destination.name)}</DestinationName>`);
	lines.push('\t\t<AppVersion>');
	lines.push('\t\t\t<AppVersionMajor>10</AppVersionMajor>');
	lines.push('\t\t\t<AppVersionBuild>61637</AppVersionBuild>');
	lines.push('\t\t</AppVersion>');
	// One waypoint per point. SDVFR writes the departure and the arrival TWICE
	// each, an Airport and a User waypoint at the same position, which the
	// simulator reads as two zero-length legs.
	points.forEach((p, i) => {
		lines.push(`\t\t<ATCWaypoint id="${xmlEscape(p.ident)}">`);
		lines.push(`\t\t\t<ATCWaypointType>${p.aerodrome ? 'Airport' : 'User'}</ATCWaypointType>`);
		lines.push(`\t\t\t<WorldPosition>${worldPosition(p, levels[i])}</WorldPosition>`);
		if (p.aerodrome && p.code) {
			lines.push('\t\t\t<ICAO>');
			lines.push(`\t\t\t\t<ICAOIdent>${xmlEscape(p.code)}</ICAOIdent>`);
			lines.push('\t\t\t</ICAO>');
		}
		lines.push('\t\t</ATCWaypoint>');
	});
	lines.push('\t</FlightPlan.FlightPlan>');
	lines.push('</SimBase.Document>');
	// i18n-ignore-end
	return lines.join('\n') + '\n';
}
