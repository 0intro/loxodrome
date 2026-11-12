// Package aec decodes Adaptive Entropy Coding, the lossless compression of
// CCSDS 121.0-B (Rice coding with a unit-delay predictor) that GRIB2's
// data representation template 5.42 carries. It reads exactly what libaec
// writes, flag for flag, and is pinned against libaec itself
// (testdata/libaec_oracle.py): Météo-France's AROME and ARPEGE and
// ECMWF's open data all pack their fields this way.
//
// The coded stream is a run of BLOCKS of BlockSize samples grouped into
// reference sample intervals of RSI blocks. Each block opens on an option
// identifier: the low-entropy options (a run of all-zero blocks, or the
// second extension coding pairs of small values together), the split-sample
// options (a fundamental sequence for each sample's high bits followed by
// its k low bits verbatim), or no compression. With preprocessing, the first
// block of every interval opens on a raw reference sample and the rest are
// predictor residuals folded into non-negative integers, unfolded here.
package aec

import (
	"errors"
	"fmt"
	"math/bits"
)

// Flags are libaec's own option bits, which GRIB2 stores verbatim in the
// template's "CCSDS compression options mask".
type Flags uint8

const (
	DataSigned     Flags = 1  // samples are two's complement
	Data3Byte      Flags = 2  // 17..24-bit samples take three bytes (output layout only)
	DataMSB        Flags = 4  // most significant byte first (output layout only)
	DataPreprocess Flags = 8  // unit-delay predictor and folding
	Restricted     Flags = 16 // the restricted identifier set for 1..4-bit samples
	PadRSI         Flags = 32 // each interval starts on a byte boundary
	NotEnforce     Flags = 64 // any even block size
)

// Params describe one coded stream.
type Params struct {
	BitsPerSample int // 1..32
	BlockSize     int // 8, 16, 32 or 64 (any even size under NotEnforce)
	RSI           int // blocks per reference sample interval, 1..4096
	Flags         Flags
}

// ErrData reports a stream that does not decode: it ends early, or holds an
// option the parameters cannot have produced.
var ErrData = errors.New("aec: corrupt or truncated stream")

// rosCode is the fundamental sequence value standing for "the rest of the
// segment" in a zero-block run; segments are 64 blocks.
const rosCode = 5

// seTable maps a second-extension codeword m to the pair sum and the first
// codeword of that sum: m = sum*(sum+1)/2 + d1. libaec stops at 90.
var seSum, seStart [91]uint32

func init() {
	k := 0
	for i := 0; i < 13; i++ {
		ms := k
		for j := 0; j <= i; j++ {
			seSum[k] = uint32(i)
			seStart[k] = uint32(ms)
			k++
		}
	}
}

func (p Params) validate() (idLen int, err error) {
	n := p.BitsPerSample
	if n < 1 || n > 32 {
		return 0, fmt.Errorf("aec: %d bits per sample", n)
	}
	if p.Flags&NotEnforce != 0 {
		if p.BlockSize < 2 || p.BlockSize&1 != 0 {
			return 0, fmt.Errorf("aec: block size %d", p.BlockSize)
		}
	} else if p.BlockSize != 8 && p.BlockSize != 16 && p.BlockSize != 32 && p.BlockSize != 64 {
		return 0, fmt.Errorf("aec: block size %d", p.BlockSize)
	}
	if p.RSI < 1 || p.RSI > 4096 {
		return 0, fmt.Errorf("aec: reference sample interval %d", p.RSI)
	}
	switch {
	case n > 16:
		return 5, nil
	case n > 8:
		return 4, nil
	case p.Flags&Restricted != 0:
		if n <= 2 {
			return 1, nil
		}
		if n <= 4 {
			return 2, nil
		}
		return 0, fmt.Errorf("aec: restricted coding of %d-bit samples", n)
	default:
		return 3, nil
	}
}

// bitReader serves the stream most significant bit first. acc holds n
// valid bits left-aligned and zeros below them.
type bitReader struct {
	src  []byte
	pos  int
	acc  uint64
	n    uint
	over bool // a read ran past the end of src
}

func (r *bitReader) fill() {
	for r.n <= 56 && r.pos < len(r.src) {
		r.acc |= uint64(r.src[r.pos]) << (56 - r.n)
		r.pos++
		r.n += 8
	}
}

// get reads k bits, 0 <= k <= 32.
func (r *bitReader) get(k uint) uint32 {
	if k == 0 {
		return 0
	}
	if r.n < k {
		r.fill()
		if r.n < k {
			r.over = true
			r.n = k // the missing bits read as zeros
		}
	}
	v := uint32(r.acc >> (64 - k))
	r.acc <<= k
	r.n -= k
	return v
}

// fs reads a fundamental sequence: the count of zero bits before a one.
func (r *bitReader) fs() uint32 {
	var count uint32
	for {
		if r.n == 0 {
			r.fill()
			if r.n == 0 {
				r.over = true
				return count
			}
		}
		lz := uint(bits.LeadingZeros64(r.acc))
		if lz < r.n {
			r.acc <<= lz + 1
			r.n -= lz + 1
			return count + uint32(lz)
		}
		count += uint32(r.n)
		r.acc = 0
		r.n = 0
	}
}

