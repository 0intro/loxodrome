// Package aixm5 decodes AIXM 5.1 / 5.1.1 BasicMessage documents
// (https://aixm.aero/page/aixm-51-511) into typed Airspace and Obstacle
// (VerticalStructure) features.
//
// Scope:
//   - Decodes BASELINE timeslices only; SNAPSHOT / PERMDELTA / TEMPDELTA
//     entries are counted to Message.SkippedNonBaseline and skipped.
//   - Geometry: gml:Surface / ElevatedSurface containing PolygonPatch
//     exterior rings made of GeodesicString, CircleByCenterPoint, and
//     ArcByCenterPoint segments. Arc tessellation uses internal/geodesy.
//   - xlink:href resolution is in-message only; external xlinks are
//     dropped with a counted warning. Not yet exercised by the
//     currently-decoded feature kinds (Phase 1).
//
// The package is consumed by cmd/uk and cmd/es (Phases 2 onward), which
// produce per-country JSON artefacts (uk-airspaces.json, es-airspaces.json,
// uk-obstacles.json, es-obstacles.json) with the same row schema France
// emits via cmd/fr.

package aixm5

// VerticalLimit is one bound of an AirspaceVolume:
//
//   - Value: the AIXM payload, verbatim ("350", "GND", "UNL", ...).
//   - Unit:  uom attribute ("FL", "FT", "M"). Empty for "GND"/"UNL".
//   - Ref:   xxLimitReference ("STD", "MSL", "SFC", ...). Empty when
//     the AIXM source doesn't carry one.
//
// Translation into the France-style [code, value, uom] triple happens
// in the cmd/uk / cmd/es per-country emitters, not here.
type VerticalLimit struct {
	Value string
	Unit  string
	Ref   string
}

// Airspace is the decoded shape of one aixm:Airspace feature (one
// BASELINE timeslice).
type Airspace struct {
	// ID is the gml:id with any "uuid." prefix stripped, so cross-message
	// references match the raw UUID form (urn:uuid:<UUID>).
	ID         string
	Designator string
	Name       string
	// Type is the aixm:type code: FIR, UIR, TMA, CTR, D, R, P, TRA,
	// ... (the codeAirspaceType codelist). Empty when the source
	// omits it.
	Type string
	// LocalType is the aixm:localType free-text refinement. DFS Germany
	// files most zones under a generic type (RAS "regulated airspace",
	// A "activity") and puts the real kind here (RMZ, TMZ, DLG-ATS,
	// FBZ, PJA, ...). Empty for publishers that don't use it (NATS,
	// ENAIRE).
	LocalType string
	// ClassCode is the first aixm:classification on the airspace; A-G
	// (ICAO Annex 11). Empty when AIXM doesn't carry a class.
	ClassCode  string
	UpperLimit *VerticalLimit
	LowerLimit *VerticalLimit
	// Ring is the boundary as [lat, lon] pairs. Empty when the source
	// has no horizontalProjection (rare; not all volumes carry one).
	Ring [][2]float64
	// WorkHr concatenates AirspaceActivation timeInterval annotations
	// (or, when present, structured Timesheets). Empty when the
	// publisher doesn't list activation hours.
	WorkHr string
	// Rmk concatenates aixm:annotation notes with purpose=REMARK on
	// the AirspaceTimeSlice. Empty when nothing is annotated.
	Rmk string
	// Radio is the list of (frequency, unit name, call sign) triples
	// reachable from Services whose clientAirspace xlink points at
	// this airspace. Empty when no Service references the airspace.
	Radio []RadioChannel
}

// RadioChannel is one frequency entry that operates a service over
// an Airspace. Mirrors France's [freq, unit, call] row shape.
type RadioChannel struct {
	Freq     string
	Unit     string
	CallSign string
}

