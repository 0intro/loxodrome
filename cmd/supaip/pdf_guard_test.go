package main

import (
	"bytes"
	"fmt"
	"testing"
	"time"
)

// guardPDF is a one-page PDF whose content stream is body.
func guardPDF(body string) []byte {
	objs := []string{
		"<</Type/Catalog /Pages 2 0 R>>",
		"<</Type/Pages /Kids [3 0 R] /Count 1>>",
		"<</Type/Page /Parent 2 0 R /MediaBox [0 0 400 600] /Contents 4 0 R>>",
		fmt.Sprintf("<</Length %d>>\nstream\n%s\nendstream", len(body), body),
	}
	var buf bytes.Buffer
	buf.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objs))
	for i, o := range objs {
		offsets[i] = buf.Len()
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", i+1, o)
	}
	start := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n0000000000 65535 f \n", len(objs)+1)
	for _, off := range offsets {
		fmt.Fprintf(&buf, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&buf, "trailer\n<</Size %d /Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n", len(objs)+1, start)
	return buf.Bytes()
}

// A content stream ending inside an array or a string is one rsc.io/pdf's
// lexer never finishes: the native pass must refuse the file, promptly,
// and leave it to poppler. A whole stream still reads.
func TestExtractRowsRefusesAnOpenStream(t *testing.T) {
	for _, c := range []struct {
		name, body string
		refused    bool
	}{
		{"whole", "BT /F1 10 Tf 10 10 Td (abc) Tj ET", false},
		{"open array", "BT [(abc", true},
		{"open string", "BT (abc", true},
		{"open hex string", "BT <616263", true},
	} {
		t.Run(c.name, func(t *testing.T) {
			done := make(chan error, 1)
			go func() {
				_, err := extractRows(guardPDF(c.body))
				done <- err
			}()
			select {
			case err := <-done:
				if (err != nil) != c.refused {
					t.Errorf("error %v, want refused %v", err, c.refused)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("the native pass did not return: the guard let the lexer loop")
			}
		})
	}
}
