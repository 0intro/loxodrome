package main

import "testing"

// The build is held: public/data is refused, a local directory taken.
func TestHeldOut(t *testing.T) {
	if heldOut(defaultOutDir) == nil {
		t.Error("public/data accepted")
	}
	if err := heldOut(t.TempDir()); err != nil {
		t.Errorf("a local directory refused: %v", err)
	}
}

// The Macedonian half of a bilingual zone is dropped, the English kept.
func TestMkDrop(t *testing.T) {
	if mkDrop("ENR 2.2", "", "Давањето на Услуга во воздушниот сообраќај (ATS)") == "" {
		t.Error("the Macedonian twin kept")
	}
	if mkDrop("ENR 2.2", "", "The ATS provision in the portion of airspace of Albania") != "" {
		t.Error("the English zone dropped")
	}
}
