package main

import (
	"reflect"
	"testing"
	"time"
)

// excerpt mimics pdftotext -layout output: rows of each of the order's
// three catalogue sorts (Appendix A by designator / B by manufacturer / C
// by model), all four Class words, the asterisk marker (single-piloted
// military turbojet, stripped: not part of the designator), the @ / $
// amphibian and seaplane class marks, a jammed "class engine" cell, the
// "(any manufacturer)" generics, a centre-wrapped Appendix C manufacturer
// (BOEING / MCDONNELL DOUGLAS around MD-11, recovered via Appendix B), a
// deep-indent continuation row, a duplicated by-model row, and header /
// footer / prose lines the parser must ignore.
const excerpt = `                                Aircraft Type Designators
Type Designator      Class          Number of Engines   Weight
  DR40       Fixed-wing     1P/S     Light    I     I           ROBIN, DR-400 Major
  EC35       Helicopter     2T/S     Light    I     I           AIRBUS HELICOPTERS, EC-135
  CDUS       Gyroplane      1P/S     Light    I     I           AUTOGYRO, Calidus
  V22        Powered-lift   2T/S     Heavy    H     H           BELL BOEING, V-22 Osprey
  A10*       Fixed-wing     2J/L    Medium    G     III
  CE22       @Fixed-wing    2P/S     Light    I     II          AAK, VNS-41
                                    Appendix B. Encode - Aircraft Manufacturer
MANUFACTURER
   Model(s)
(any manufacturer)
    Balloon                                               BALL
    Glider                                                GLID
AAK
   VNS-41                                                 CE22       @Fixed-wing     2P/S      Light    I   II
BOEING
   MD-11                     MD11       Fixed-wing     3J/H       Heavy         C   III   9
   Sea Otter                 SOTT       $Fixed-wing 1P/S      Light    I   I
4/10/25                                                              JO 7360.1K
                             Appendix C. Decode - Aircraft Model
DR-400 2+2              ROBIN                DR40        Fixed-wing   1P/S      Light    I   I
DR-400 2+2              ROBIN                DR40        Fixed-wing   1P/S      Light    I   I
PA-28-181 Archer II     PIPER                P28A        Fixed-wing   1P/S      Light    I   I
A-10 Thunderbolt 2      FAIRCHILD (1)        A10*        Fixed-wing   2J/L      Medium   G   III
                        BOEING
MD-11                                              MD11        Fixed-wing   3J/H        Heavy        C   III   9
                        MCDONNELL DOUGLAS
  DR-400 Major                    DR40       Fixed-wing     1P/S     Light    I   I
                                           P28A       Fixed-wing     1P/S     Light    I    1
The Gyroplane class includes rotorcraft with unpowered rotors.
`

func TestParseText(t *testing.T) {
	codes, tuples, err := parseText(excerpt)
	if err != nil {
		t.Fatal(err)
	}
	wantCodes := []string{"A10", "BALL", "CDUS", "CE22", "DR40", "EC35", "GLID", "MD11", "P28A", "SOTT", "V22"}
	if !reflect.DeepEqual(codes, wantCodes) {
		t.Errorf("codes = %v, want %v", codes, wantCodes)
	}
	wantTuples := []Tuple{
		{Designator: "A10", Manufacturer: "FAIRCHILD (1)", Model: "A-10 Thunderbolt 2"},
		{Designator: "BALL", Manufacturer: "(any manufacturer)", Model: "Balloon"},
		{Designator: "CE22", Manufacturer: "AAK", Model: "VNS-41"},
		{Designator: "DR40", Manufacturer: "ROBIN", Model: "DR-400 2+2"},
		{Designator: "GLID", Manufacturer: "(any manufacturer)", Model: "Glider"},
		{Designator: "MD11", Manufacturer: "BOEING", Model: "MD-11"},
		{Designator: "P28A", Manufacturer: "PIPER", Model: "PA-28-181 Archer II"},
		{Designator: "SOTT", Manufacturer: "BOEING", Model: "Sea Otter"},
	}
	if !reflect.DeepEqual(tuples, wantTuples) {
		t.Errorf("tuples = %v, want %v", tuples, wantTuples)
	}
}

func TestParseTextMissingAppendixB(t *testing.T) {
	if _, _, err := parseText("no appendix headings here"); err == nil {
		t.Error("expected an error when the Appendix B bounds are missing")
	}
}

func TestBuildArtifact(t *testing.T) {
	res, err := buildArtifact(excerpt, Options{
		Edition:        "JO 7360.1K",
		Effective:      "2025-04-10",
		Source:         "https://example.test/7360.1",
		MinDesignators: 1,
		MaxDesignators: 20,
		MinModels:      1,
		MaxModels:      20,
		Now:            func() time.Time { return time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := res.Meta.DesignatorCount, 11; got != want {
		t.Errorf("DesignatorCount = %d, want %d", got, want)
	}
	if got, want := res.Meta.ModelCount, 8; got != want {
		t.Errorf("ModelCount = %d, want %d", got, want)
	}
	if got, want := res.Meta.GeneratedAt, "2026-07-12T12:00:00.000Z"; got != want {
		t.Errorf("GeneratedAt = %q, want %q", got, want)
	}
	if got, want := res.Meta.License, "Public domain (US Government work, 17 U.S.C. 105)"; got != want {
		t.Errorf("License = %q, want %q", got, want)
	}
	if got, want := res.Artifact.Types[0], [3]string{"A10", "FAIRCHILD (1)", "A-10 Thunderbolt 2"}; got != want {
		t.Errorf("Types[0] = %v, want %v", got, want)
	}
	// EC35, CDUS and V22 appear only in by-designator rows here, so they
	// carry no model tuple; they stay in the designator set regardless.
	if got, want := codesWithoutTuples(res.Artifact), []string{"CDUS", "EC35", "V22"}; !reflect.DeepEqual(got, want) {
		t.Errorf("codesWithoutTuples = %v, want %v", got, want)
	}
}

func TestBuildArtifactSanityWindow(t *testing.T) {
	if _, err := buildArtifact(excerpt, Options{MinDesignators: 1, MaxDesignators: 20, MinModels: 9, MaxModels: 20}); err == nil {
		t.Error("expected the model-count sanity window to reject 8 tuples")
	}
	if _, err := buildArtifact(excerpt, Options{MinDesignators: 12, MaxDesignators: 20, MinModels: 1, MaxModels: 20}); err == nil {
		t.Error("expected the designator-count sanity window to reject 11 codes")
	}
}
