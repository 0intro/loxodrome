/* The Settings-tab preferences: NOTAM marker rendering, downloaded-content
 * languages, live data, position, appearance. Map and NOTAM visibility
 * proper lives in filter / layers; the consumers span the app. Persisted:
 * liveWeather (a network kill switch must survive reloads),
 * profileAllAirspaces (a reading preference with a control on the chart it
 * governs), gpsAltDatum, traceExportFormat, and the three content-language
 * prefs; each is stored only away from its default, so an untouched
 * preference leaves no storage behind. */

import type { LangPref } from '$lib/i18n/locale';
import type { AltDatumPref } from '$lib/nav/altitudeDatum';
import { isTraceFormat, type TraceFormat } from '$lib/nav/traceExport';
import { readItem, removeItem, writeItem } from './persist';

const LIVE_WEATHER_KEY = 'loxodrome:live-weather';
const PROFILE_ALL_AIRSPACES_KEY = 'loxodrome:profile-all-airspaces';
const GPS_ALT_DATUM_KEY = 'loxodrome:gps-alt-datum';
const SUPAIP_LANG_KEY = 'loxodrome:supaip-lang';
const SOFIA_LANG_KEY = 'loxodrome:sofia-lang';
const AIP_REMARK_LANG_KEY = 'loxodrome:aip-remark-lang';
const TRACE_EXPORT_FORMAT_KEY = 'loxodrome:trace-export-format';
const CONVERT_IMPORTED_TRACES_KEY = 'loxodrome:trace-convert-imported';
const LAYERS_CONTROL_KEY = 'loxodrome:layers-control';
const TOOLBAR_IN_FLIGHT_KEY = 'loxodrome:toolbar-in-flight';
const FLIGHT_FULLSCREEN_KEY = 'loxodrome:flight-fullscreen';

// The retired single content-language key: a pinned value seeds all three
// split prefs (written through, so the pin survives the key's removal),
// then the key clears.
const LEGACY_AIP_CONTENT_LANG_KEY = 'loxodrome:aip-content-lang';
{
	const legacy = readItem(LEGACY_AIP_CONTENT_LANG_KEY);
	if (legacy === 'en' || legacy === 'fr') {
		for (const k of [SUPAIP_LANG_KEY, SOFIA_LANG_KEY, AIP_REMARK_LANG_KEY]) {
			if (readItem(k) === null) {
				writeItem(k, legacy);
			}
		}
	}
	removeItem(LEGACY_AIP_CONTENT_LANG_KEY);
}

function initialLiveWeather(): boolean {
	// readItem degrades to null on storage failure, so the default stays on.
	return readItem(LIVE_WEATHER_KEY) !== 'off';
}

function initialProfileAllAirspaces(): boolean {
	return readItem(PROFILE_ALL_AIRSPACES_KEY) !== 'off';
}

function initialAltDatum(): AltDatumPref {
	const v = readItem(GPS_ALT_DATUM_KEY);
	return v === 'ellipsoid' || v === 'msl' ? v : 'auto';
}

function initialLangPref(key: string): LangPref {
	const v = readItem(key);
	return v === 'en' || v === 'fr' ? v : 'auto';
}

function initialTraceExportFormat(): TraceFormat {
	const v = readItem(TRACE_EXPORT_FORMAT_KEY);
	return isTraceFormat(v) ? v : 'gpx';
}

function initialConvertImportedTraces(): boolean {
	return readItem(CONVERT_IMPORTED_TRACES_KEY) === '1';
}

/** Where the phone's layers button sits: on the toolbar, or floating on the
 *  map beside the recentre control. */
export type LayersControlPref = 'toolbar' | 'map';
/** What the phone's toolbar does while a recording runs: stays, or folds
 *  away so the map takes its row, Stop and Layers riding the band. */
export type ToolbarInFlightPref = 'kept' | 'folded';

