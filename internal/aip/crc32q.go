// crc32q.go computes CRC-32Q, the check aeronautical data sets carry for
// their integrity (EUROCONTROL's AIXM and eTOD specifications, ARINC 424):
// polynomial 0x814141AB, most significant bit first, no reflection, no
// initial or final XOR. hash/crc32 only computes the reflected family, so
// the table is built here.

package aip

var crc32qTable = func() (t [256]uint32) {
	for i := range t {
		c := uint32(i) << 24
		for range 8 {
			if c&0x80000000 != 0 {
				c = c<<1 ^ 0x814141AB
			} else {
				c <<= 1
			}
		}
		t[i] = c
	}
	return t
}()

// CRC32Q returns the CRC-32Q of data.
func CRC32Q(data []byte) uint32 {
	var c uint32
	for _, b := range data {
		c = c<<8 ^ crc32qTable[byte(c>>24)^b]
	}
	return c
}
