// aixmsource.go reads an AIXM 5.1 dataset payload (NATS UK, ENAIRE ES)
// from a bare .xml file or the largest .xml member of a .zip. This is the
// AIXM 5.1 counterpart to ReadSource, which handles the SIA AIXM 4.5
// export layout (an aixm-prefixed member plus an optional SIA blob).

package aip

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ReadLargestXML opens path and returns its AIXM 5.1 XML bytes plus a
// short identifier (the inner filename for zips; the leaf basename for
// direct .xml inputs) used in meta sidecars. Publishers like NATS and
// ENAIRE bundle the AIP dataset XML alongside metadata XML and SHA-256
// checksums inside a zip; the largest .xml entry is reliably the dataset.
func ReadLargestXML(path string) (data []byte, name string, err error) {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".xml":
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, "", fmt.Errorf("read %s: %w", path, err)
		}
		return b, filepath.Base(path), nil
	case ".zip":
		return readLargestZipXML(path)
	default:
		return nil, "", fmt.Errorf("unrecognised -in extension %q (want .xml or .zip)", ext)
	}
}

// readLargestZipXML returns the largest .xml entry of a publisher zip.
// NATS bundles the AIP XML alongside metadata XML and SHA-256 checksums;
// the largest entry is reliably the dataset itself.
func readLargestZipXML(path string) ([]byte, string, error) {
	rc, err := zip.OpenReader(path)
	if err != nil {
		return nil, "", fmt.Errorf("open zip %s: %w", path, err)
	}
	defer rc.Close()

	var pick *zip.File
	for _, f := range rc.File {
		if !strings.EqualFold(filepath.Ext(f.Name), ".xml") {
			continue
		}
		if pick == nil || f.UncompressedSize64 > pick.UncompressedSize64 {
			pick = f
		}
	}
	if pick == nil {
		return nil, "", fmt.Errorf("zip %s has no .xml entries", path)
	}
	// Same MaxMemberSize guard readZipMember enforces on the AIXM 4.5
	// path: a malformed or hostile zip member must not decompress into
	// memory unbounded.
	if pick.UncompressedSize64 > MaxMemberSize {
		return nil, "", fmt.Errorf("member %s declares %d bytes, exceeds %d limit",
			pick.Name, pick.UncompressedSize64, MaxMemberSize)
	}

	fr, err := pick.Open()
	if err != nil {
		return nil, "", fmt.Errorf("open %s in zip: %w", pick.Name, err)
	}
	defer fr.Close()

	data, err := io.ReadAll(io.LimitReader(fr, MaxMemberSize+1))
	if err != nil {
		return nil, "", fmt.Errorf("read %s in zip: %w", pick.Name, err)
	}
	if int64(len(data)) > MaxMemberSize {
		return nil, "", fmt.Errorf("member %s exceeds %d byte limit", pick.Name, MaxMemberSize)
	}
	return data, filepath.Base(pick.Name), nil
}

// OpenLargestXML opens the largest .xml member of a zip as a stream,
// for a data set too large to hold in memory (Switzerland's obstacle
// export is half a gigabyte). A bare .xml path opens directly.
//
// The caller closes the returned ReadCloser. Unlike ReadLargestXML this
// enforces no size guard, because nothing is buffered: the decoder reads
// it as a token stream.
func OpenLargestXML(path string) (rc io.ReadCloser, name string, err error) {
	if strings.EqualFold(filepath.Ext(path), ".xml") {
		f, err := os.Open(path)
		if err != nil {
			return nil, "", err
		}
		return f, filepath.Base(path), nil
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, "", fmt.Errorf("open zip %s: %w", path, err)
	}
	var pick *zip.File
	for _, f := range zr.File {
		if !strings.EqualFold(filepath.Ext(f.Name), ".xml") {
			continue
		}
		if pick == nil || f.UncompressedSize64 > pick.UncompressedSize64 {
			pick = f
		}
	}
	if pick == nil {
		_ = zr.Close()
		return nil, "", fmt.Errorf("zip %s has no .xml entries", path)
	}
	fr, err := pick.Open()
	if err != nil {
		_ = zr.Close()
		return nil, "", fmt.Errorf("open %s in zip: %w", pick.Name, err)
	}
	// Closing the member must also close the archive.
	return zipStream{fr, zr}, filepath.Base(pick.Name), nil
}

// zipStream ties a member stream's lifetime to its archive's.
type zipStream struct {
	io.ReadCloser
	zr *zip.ReadCloser
}

func (m zipStream) Close() error {
	err := m.ReadCloser.Close()
	if zerr := m.zr.Close(); err == nil {
		err = zerr
	}
	return err
}