function initialLayersControl(): LayersControlPref {
	return readItem(LAYERS_CONTROL_KEY) === 'map' ? 'map' : 'toolbar';
}

function initialToolbarInFlight(): ToolbarInFlightPref {
	return readItem(TOOLBAR_IN_FLIGHT_KEY) === 'folded' ? 'folded' : 'kept';
}

function initialFlightFullscreen(): boolean {
	return readItem(FLIGHT_FULLSCREEN_KEY) !== 'off';
}

export const display = $state<{
	/** Render obstacle-type glyphs on PSN markers. */
	typeIcons: boolean;
	/** Draw the radius circle of a selected Q-line position. The circle only
	 *  appears for the currently selected NOTAM regardless of this flag; this
	 *  toggle suppresses it entirely. */
	qlineRadius: boolean;
	/** Show the blue Q-line position markers (the fallback `DDMMN DDDMME RRR`
	 *  pin from the Q) line). Off hides them from the map; the NOTAMs are
	 *  still selectable from the list panel and a selected one still draws
	 *  its qlineRadius circle when qlineRadius is on. */
	qlineMarkers: boolean;
	/** Hide the blue (Q-line fallback) markers of airport NOTAMs from the map;
	 *  red position markers, radius circles, and area polygons stay. The NOTAMs
	 *  remain reachable via the airport cue rings, the airport detail panel, the
	 *  NOTAMs tab, and the context menu. Only takes effect while airports are
	 *  shown (Layers menu), since the airport markers are what they collapse
	 *  into. */
	hideAirportNotamMarkers: boolean;
	/** Show the live cursor-coordinates chip in the bottom-left of the
	 *  map. Off hides the chip entirely. */
	cursorCoords: boolean;
	/** Vertical profiles plot every relevant airspace (on by default); off
	 *  restricts them to the airspaces currently displayed on the map (the
	 *  Layers menu category + publisher toggles). */
	profileAllAirspaces: boolean;
	/** Show the location-based geometric lists: "In airspaces" on the NOTAM
	 *  detail panel (the airspaces a NOTAM geometrically sits in, from its
	 *  area or Q-line position) and "In this airspace" on non-FIR airspace
	 *  panels (the NOTAMs whose geometry touches the airspace). Off by
	 *  default; the explicit relationship links (named / designator /
	 *  activation) are always shown. */
	showInAirspaces: boolean;
	/** When a selected NOTAM names airspaces ("Affected airspaces"), draw all of
	 *  them highlighted on the map and suppress that NOTAM's auto Q-line radius
	 *  circle. The circle stays available per-NOTAM via the detail-panel toggle.
	 *  On by default. */
	affectedAirspaces: boolean;
	/** Preferred language for the SUP AIP subject text (shown in the detail
	 *  panel). 'auto' follows the UI locale; 'en' / 'fr' pin it. French
	 *  supplements carry an English subject only when an _en.pdf exists; the
	 *  resolved language falls back to French otherwise. Persisted through
	 *  setSupaipLang. */
	supaipLang: LangPref;
	/** Preferred language for the NOTAM free text fetched from SOFIA-Briefing
	 *  (the E-item; French supplements carry both an English and a French
	 *  form). 'auto' follows the UI locale; a NOTAM with only one form keeps
	 *  it. Read by the SOFIA route fetch, the default NOTAM source. Persisted
	 *  through setSofiaLang. */
	sofiaLang: LangPref;
	/** Preferred language for the SIA AIP free-text remarks (the airspace and
	 *  obstacle detail panels). The AIXM export encodes some remarks
	 *  bilingually as "French\\English"; 'auto' follows the UI locale, 'en' /
	 *  'fr' pin it. A single-language remark is shown as published. Persisted
	 *  through setAipRemarkLang. */
	aipRemarkLang: LangPref;
	/** Fetch live METAR / TAF (NOAA Aviation Weather Center via the notam
	 *  proxy): the airport panel's Weather section and the flight-prep
	 *  performance defaults. Off disables every weather fetch and hides the
	 *  weather UI. */
	liveWeather: boolean;
	/** Which datum the device's GNSS altitude arrives on. 'auto' follows the
	 *  platform (Apple reports MSL through Core Location, everything else the
	 *  W3C ellipsoidal height); the other two pin it. It exists because the
	 *  platform answer is a ~150 ft default, not a verdict, and a pilot can
	 *  check it on the ground against the field elevation
	 *  (nav/altitudeDatum.ts, docs/nav-live.md). */
	gpsAltDatum: AltDatumPref;
	/** Which file format a recorded trace is exported as: GPX (the default,
	 *  universal), IGC (gliding, OLC and club debriefing) or KML (Google
	 *  Earth). It governs the Navigation tab's export, a filed outing's row
	 *  export and the flights ZIP alike, which is why it is a preference and
	 *  not a per-button choice; those surfaces name the format in force
	 *  rather than carrying their own control (nav/traceExport.ts,
	 *  docs/trace-files.md). Persisted through setTraceExportFormat.
	 *
	 *  It governs what the APPLICATION RECORDS. An imported trace is exported
	 *  as the file it arrived as, since the app models neither an IGC's
	 *  security record and pressure altitude nor a GPX's extensions, and
	 *  re-synthesising one would hand back a different document under the
	 *  same claim (state/traceFile.ts). */
	traceExportFormat: TraceFormat;
	/** Convert IMPORTED traces to `traceExportFormat` on export too, instead
	 *  of handing back their own bytes. Off by default: a pilot who asks for
	 *  one format throughout means it, but nobody's third-party file should
	 *  be rewritten without being asked. */
	convertImportedTraces: boolean;
	/** Settings › Interface (phones; docs/mobile-ui-review.md): the layers
	 *  button on the toolbar (default) or floating on the map, where the
	 *  fit-route button joins it. Persisted through setLayersControl. */
	layersControl: LayersControlPref;
	/** The toolbar while recording: kept (default) or folded away, the band's
	 *  contact row then carrying Stop and Layers. Persisted through
	 *  setToolbarInFlight. */
	toolbarInFlight: ToolbarInFlightPref;
	/** Full screen rides the recording on phones: the browser's fullscreen
	 *  (the PWA's URL bar goes) or the Android shell's immersive mode (the
	 *  system bars go) while a recording runs. On by default; the opt-out is
	 *  for a pilot who wants the clock and the battery in sight. Persisted
	 *  through setFlightFullscreen. */
	flightFullscreen: boolean;
}>({
	typeIcons: true,
	qlineRadius: true,
	qlineMarkers: true,
	hideAirportNotamMarkers: true,
	cursorCoords: true,
	profileAllAirspaces: initialProfileAllAirspaces(),
	showInAirspaces: false,
	affectedAirspaces: true,
	supaipLang: initialLangPref(SUPAIP_LANG_KEY),
	sofiaLang: initialLangPref(SOFIA_LANG_KEY),
	aipRemarkLang: initialLangPref(AIP_REMARK_LANG_KEY),
	liveWeather: initialLiveWeather(),
	gpsAltDatum: initialAltDatum(),
	traceExportFormat: initialTraceExportFormat(),
	convertImportedTraces: initialConvertImportedTraces(),
	layersControl: initialLayersControl(),
	toolbarInFlight: initialToolbarInFlight(),
	flightFullscreen: initialFlightFullscreen(),
});

