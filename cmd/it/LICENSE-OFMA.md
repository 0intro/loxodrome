# OFMA General Users' License, as published on 14 August 2026

The open flightmaps association publishes its licence only through
in-page modals on openflightmaps.org; it has no stable URL, so this is a
dated copy of the terms as they stood when `cmd/it` was written. Re-check
it against the site before relying on it, and update this file when it
changes.

## The grant, as stated on openflightmaps.org/about

> The open flightmaps association (OFMA) grants you, under the **OFMA
> General Users' License**, a **worldwide, royalty-free, non-exclusive
> license** to use the data contained in the OFM Database.

## Conditions, as stated on openflightmaps.org/about and /faq

1. **Attribution.** The open flightmaps database must always be
   attributed as the source of the data.
2. **Error reporting.** Users must report errors back, and developers
   must provide their end users a tool to report errors and commit
   corrections.

## Commercial use, as stated on openflightmaps.org/faq

> Can I use this data in an app and sell it to my clients?
> Yes, if you do this in accordance to the OFMA General Users License.

There is **no non-commercial clause and no share-alike clause**, which is
what separates this licence from openAIP's CC BY-NC and makes it the one
aggregator in `docs/aip-sources.md` whose data may be redistributed here.

## Scope

The grant above covers the **database**. The plate and chart packages are
published under a separate, stricter licence and are not used here.

## How this repository honours it

- **Attribution.** The About dialog's Italy card names "open flightmaps"
  and links to openflightmaps.org; the Layers tab's publisher row reads
  "open flightmaps OFMX (community)"; `docs/it-aip.md` and the README
  source table both name it. Every surface also says the data is
  community-maintained rather than published by ENAV, so a pilot is never
  led to believe they are reading the Italian AIP.
- **Error reporting.** The About card's link is the route back to OFMA
  for a correction.
