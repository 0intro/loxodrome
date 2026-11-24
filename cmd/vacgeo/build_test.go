package main

import (
	"reflect"
	"testing"
)

// permutations calls f with every ordering of runs.
func permutations(runs []textRun, f func([]textRun)) {
	var rec func(k int)
	rec = func(k int) {
		if k == len(runs) {
			f(append([]textRun(nil), runs...))
			return
		}
		for i := k; i < len(runs); i++ {
			runs[k], runs[i] = runs[i], runs[k]
			rec(k + 1)
			runs[k], runs[i] = runs[i], runs[k]
		}
	}
	rec(0)
}

// "On one line" within a tolerance is not transitive: baselines 100, 101.2
// and 102.4 are each within 1.5 pt of the next and not of both. Sorted on
// that comparison the lines came out in whatever order the input arrived,
// and a header split or interleaved loses the page its kind or its ARP.
func TestPageLinesDriftingBaselines(t *testing.T) {
	runs := []textRun{
		{x: 10, y: 800, adv: 5, text: "H"},
		{x: 10, y: 100, adv: 5, text: "a"},
		{x: 20, y: 101.2, adv: 5, text: "b"},
		{x: 30, y: 102.4, adv: 5, text: "c"},
		{x: 40, y: 101.9, adv: 5, text: "d"},
		{x: 17, y: 100.6, adv: 5, text: "e"},
	}
	want := pageLines(runs)
	permutations(runs, func(p []textRun) {
		if got := pageLines(p); !reflect.DeepEqual(got, want) {
			t.Fatalf("pageLines(%v) = %q, want %q as for every other order", p, got, want)
		}
	})
	// A line holds the runs within 1.5 pt of its top baseline, left to
	// right, and no run sits on two lines.
	if w := []string{"H", "b c d", "a e"}; !reflect.DeepEqual(want, w) {
		t.Errorf("pageLines = %q, want %q", want, w)
	}
}
