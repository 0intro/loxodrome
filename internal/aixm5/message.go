package aixm5

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"strings"
)

// Decode parses an AIXM 5.1 / 5.1.1 BasicMessage from src and returns
// the decoded features. It is DecodeAll with a single source; see
// DecodeAll for the buffering and BASELINE-only semantics.
func Decode(src []byte) (*Message, error) {
	return DecodeAll(src)
}

// DecodeAll parses one or more AIXM 5.1 / 5.1.1 BasicMessages and
// returns the merged decoded features. Each message is fully buffered
// (callers size their inputs accordingly; UK NATS and ENAIRE
// publications run 50-300 MB uncompressed, comparable to the SIA
// AIXM 4.5 file the France pipeline already handles).
//
// Multiple sources are needed when a publisher splits one AIP dataset
// across per-feature-type files: DFS Germany ships AirportHeliport,
// Runway and Service as separate downloads, and the runway / radio
// resolution below must see all three at once to attach runways and
// frequencies to their parent airport by xlink. Streaming accumulates
// every source's members first; resolution then runs a single time
// over the combined set.
//
// Only BASELINE timeslices are decoded; SNAPSHOT / PERMDELTA /
// TEMPDELTA entries are counted into Message.SkippedNonBaseline and
// skipped. The caller surfaces these counters into per-country meta
// sidecars so upstream schema drift is visible. When sources carry
// different messageMetadata dateStamps the first non-empty one wins
// (callers that care about the effective date pass it explicitly).
func DecodeAll(srcs ...[]byte) (*Message, error) {
	rs := make([]io.Reader, 0, len(srcs))
	for _, src := range srcs {
		rs = append(rs, bytes.NewReader(src))
	}
	return DecodeReaders(rs...)
}

// DecodeReaders is DecodeAll over streams rather than buffers, for a
// source too large to hold twice. Switzerland's obstacle data set is
// half a gigabyte of XML; the decoder was always a token stream, so
// reading it as one costs nothing and keeps the whole file out of
// memory.
func DecodeReaders(rs ...io.Reader) (*Message, error) {
	msg := &Message{}
	rawR := &rawRunways{}
	rawN := &rawNavaids{}
	rawS := &rawServices{}
	for _, r := range rs {
		if err := streamMembers(r, msg, rawR, rawN, rawS); err != nil {
			return nil, err
		}
	}

	// Post-stream resolution: link runways to their parent airports
	// and fold navaid equipment into composite groups (VOR-DME,
	// VORTAC, ...). Service / radio resolution attaches the radio
	// triples to every airspace any Service references.
	resolveRunways(msg, rawR)
	resolveNavaids(msg, rawN)
	resolveAirspaceRadios(msg, rawS)
	resolveAirportRadios(msg, rawS)

	return msg, nil
}

// streamMembers tokenises one AIXMBasicMessage source and dispatches
// its <hasMember> children into msg and the runway / navaid / service
// accumulators, without running the post-stream resolution (the caller
// does that once across all sources).
func streamMembers(src io.Reader, msg *Message, rawR *rawRunways, rawN *rawNavaids, rawS *rawServices) error {
	dec := xml.NewDecoder(src)
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("reading XML: %w", err)
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		switch se.Name.Local {
		case "AIXMBasicMessage":
			// Pass-through; descend into children.
			continue
		case "messageMetadata":
			if effective, err := readMessageDateStamp(dec, &se); err != nil {
				return fmt.Errorf("messageMetadata: %w", err)
			} else if effective != "" && msg.Effective == "" {
				msg.Effective = effective
			}
		case "hasMember":
			if err := decodeHasMember(dec, msg, rawR, rawN, rawS); err != nil {
				return fmt.Errorf("hasMember: %w", err)
			}
		default:
			if err := dec.Skip(); err != nil {
				return fmt.Errorf("skipping <%s>: %w", se.Name.Local, err)
			}
		}
	}
	return nil
}

