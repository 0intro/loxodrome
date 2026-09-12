// Package docpack reads and writes the AIP document pack: one file holding
// every PDF of one document set (the Atlas VAC plates, the AIP supplements
// in force), with an index at the head so a reader can slice one document
// out without touching the rest.
//
// The shape exists because the SIA serves its PDFs without CORS, without a
// Content-Length, without an ETag, and ignoring Range: a device cannot
// fetch them at all, and no relay could offer a size, a resume or an
// update check. Packing the set once per build moves all of that onto R2,
// which answers every one of them, so the client reuses the chart-pack
// download whole (internal contract in docs/offline-maps.md).
//
//	0    : magic "LOXDOCS1"           8 bytes
//	8    : index length, uint32 LE    4 bytes
//	12   : index JSON                 n bytes
//	12+n : payloads, concatenated
//
// Entry offsets are relative to the START OF THE PAYLOAD AREA, not to the
// file. Absolute offsets would depend on the length of the index that
// carries them, which depends on how many digits those offsets take: a
// circle only breakable by padding the index or by iterating to a fixed
// point. Payload-relative offsets have no such dependency, and a reader
// that has parsed the header knows the base anyway.
//
// A pack is byte-deterministic for a given input: entries are written in
// sorted name order and nothing in the file records when it was built. A
// build stamp would change the object's ETag on every run and tell every
// user an update was waiting for a pack identical to the one they hold.
package docpack

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
)

// Magic opens every pack, and is what tells a truncated or misrouted
// download from a real one before any offset is trusted.
const Magic = "LOXDOCS1"

// HeaderSize is the magic plus the uint32 index length.
const HeaderSize = len(Magic) + 4

// MaxIndexBytes bounds the index a reader will accept, so a corrupt length
// field cannot make it allocate wildly. The Atlas VAC's 656 entries come to
// about 30 KB.
const MaxIndexBytes = 8 << 20

// Entry locates one document inside the payload area. It marshals as the
// two-element array [offset, length], which keeps a 656-entry index small
// and readable at once.
type Entry struct {
	Offset int64
	Length int64
}

func (e Entry) MarshalJSON() ([]byte, error) {
	return json.Marshal([2]int64{e.Offset, e.Length})
}

func (e *Entry) UnmarshalJSON(b []byte) error {
	var pair [2]int64
	if err := json.Unmarshal(b, &pair); err != nil {
		return err
	}
	e.Offset, e.Length = pair[0], pair[1]
	return nil
}

// Meta is everything in the index that is not an entry: which set this is,
// which AIRAC cycle it was cut from, and what the build could not fetch.
type Meta struct {
	// Set names the document set ("fr-vac", "fr-sup").
	Set string `json:"set"`
	// Cycle is the SIA eAIP date segment ("06_AUG_2026") for a
	// cycle-stamped set, empty for one whose URLs do not rotate. It is
	// what the UI shows and what a superseded badge names.
	Cycle string `json:"cycle,omitempty"`
	// Effective is the cycle's AIRAC date ("2026-08-06"), the field the
	// client hands to pickActiveDataset to choose between a held current
	// and a held pre-release pack exactly as it chooses a dataset slot.
	Effective string `json:"effective,omitempty"`
	// Lang is the language a single-language set was cut in ("fr" / "en").
	Lang string `json:"lang,omitempty"`
	// Missing names the documents the source did not serve. Recorded
	// rather than hidden: a plate absent from the pack is a plate the
	// panel must not claim to hold offline.
	Missing []string `json:"missing,omitempty"`
}

// Index is the whole head of a pack.
type Index struct {
	Meta
	Entries map[string]Entry `json:"entries"`
}

// Doc is one document to pack: the name it answers to and the file holding
// its bytes.
type Doc struct {
	Name string
	Path string
}

// Write assembles a pack from docs already on disk. Docs are written in
// sorted name order, so the same inputs always produce the same bytes.
func Write(dst io.Writer, meta Meta, docs []Doc) error {
	ordered := append([]Doc(nil), docs...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Name < ordered[j].Name })

	index := Index{Meta: meta, Entries: make(map[string]Entry, len(ordered))}
	var offset int64
	for _, d := range ordered {
		info, err := os.Stat(d.Path)
		if err != nil {
			return fmt.Errorf("stat %s: %w", d.Name, err)
		}
		index.Entries[d.Name] = Entry{Offset: offset, Length: info.Size()}
		offset += info.Size()
	}

	body, err := json.Marshal(index)
	if err != nil {
		return fmt.Errorf("marshal index: %w", err)
	}
	header := make([]byte, HeaderSize)
	copy(header, Magic)
	binary.LittleEndian.PutUint32(header[len(Magic):], uint32(len(body)))
	if _, err := dst.Write(header); err != nil {
		return err
	}
	if _, err := dst.Write(body); err != nil {
		return err
	}

	for _, d := range ordered {
		if err := copyFile(dst, d.Path); err != nil {
			return fmt.Errorf("pack %s: %w", d.Name, err)
		}
	}
	return nil
}

func copyFile(dst io.Writer, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(dst, f)
	return err
}

// ReadIndex parses a pack's head, returning the index and the offset its
// entries are measured from. It reads only the header and the index, so it
// works over a ranged fetch of the first few tens of kilobytes, which is
// how the CI prune inspects a pre-release object still sitting in R2.
func ReadIndex(r io.ReaderAt) (*Index, int64, error) {
	header := make([]byte, HeaderSize)
	if _, err := r.ReadAt(header, 0); err != nil {
		return nil, 0, fmt.Errorf("read header: %w", err)
	}
	if string(header[:len(Magic)]) != Magic {
		return nil, 0, fmt.Errorf("not a document pack (bad magic)")
	}
	n := binary.LittleEndian.Uint32(header[len(Magic):])
	if n == 0 || n > MaxIndexBytes {
		return nil, 0, fmt.Errorf("index length %d out of range", n)
	}
	body := make([]byte, n)
	if _, err := r.ReadAt(body, int64(HeaderSize)); err != nil {
		return nil, 0, fmt.Errorf("read index: %w", err)
	}
	var index Index
	if err := json.Unmarshal(body, &index); err != nil {
		return nil, 0, fmt.Errorf("parse index: %w", err)
	}
	if index.Entries == nil {
		index.Entries = map[string]Entry{}
	}
	return &index, int64(HeaderSize) + int64(n), nil
}