/** Flip the live-weather fetches and remember the choice: the stored key
 *  exists only while OFF, so the default state leaves no storage behind. */
export function setLiveWeather(on: boolean): void {
	display.liveWeather = on;
	if (on) {
		removeItem(LIVE_WEATHER_KEY);
	} else {
		writeItem(LIVE_WEATHER_KEY, 'off');
	}
}

/** Pin the GNSS altitude datum, or hand it back to the platform default.
 *  Stored only when pinned, so the default leaves no storage behind. */
export function setGpsAltDatum(pref: AltDatumPref): void {
	display.gpsAltDatum = pref;
	if (pref === 'auto') {
		removeItem(GPS_ALT_DATUM_KEY);
	} else {
		writeItem(GPS_ALT_DATUM_KEY, pref);
	}
}

/** Pin the trace export format. Stored only away from the GPX default, so
 *  an untouched preference leaves no storage behind. */
export function setTraceExportFormat(format: TraceFormat): void {
	display.traceExportFormat = format;
	if (format === 'gpx') {
		removeItem(TRACE_EXPORT_FORMAT_KEY);
	} else {
		writeItem(TRACE_EXPORT_FORMAT_KEY, format);
	}
}

/** Flip the convert-on-export choice. Stored only while ON, so the default
 *  leaves no storage behind. */
