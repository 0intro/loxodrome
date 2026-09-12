# adcharts test fixtures

Trimmed excerpts of the real SIA eAIP tree, cycle effective 2026-07-09
(`eAIP_09_JUL_2026/FRANCE/AIRAC-2026-07-09`), fetched 2026-07-21:

- `menu.html`: five representative entries reconstructed from the real
  `FR-menu-fr-FR.html` (three AD 2 aerodromes + the two AD 3 heliports),
  in a minimal shell.
- `ad2-lfpt.html`: the chart Figure blocks of `FR-AD-2.LFPT-fr-FR.html`,
  verbatim (27 charts across ADC / GMC / DATA / IAC / SID / STAR), in a
  minimal shell.
- `ad3-lfwf.html`: the chart Figure blocks of `FR-AD-3.LFWF-fr-FR.html`,
  verbatim (14 charts; pins the AD 3 `Cartes/VAC_HEL/<ICAO>/<ICAO>/`
  path shape and the TEXT family).

And from the sibling Atlas VAC tree (`eAIP_06_AUG_2026/Atlas-VAC`, fetched
2026-08-09):

- `AeroArraysVach.js`: five of the 238 helistation-index rows in the
  atlas' own name order, with the parallel long-name array the parser
  must ignore.
