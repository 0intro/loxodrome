package aip

import "testing"

// The catalogue's check value, the CRC of the nine ASCII digits.
func TestCRC32Q(t *testing.T) {
	if got := CRC32Q([]byte("123456789")); got != 0x3010BF7F {
		t.Errorf("CRC32Q = %08X, want 3010BF7F", got)
	}
	if got := CRC32Q(nil); got != 0 {
		t.Errorf("CRC32Q(nil) = %08X, want 0", got)
	}
}
