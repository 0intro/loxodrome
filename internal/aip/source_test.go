package aip

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type zipMember struct{ name, content string }

// writeZip builds a zip at path with members in the given order (insertion
// order is deterministic, unlike a map, which matters for the duplicate-AIXM
// case).
func writeZip(t *testing.T, path string, members []zipMember) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	for _, m := range members {
		w, err := zw.Create(m.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(m.content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestReadSource(t *testing.T) {
	dir := t.TempDir()

	// Bare .xml: AIXM bytes through, no SIA blob.
	xmlPath := filepath.Join(dir, "AIXM_4.5.xml")
	if err := os.WriteFile(xmlPath, []byte("<aixm/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	aixm, sia, name, err := ReadSource(xmlPath)
	if err != nil || string(aixm) != "<aixm/>" || sia != nil || name != "AIXM_4.5.xml" {
		t.Errorf("ReadSource(.xml) = %q, sia=%v, %q, %v", aixm, sia, name, err)
	}

	// Neither .xml nor .zip.
	if _, _, _, err := ReadSource(filepath.Join(dir, "x.txt")); err == nil {
		t.Error("ReadSource(.txt) expected an error")
	}

	// SIA export zip: AIXM + SIA members, name is the AIXM member basename.
	zipPath := filepath.Join(dir, "export.zip")
	writeZip(t, zipPath, []zipMember{
		{"AIXM_4.5_FR.xml", "<aixm-data/>"},
		{"XML_SIA_FR.xml", "<sia-data/>"},
		{"readme.txt", "ignored"},
	})
	aixm, sia, name, err = ReadSource(zipPath)
	if err != nil {
		t.Fatalf("ReadSource(zip): %v", err)
	}
	if string(aixm) != "<aixm-data/>" || string(sia) != "<sia-data/>" || name != "AIXM_4.5_FR.xml" {
		t.Errorf("ReadSource(zip) = %q / %q / %q", aixm, sia, name)
	}

	// AIXM only: SIA blob absent.
	aixmOnly := filepath.Join(dir, "aixm-only.zip")
	writeZip(t, aixmOnly, []zipMember{{"AIXM_x.xml", "<a/>"}})
	if _, sia, _, err := ReadSource(aixmOnly); err != nil || sia != nil {
		t.Errorf("ReadSource(aixm-only) sia=%v err=%v, want nil/nil", sia, err)
	}

	// No AIXM member.
	noAixm := filepath.Join(dir, "no-aixm.zip")
	writeZip(t, noAixm, []zipMember{{"data.xml", "<x/>"}})
	if _, _, _, err := ReadSource(noAixm); err == nil {
		t.Error("ReadSource(no-aixm) expected an error")
	}

	// Duplicate AIXM members.
	dup := filepath.Join(dir, "dup-aixm.zip")
	writeZip(t, dup, []zipMember{{"AIXM_a.xml", "<a/>"}, {"AIXM_b.xml", "<b/>"}})
	if _, _, _, err := ReadSource(dup); err == nil || !strings.Contains(err.Error(), "multiple") {
		t.Errorf("ReadSource(dup) err = %v, want a 'multiple' error", err)
	}
}

func TestReadLargestXML(t *testing.T) {
	dir := t.TempDir()

	// Two .xml of different sizes: the larger one is the dataset.
	zipPath := filepath.Join(dir, "data.zip")
	writeZip(t, zipPath, []zipMember{
		{"small.xml", "<s/>"},
		{"big.xml", strings.Repeat("<big/>", 100)},
		{"meta.txt", "ignored"},
	})
	data, name, err := ReadLargestXML(zipPath)
	if err != nil {
		t.Fatalf("ReadLargestXML: %v", err)
	}
	if name != "big.xml" || !strings.HasPrefix(string(data), "<big/>") {
		t.Errorf("ReadLargestXML picked %q (%d bytes), want big.xml", name, len(data))
	}

	// No .xml entry.
	noXML := filepath.Join(dir, "noxml.zip")
	writeZip(t, noXML, []zipMember{{"a.txt", "x"}})
	if _, _, err := ReadLargestXML(noXML); err == nil {
		t.Error("ReadLargestXML(no-xml) expected an error")
	}

	// Bare .xml.
	xmlPath := filepath.Join(dir, "bare.xml")
	if err := os.WriteFile(xmlPath, []byte("<bare/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	data, name, err = ReadLargestXML(xmlPath)
	if err != nil || string(data) != "<bare/>" || name != "bare.xml" {
		t.Errorf("ReadLargestXML(.xml) = %q / %q / %v", data, name, err)
	}

	// Unrecognised extension.
	if _, _, err := ReadLargestXML(filepath.Join(dir, "x.txt")); err == nil {
		t.Error("ReadLargestXML(.txt) expected an error")
	}
}
