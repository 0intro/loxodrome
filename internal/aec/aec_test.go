package aec

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type vector struct {
	File   string `json:"file"`
	Bits   int    `json:"bits"`
	Block  int    `json:"block"`
	RSI    int    `json:"rsi"`
	Flags  Flags  `json:"flags"`
	N      int    `json:"n"`
	Kind   string `json:"kind"`
	SHA256 string `json:"sha256"`
}

func samplesHash(s []uint32) string {
	b := make([]byte, 4*len(s))
	for i, v := range s {
		binary.LittleEndian.PutUint32(b[4*i:], v)
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// The vectors are streams libaec encoded (testdata/libaec_oracle.py), over
// every flag, every identifier length and every coding option; the
// expected samples are the encoder's input.
func TestLibaecVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/vectors/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []vector `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Cases) < 100 {
		t.Fatalf("only %d vectors", len(doc.Cases))
	}
	for _, c := range doc.Cases {
		src, err := os.ReadFile(filepath.Join("testdata/vectors", c.File))
		if err != nil {
			t.Fatal(err)
		}
		p := Params{BitsPerSample: c.Bits, BlockSize: c.Block, RSI: c.RSI, Flags: c.Flags}
		got, err := Decode(src, c.N, p)
		if err != nil {
			t.Errorf("%s (%d bits, block %d, rsi %d, flags %d, %s): %v", c.File, c.Bits, c.Block, c.RSI, c.Flags, c.Kind, err)
			continue
		}
		if h := samplesHash(got); h != c.SHA256 {
			t.Errorf("%s (%d bits, block %d, rsi %d, flags %d, %s): samples differ", c.File, c.Bits, c.Block, c.RSI, c.Flags, c.Kind)
		}
	}
}

func TestParamsRefused(t *testing.T) {
	for _, p := range []Params{
		{BitsPerSample: 0, BlockSize: 32, RSI: 128},
		{BitsPerSample: 33, BlockSize: 32, RSI: 128},
		{BitsPerSample: 16, BlockSize: 12, RSI: 128},
		{BitsPerSample: 16, BlockSize: 7, RSI: 128, Flags: NotEnforce},
		{BitsPerSample: 16, BlockSize: 32, RSI: 0},
		{BitsPerSample: 16, BlockSize: 32, RSI: 4097},
		{BitsPerSample: 6, BlockSize: 32, RSI: 128, Flags: Restricted},
	} {
		if _, err := Decode([]byte{0}, 1, p); err == nil {
			t.Errorf("%+v accepted", p)
		}
	}
}

func TestTruncatedStreamRefused(t *testing.T) {
	// An uncompressed 16-bit block (identifier 15) asking for more samples
	// than its bytes hold.
	p := Params{BitsPerSample: 16, BlockSize: 8, RSI: 1, Flags: DataPreprocess}
	src := []byte{0xF0, 0, 0, 0}
	if _, err := Decode(src, 8, p); err == nil {
		t.Fatal("truncated stream decoded")
	}
}

// TestParamsCheckedBeforeAllocating: an invalid stream never gets its
// sample buffer, however many samples it claims.
func TestParamsCheckedBeforeAllocating(t *testing.T) {
	if _, err := Decode(nil, 1<<40, Params{BitsPerSample: 16, BlockSize: 7, RSI: 128}); err == nil {
		t.Fatal("an invalid block size decoded")
	}
	if _, err := Decode(nil, -1, Params{BitsPerSample: 16, BlockSize: 32, RSI: 128, Flags: DataPreprocess}); err == nil {
		t.Fatal("a negative count decoded")
	}
}
