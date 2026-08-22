// source.go reads the SIA export. Accepts a SIA .zip (which carries an
// AIXM<...>.xml plus an optional XML_SIA_*.xml) or a bare AIXM .xml.

package aip

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// MaxMemberSize caps the AIXM member read out of a ZIP, guarding against
// a malformed or hostile archive.
const MaxMemberSize = 512 << 20 // 512 MiB

// ReadSource resolves a -in path to the AIXM XML bytes plus (when the
// input is a SIA export zip) the optional SIA proprietary XML bytes. A
// direct .xml path returns nil for sia; callers that need it fall back
// to the AIXM-only behaviour.
//
// `name` is the logical source filename (the AIXM member's base name
// when input is a zip, or the file's base name when input is an .xml).
func ReadSource(path string) (aixm, sia []byte, name string, err error) {
	lower := strings.ToLower(path)
	switch {
	case strings.HasSuffix(lower, ".xml"):
		aixm, err = os.ReadFile(path)
		if err != nil {
			return nil, nil, "", err
		}
		return aixm, nil, filepath.Base(path), nil
	case strings.HasSuffix(lower, ".zip"):
		return readZip(path)
	default:
		return nil, nil, "", fmt.Errorf("-in must be a .zip or .xml file: %s", path)
	}
}

// readZip locates and reads the AIXM XML member and (when present) the
// SIA proprietary XML member of an SIA export ZIP without extracting to
// disk. The SIA blob is optional.
func readZip(path string) ([]byte, []byte, string, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, nil, "", err
	}
	defer zr.Close()

	var aixmFile, siaFile *zip.File
	var aixmDups []string
	for _, f := range zr.File {
		base := strings.ToLower(filepath.Base(f.Name))
		switch {
		case strings.HasPrefix(base, "aixm") && strings.HasSuffix(base, ".xml"):
			if aixmFile == nil {
				aixmFile = f
			} else {
				aixmDups = append(aixmDups, f.Name)
			}
		case strings.HasPrefix(base, "xml_sia") && strings.HasSuffix(base, ".xml"):
			// First match wins; multi-SIA archives are unheard of.
			if siaFile == nil {
				siaFile = f
			}
		}
	}
	if aixmFile == nil {
		return nil, nil, "", fmt.Errorf("no AIXM .xml member found in %s", path)
	}
	if len(aixmDups) > 0 {
		return nil, nil, "", fmt.Errorf("multiple AIXM members in %s: %s, %s",
			path, aixmFile.Name, strings.Join(aixmDups, ", "))
	}

	aixm, err := readZipMember(aixmFile)
	if err != nil {
		return nil, nil, "", err
	}
	var sia []byte
	if siaFile != nil {
		sia, err = readZipMember(siaFile)
		if err != nil {
			return nil, nil, "", err
		}
	}
	return aixm, sia, filepath.Base(aixmFile.Name), nil
}

// readZipMember slurps a single zip member into memory, enforcing the
// MaxMemberSize limit.
func readZipMember(f *zip.File) ([]byte, error) {
	if f.UncompressedSize64 > MaxMemberSize {
		return nil, fmt.Errorf("member %s declares %d bytes, exceeds %d limit",
			f.Name, f.UncompressedSize64, MaxMemberSize)
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, MaxMemberSize+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > MaxMemberSize {
		return nil, fmt.Errorf("member %s exceeds %d byte limit", f.Name, MaxMemberSize)
	}
	return data, nil
}