// Obstacle is the decoded shape of one aixm:VerticalStructure feature
// (one BASELINE timeslice). VerticalStructurePart fields are folded
// into the parent when the structure has exactly one part (the common
// case); multi-part obstacles are decoded as the first part only,
// counted into Message.MultiPartObstacles.
type Obstacle struct {
	ID   string
	Name string
	// NameNote is the DESCRIPTION annotation attached to the name
	// property: the human-readable place name where a publisher keeps
	// a catalogue reference in aixm:name (Austro Control). Empty when
	// nothing is annotated.
	NameNote string
	// Type is the aixm:type code from the part. PANS-AIM vocabulary
	// (ANTENNA, BUILDING, TOWER, WIND_TURBINE, MAST, CHIMNEY,
	// CRANE, ...). Empty when the source omits it.
	Type    string
	Lat     float64
	Lon     float64
	Lighted bool
	// Group reports whether this obstacle is one of a cluster
	// sharing a single site (aixm:group=YES). False for standalone
	// obstacles or when the publisher omits the flag.
	Group bool
	// HeightM is verticalExtent in metres. Nil when the AIXM omits
	// or marks it inapplicable.
	HeightM *float64
	// ElevM is the elevation above MSL in metres. Nil when the AIXM
	// omits or marks it inapplicable.
	ElevM *float64
}

// Airport is the decoded shape of one aixm:AirportHeliport feature
// (one BASELINE timeslice), with runway children attached via the
// post-stream xlink resolution pass.
type Airport struct {
	// ID is the gml:id with any "uuid." prefix stripped, so xlink
	// references (urn:uuid:<UUID>) match.
	ID string
	// Designator is the ICAO location indicator (4-letter), e.g.
	// "EADD", "LFPG". Empty for landing strips without an ICAO.
	Designator string
	IATA       string
	Name       string
	City       string
	// ControlType is CIVIL / MILITARY / JOINT (the codeMilOperations
	// codelist). Empty when the AIXM doesn't carry one.
	ControlType string
	// Type is "AD" (aerodrome) / "HP" (heliport) / "LS" (landing
	// strip) / ... derived from aixm:type. Empty when absent.
	Type string
	Lat  float64
	Lon  float64
	// ElevM is the field elevation in metres. Nil when the AIXM
	// publishes no elevation.
	ElevM *float64
	// TransitionAltM is the published transition altitude in metres.
	// Nil when the publisher omits it or marks it xsi:nil "unknown"
	// (the NATS convention for aerodromes without one).
	TransitionAltM *float64
	// Access matches France's airport schema: "cap" when the
	// aerodrome accepts general civil traffic, "restricted" when
	// it's reserved (private, military-only). Empty when the
	// publisher doesn't make the distinction.
	Access string
	// Military reflects controlType == "MILITARY" / "JOINT" /
	// FlightCharacteristic.status == "MILITARY".
	Military bool
	// Joint is true when controlType == "JOINT" (a shared civil/military
	// aerodrome).
	Joint bool
	// Abandoned mirrors aixm:abandoned YES, the publisher's permanent
	// statement that the aerodrome is out of use. The per-country
	// emitters map it to the "closed" type.
	Abandoned bool
	// OperationalStatus is the aerodrome's standing
	// aixm:operationalStatus (NORMAL / LIMITED / CLOSED). A status
	// published beside a Timesheet covers that period, so this holds
	// the unconditional one (see standingStatus).
	OperationalStatus string
	// VFR / IFR are true when at least one usage profile permits
	// the corresponding flight rule. Both can be true (mixed-rule
	// aerodrome); both false when the publisher omits the
	// FlightCharacteristic.
	VFR, IFR bool
	Runways  []Runway
	// Radio is the list of (frequency, raw service type, call sign)
	// triples reachable from Services whose clientAirport xlink points
	// at this aerodrome. RadioChannel.Unit holds the raw AIXM service
	// type for the per-country emitter to curate. Empty when no Service
	// references the aerodrome (e.g. ENAIRE Spain, which publishes none).
	Radio []RadioChannel
	// Notes is the AIP directory free text: the usage conditions,
	// operating remarks and site descriptions the publisher annotates
	// the feature with. The per-country emitters sort them by
	// PropertyName; see the aerodrome-facilities datasets.
	Notes []Note
	// Contacts is the operator and its telephone / online details.
	Contacts []Contact
	// Hours is the aerodrome's published operating schedule, rendered
	// by formatTimesheet ("H24", "MON-FRI 08:00-18:00"). Empty when the
	// publisher states no timeInterval.
	Hours []string
}

