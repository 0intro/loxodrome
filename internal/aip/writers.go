// writers.go writes the artefact (compact) and meta (pretty + trailing
// newline) JSON files, plus WriteDataset, which resolves the AIRAC slot,
// emits both for one per-country dataset, and retires a pre-release the
// current slot has caught up with.

package aip

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// WriteCompactJSON marshals v with json.Marshal (one line, no indent)
// and writes it to path. Used for the large rows-array artefacts.
func WriteCompactJSON(path string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// WritePrettyJSON marshals v with two-space indentation and a trailing
// newline. Used for the *.meta.json sidecars.
func WritePrettyJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o644)
}

// WriteDataset resolves the current/next AIRAC slot from target and the
// AIXM effective date, then writes the compact artifact JSON and the
// pretty meta sidecar under outDir: prefix.json + prefix.meta.json for the
// current slot, or the prefix.next.json + prefix.next.meta.json pair for
// the next slot. Writing the current slot also retires a pre-release that
// slot has caught up with (see pruneSupersededNext). It returns the slot
// label ("current" or "next") so callers can log it.
func WriteDataset(outDir, prefix, target, effective string, artifact, meta any) (string, error) {
	useNext, err := ResolveTarget(target, effective, time.Now())
	if err != nil {
		return "", err
	}
	jsonName := prefix + ".json"
	metaName := prefix + ".meta.json"
	if useNext {
		jsonName = prefix + ".next.json"
		metaName = prefix + ".next.meta.json"
	}
	if err := WriteCompactJSON(filepath.Join(outDir, jsonName), artifact); err != nil {
		return "", err
	}
	if err := WritePrettyJSON(filepath.Join(outDir, metaName), meta); err != nil {
		return "", err
	}
	if useNext {
		return "next", nil
	}
	if err := pruneSupersededNext(outDir, prefix, effective); err != nil {
		return "", err
	}
	return "current", nil
}

// pruneSupersededNext removes the prefix.next pair when the current slot
// has caught up with it, i.e. when the pre-release's effective date is not
// strictly after the one just written to the current slot.
//
// Nothing else in the toolchain ever deletes a .next pair: WriteDataset
// only writes the slot the effective date selects, so a pre-release built
// while its cycle was still future outlives the changeover and sits in the
// tree for good. The app already ignores it (pickActiveDataset in
// src/lib/data/meta.ts prefers next only when its effective is strictly
// greater), so this keeps the two sides agreeing on when a pre-release has
// stopped meaning anything, and keeps the committed tree from carrying a
// dead copy of every cycle it has passed through.
//
// Deliberately conservative: a missing, unreadable or undecodable sidecar,
// and either date failing to parse (ENAIRE stamps an empty effective),
// leave the files alone. Losing a pre-release that might still be live is
// worse than keeping a dead one.
func pruneSupersededNext(outDir, prefix, effective string) error {
	if effective == "" {
		return nil
	}
	curDay, err := effectiveDay(effective)
	if err != nil {
		return nil
	}
	metaPath := filepath.Join(outDir, prefix+".next.meta.json")
	body, err := os.ReadFile(metaPath)
	if err != nil {
		return nil
	}
	var sidecar struct {
		Effective string `json:"effective"`
	}
	if err := json.Unmarshal(body, &sidecar); err != nil || sidecar.Effective == "" {
		return nil
	}
	nextDay, err := effectiveDay(sidecar.Effective)
	if err != nil || nextDay.After(curDay) {
		return nil
	}
	for _, path := range []string{filepath.Join(outDir, prefix+".next.json"), metaPath} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