export function setConvertImportedTraces(on: boolean): void {
	display.convertImportedTraces = on;
	if (on) {
		writeItem(CONVERT_IMPORTED_TRACES_KEY, '1');
	} else {
		removeItem(CONVERT_IMPORTED_TRACES_KEY);
	}
}

function setLangPref(key: string, apply: (v: LangPref) => void, pref: LangPref): void {
	apply(pref);
	if (pref === 'auto') {
		removeItem(key);
	} else {
		writeItem(key, pref);
	}
}

/** Pin the SUP AIP subject language, or hand it back to the UI locale.
 *  Stored only when pinned, so the default leaves no storage behind. */
export function setSupaipLang(pref: LangPref): void {
	setLangPref(SUPAIP_LANG_KEY, (v) => (display.supaipLang = v), pref);
}

/** Pin the SOFIA NOTAM text language; the same store-only-when-pinned rule. */
export function setSofiaLang(pref: LangPref): void {
	setLangPref(SOFIA_LANG_KEY, (v) => (display.sofiaLang = v), pref);
}

/** Pin the AIP free-text remark language; the same rule. */
export function setAipRemarkLang(pref: LangPref): void {
	setLangPref(AIP_REMARK_LANG_KEY, (v) => (display.aipRemarkLang = v), pref);
}

/** Flip which airspaces the vertical profiles plot, and remember it. Reachable
 *  from the Settings tab AND from every profile chart's own header, so it is
 *  flipped often enough that a reload must not undo it (the reading-preference
 *  rule state/profileLayers.svelte.ts follows). Stored only while OFF. */
export function setProfileAllAirspaces(on: boolean): void {
	display.profileAllAirspaces = on;
	if (on) {
		removeItem(PROFILE_ALL_AIRSPACES_KEY);
	} else {
		writeItem(PROFILE_ALL_AIRSPACES_KEY, 'off');
	}
}

/** Pin where the phone's layers control sits; stored only away from the
 *  toolbar default. */
export function setLayersControl(pref: LayersControlPref): void {
	display.layersControl = pref;
	if (pref === 'toolbar') {
		removeItem(LAYERS_CONTROL_KEY);
	} else {
		writeItem(LAYERS_CONTROL_KEY, pref);
	}
}

/** Pin what the toolbar does in flight; stored only while folded. */
export function setToolbarInFlight(pref: ToolbarInFlightPref): void {
	display.toolbarInFlight = pref;
	if (pref === 'kept') {
		removeItem(TOOLBAR_IN_FLIGHT_KEY);
	} else {
		writeItem(TOOLBAR_IN_FLIGHT_KEY, pref);
	}
}

/** Flip full screen in flight; stored only while OFF. */
export function setFlightFullscreen(on: boolean): void {
	display.flightFullscreen = on;
	if (on) {
		removeItem(FLIGHT_FULLSCREEN_KEY);
	} else {
		writeItem(FLIGHT_FULLSCREEN_KEY, 'off');
	}
}