// alignByte drops the bits left in the current byte.
func (r *bitReader) alignByte() {
	consumed := uint(r.pos)*8 - r.n
	if drop := consumed % 8; drop != 0 {
		r.get(8 - drop)
	}
}

// Decode returns the first n samples of the stream. Unsigned samples come
// back as they are; signed ones (DataSigned) as their two's complement
// pattern widened to 32 bits, so int32(v) is the value.
func Decode(src []byte, n int, p Params) ([]uint32, error) {
	if _, err := p.validate(); err != nil {
		return nil, err
	}
	if n < 0 {
		return nil, fmt.Errorf("aec: %d samples", n)
	}
	out := make([]uint32, n)
	if err := DecodeInto(out, src, p); err != nil {
		return nil, err
	}
	return out, nil
}

// DecodeInto decodes len(out) samples into out.
func DecodeInto(out []uint32, src []byte, p Params) error {
	idLen, err := p.validate()
	if err != nil {
		return err
	}
	nbits := uint(p.BitsPerSample)
	j := p.BlockSize
	pp := p.Flags&DataPreprocess != 0
	signed := p.Flags&DataSigned != 0
	uncompID := uint32(1)<<idLen - 1
	r := &bitReader{src: src}

	rsiSamples := p.RSI * j
	pos := 0 // samples written to out
	for pos < len(out) {
		// One reference sample interval: its blocks land straight in out,
		// as coded values, unfolded once the interval is read.
		start := pos
		limit := min(start+rsiSamples, len(out))
		ref := pp
		for b := 0; b < p.RSI && pos < limit; b++ {
			id := r.get(uint(idLen))
			need := min(j, limit-pos) // samples of this block out needs
			switch {
			case id == 0:
				second := r.get(1)
				if ref {
					out[pos] = r.get(nbits)
					pos++
					need--
				}
				if second == 1 {
					// Second extension: pairs coded as one fundamental
					// sequence. With a reference sample the block's first
					// pair is (ref, d1) and its codeword carries d1 alone.
					counter := 0
					if ref {
						counter = 1
					}
					written := 0
					for counter < j && written < need {
						m := r.fs()
						if m > 90 {
							return ErrData
						}
						d1 := m - seStart[m]
						if counter&1 == 0 {
							out[pos] = seSum[m] - d1
							pos++
							written++
							counter++
							if written == need {
								break
							}
						}
						out[pos] = d1
						pos++
						written++
						counter++
					}
				} else {
					// A run of all-zero blocks, this one included.
					zb := r.fs() + 1
					if zb == rosCode {
						zb = uint32(min(p.RSI-b, 64-b%64))
					} else if zb > rosCode {
						zb--
					}
					if int(zb) > p.RSI-b {
						return ErrData
					}
					zeros := int(zb) * j
					if ref {
						zeros--
					}
					for k := 0; k < zeros && pos < limit; k++ {
						out[pos] = 0
						pos++
					}
					b += int(zb) - 1
				}
			case id == uncompID:
				for k := 0; k < need; k++ {
					out[pos] = r.get(nbits)
					pos++
				}
			default:
				k := uint(id - 1)
				if ref {
					out[pos] = r.get(nbits)
					pos++
					need--
				}
				enc := j
				if ref {
					enc--
				}
				// Every sample's fundamental sequence comes before any
				// sample's low bits, so the whole block's sequences are
				// read even when out takes only part of it.
				base := pos
				for i := 0; i < enc; i++ {
					v := r.fs() << k
					if i < need {
						out[base+i] = v
					}
				}
				if k > 0 {
					for i := 0; i < need; i++ {
						out[base+i] |= r.get(k)
					}
				}
				pos += need
			}
			ref = false
			if r.over {
				return ErrData
			}
		}
		if pp {
			unfold(out[start:pos], nbits, signed)
		} else if signed && nbits < 32 {
			m := uint32(1) << (nbits - 1)
			for i := start; i < pos; i++ {
				out[i] = (out[i] ^ m) - m
			}
		}
		if p.Flags&PadRSI != 0 {
			r.alignByte()
		}
	}
	return nil
}

// unfold inverts the preprocessor over one interval: s[0] is the raw
// reference sample, every later value the folded residual of the sample
// against the one before it (CCSDS 121.0-B-3 section 4.3).
func unfold(s []uint32, nbits uint, signed bool) {
	if len(s) == 0 {
		return
	}
	var xmin, xmax int64
	if signed {
		xmin = -(int64(1) << (nbits - 1))
		xmax = int64(1)<<(nbits-1) - 1
	} else {
		xmin = 0
		xmax = int64(1)<<nbits - 1
	}
	x := int64(s[0])
	if signed && nbits < 64 {
		m := int64(1) << (nbits - 1)
		x = (x ^ m) - m
	}
	s[0] = uint32(x)
	for i := 1; i < len(s); i++ {
		d := int64(s[i])
		lo := x - xmin
		hi := xmax - x
		theta := min(lo, hi)
		switch {
		case d <= 2*theta:
			if d&1 == 0 {
				x += d >> 1
			} else {
				x -= (d + 1) >> 1
			}
		case lo <= hi:
			// The predictor sits in the lower half: a jump this large
			// can only go up.
			x = xmin + d
		default:
			x = xmax - d
		}
		s[i] = uint32(x)
	}
}