// Note is one decoded aixm:Note. PropertyName is the AIXM property the
// note annotates (usage / voice / timeInterval / ARP / type / ...) and
// is what lets an emitter file the text under the right heading; it is
// empty where the publisher leaves it out (ENAIRE mostly does).
type Note struct {
	PropertyName string
	Purpose      string
	Text         string
}

// Contact is one decoded aixm:ContactInformation: who runs the field
// and how to reach them.
type Contact struct {
	Name    string
	Address string
	// Phone / Fax carry the number with its published label, where the
	// publisher gives one ("01305-701702 (Admin)").
	Phone []string
	Fax   []string
	// Email and Web are the aixm:eMail addresses and aixm:linkage URLs,
	// verbatim (a mailto: linkage is left as published).
	Email []string
	Web   []string
}

// Runway is the decoded shape of one aixm:Runway feature. The
// designator is the combined "LE/HE" form (e.g. "09L/27R"); a
// single-direction RWY ("HEL") leaves He empty.
type Runway struct {
	ID         string
	Designator string // e.g. "09L/27R"
	Le, He     string // split halves
	LengthM    *float64
	WidthM     *float64
	// Surface is the aixm:composition value verbatim (CONC, ASPH,
	// GRASS, ...) so the SPA's formatSurface mapping can run on it.
	Surface string
	// Per-direction declared distances in metres. Folded in from
	// aixm:RunwayCentrelinePoint features by resolveRunways; nil
	// when the publisher omitted them (most are published as
	// TORA + LDA pairs per threshold). TODA / ASDA are tracked
	// when present but the per-country emitters currently expose
	// only TORA + LDA.
	LeLdaM, LeToraM, LeTodaM, LeAsdaM *float64
	HeLdaM, HeToraM, HeTodaM, HeAsdaM *float64
}

// Navaid is the decoded shape of one aixm:VOR / aixm:DME / aixm:NDB
// / aixm:TACAN / aixm:DesignatedPoint timeslice. Composite navaids
// (aixm:Navaid wrapping VOR + DME components) are folded by the
// post-stream resolution pass so the consumer sees one row per
// physical navaid.
type Navaid struct {
	ID string
	// Type is the SPA-facing type code (VOR, DME, NDB, TACAN,
	// VOR-DME, VORTAC, WAYPOINT). Mapped from the AIXM 5.1 element
	// kind plus any composite parent's aixm:type.
	Type       string
	Designator string
	Name       string
	Lat        float64
	Lon        float64
	// ElevM is the navaid elevation in metres (where AIXM publishes
	// one; only VOR/DME-class equipment carries elevation reliably).
	ElevM *float64
	// FreqMHz is the VHF frequency (VOR / DVOR). Nil otherwise.
	FreqMHz *float64
	// FreqKHz is the LF/MF frequency (NDB / Locator). Nil otherwise.
	FreqKHz *float64
	// Channel is the TACAN / DME channel ("103X", "94Y"). Empty
	// for pure VHF / LF equipment.
	Channel string
}

// Message bundles every BASELINE feature decoded from one
// AIXMBasicMessage payload, plus counters surfaced into the meta
// sidecar by callers.
type Message struct {
	// Effective is the message dateStamp (gmd:MD_Metadata >
	// gmd:dateStamp); the AIRAC effective date of the dataset is
	// usually the publication date or one cycle later, depending on
	// the source state. Empty if the source has no dateStamp.
	Effective          string
	Airspaces          []Airspace
	Obstacles          []Obstacle
	Airports           []Airport
	Navaids            []Navaid
	SkippedNonBaseline int
	UnresolvedXlinks   int
	// MultiPartObstacles counts VerticalStructure features with more
	// than one VerticalStructurePart; only the first part is decoded.
	MultiPartObstacles int
	// MultiComponentAirspaces counts Airspace timeslices with more
	// than one AirspaceGeometryComponent; each component is decoded
	// into its own Airspace row.
	MultiComponentAirspaces int
}
