// Package pdftext runs poppler's `pdftotext` over PDF bytes.
//
// Two callers share it and must not drift apart: cmd/supaip's fallback
// extractor for the SIA supplements rsc.io/pdf cannot read, and cmd/es's
// reader for the handful of Spanish supplements published as a PDF with
// no HTML edition beside it. Both treat a missing binary or a failed run
// as "no geometry", never as a crash, so the error is returned rather
// than logged here.
package pdftext

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Timeout bounds one pdftotext invocation: a malformed upstream PDF can
// loop poppler forever, and a hang would stall the whole refresh run (the
// cached PDF then reproduces it every run). On expiry the process is
// killed and the caller degrades to its documented no-geometry path,
// exactly as when pdftotext is absent.
const Timeout = 60 * time.Second

// Run runs pdftotext with the given arguments, feeding data on stdin and
// returning its stdout, bounded by Timeout.
func Run(data []byte, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "pdftotext", args...)
	cmd.Stdin = bytes.NewReader(data)
	cmd.WaitDelay = 5 * time.Second
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("pdftotext: killed after %v", Timeout)
		}
		return nil, fmt.Errorf("pdftotext: %w: %s", err, strings.TrimSpace(errb.String()))
	}
	return out.Bytes(), nil
}
