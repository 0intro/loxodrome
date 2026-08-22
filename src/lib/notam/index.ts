/** Public surface of the NOTAM parser core. */

export * from './types';
export {
	parseNotams,
	parseSections,
	parseQualifierLine,
	parseNotamDates,
	cleanNotamContent,
	rejoinSplitCoordLines,
} from './parser';
export { parseDMSCoordinate, parseDMSComponent } from './coordinates';
export { decodeQCode, Q_SUBJECTS, Q_CONDITIONS } from './qcode';
export { classifyOwner, firOwnershipIndex } from './ownership';
export type { NotamOwner, OwnerResolvers } from './ownership';
export { classifyObstacle } from './classify';
export {
	extractRadiusFromText,
	radiusToNM,
	extractAirportAnchor,
	computeAirportAnchoredPosition,
} from './radius';
export { extractArpIdents } from './airportRefs';
export { extractRunwayDesignators, normalizeRunwayDesignator } from './runwayRefs';
export {
	segmentsIntersect,
	isSelfIntersecting,
	makeSimplePolygon,
	computePolygonArea,
	tagArcCenter,
	sampleArcPoints,
	expandArcs,
	normalizePolygonLongitudes,
} from './geometry';
export {
	AEROBATIC_CORRIDOR_WIDTH_M,
	aerobaticCorridorRing,
	parseAerobaticAxis,
} from './aerobatics';
export { formatDMS, formatDMSAxis, radiusUnitDisplay } from './format';
export { NM_TO_METERS, NM_TO_KILOMETERS } from './units';