// decodeHasMember reads one <message:hasMember> child and dispatches
// on the wrapped feature type. Runway and navaid-equipment dispatch
// pass through accumulator state so the resolution pass after
// streaming can build composites.
func decodeHasMember(dec *xml.Decoder, msg *Message, rawR *rawRunways, rawN *rawNavaids, rawS *rawServices) error {
	for {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		switch v := tok.(type) {
		case xml.StartElement:
			switch v.Name.Local {
			case "Airspace":
				if err := decodeAirspaceFeature(dec, &v, msg); err != nil {
					return fmt.Errorf("Airspace: %w", err)
				}
			case "VerticalStructure":
				if err := decodeObstacleFeature(dec, &v, msg); err != nil {
					return fmt.Errorf("VerticalStructure: %w", err)
				}
			case "AirportHeliport":
				if err := decodeAirportHeliportFeature(dec, &v, msg); err != nil {
					return fmt.Errorf("AirportHeliport: %w", err)
				}
			case "Runway":
				if err := decodeRunwayFeature(dec, &v, msg, rawR); err != nil {
					return fmt.Errorf("Runway: %w", err)
				}
			case "RunwayDirection":
				if err := decodeRunwayDirectionFeature(dec, &v, msg, rawR); err != nil {
					return fmt.Errorf("RunwayDirection: %w", err)
				}
			case "RunwayCentrelinePoint":
				if err := decodeRunwayCentrelinePointFeature(dec, &v, msg, rawR); err != nil {
					return fmt.Errorf("RunwayCentrelinePoint: %w", err)
				}
			case "VOR":
				if err := decodeVORFeature(dec, &v, rawN, msg); err != nil {
					return fmt.Errorf("VOR: %w", err)
				}
			case "DME":
				if err := decodeDMEFeature(dec, &v, rawN, msg); err != nil {
					return fmt.Errorf("DME: %w", err)
				}
			case "NDB":
				if err := decodeNDBFeature(dec, &v, rawN, msg); err != nil {
					return fmt.Errorf("NDB: %w", err)
				}
			case "TACAN":
				if err := decodeTACANFeature(dec, &v, rawN, msg); err != nil {
					return fmt.Errorf("TACAN: %w", err)
				}
			case "DesignatedPoint":
				if err := decodeDesignatedPointFeature(dec, &v, rawN, msg); err != nil {
					return fmt.Errorf("DesignatedPoint: %w", err)
				}
			case "Navaid":
				if err := decodeNavaidGroupFeature(dec, &v, rawN, msg); err != nil {
					return fmt.Errorf("Navaid: %w", err)
				}
			case "AirTrafficControlService":
				if err := decodeAirTrafficControlServiceFeature(dec, &v, msg, rawS); err != nil {
					return fmt.Errorf("AirTrafficControlService: %w", err)
				}
			case "InformationService":
				if err := decodeInformationServiceFeature(dec, &v, msg, rawS); err != nil {
					return fmt.Errorf("InformationService: %w", err)
				}
			case "AirTrafficManagementService":
				if err := decodeAirTrafficManagementServiceFeature(dec, &v, msg, rawS); err != nil {
					return fmt.Errorf("AirTrafficManagementService: %w", err)
				}
			case "RadioCommunicationChannel":
				if err := decodeRadioCommunicationChannelFeature(dec, &v, msg, rawS); err != nil {
					return fmt.Errorf("RadioCommunicationChannel: %w", err)
				}
			default:
				if err := dec.Skip(); err != nil {
					return fmt.Errorf("skipping <%s>: %w", v.Name.Local, err)
				}
			}
		case xml.EndElement:
			if v.Name.Local == "hasMember" {
				return nil
			}
		}
	}
}

// readMessageDateStamp walks the messageMetadata subtree, returning
// the first gmd:dateStamp/gco:DateTime value (the message
// publication date). Other metadata is skipped.
func readMessageDateStamp(dec *xml.Decoder, start *xml.StartElement) (string, error) {
	for {
		tok, err := dec.Token()
		if err != nil {
			return "", err
		}
		switch v := tok.(type) {
		case xml.StartElement:
			if v.Name.Local == "dateStamp" {
				val, err := readChardataLeaf(dec)
				if err != nil {
					return "", err
				}
				// Skip the rest of messageMetadata.
				if val != "" {
					if err := skipUntilEnd(dec); err != nil {
						return "", err
					}
					return val, nil
				}
			}
		case xml.EndElement:
			if v.Name.Local == start.Name.Local {
				return "", nil
			}
		}
	}
}

// readChardataLeaf reads the accumulated CharData of the element the
// decoder is inside, including trivially-nested children. Used for
// <gmd:dateStamp><gco:DateTime>X</...></...>: returns "X".
func readChardataLeaf(dec *xml.Decoder) (string, error) {
	var buf strings.Builder
	depth := 1
	for depth > 0 {
		tok, err := dec.Token()
		if err != nil {
			return "", err
		}
		switch v := tok.(type) {
		case xml.StartElement:
			depth++
		case xml.EndElement:
			depth--
		case xml.CharData:
			buf.Write(v)
		}
	}
	return strings.TrimSpace(buf.String()), nil
}

// skipUntilEnd advances past the end-tag closing the element the
// decoder is currently inside.
func skipUntilEnd(dec *xml.Decoder) error {
	depth := 1
	for depth > 0 {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		switch tok.(type) {
		case xml.StartElement:
			depth++
		case xml.EndElement:
			depth--
		}
	}
	return nil
}

// stripUUIDPrefix turns a gml:id like "uuid.<UUID>" into "<UUID>".
// Some publishers omit the prefix; the function is a no-op in that
// case.
func stripUUIDPrefix(id string) string {
	return strings.TrimPrefix(id, "uuid.")
}

// featureIdentifier picks the cross-reference key for a feature.
//
// Donlon embeds the UUID in gml:id ("uuid.<UUID>") and leaves
// <gml:identifier> as a duplicate. NATS UK uses an arbitrary
// "id<N>" gml:id and puts the UUID exclusively in
// <gml:identifier codeSpace="urn:uuid:">. xlink:href across both
// publishers references the UUID, so we prefer the identifier when
// present and fall back to the de-prefixed gml:id otherwise.
func featureIdentifier(gmlID, identifier string) string {
	if id := strings.TrimSpace(identifier); id != "" {
		return id
	}
	return stripUUIDPrefix(gmlID)
}
