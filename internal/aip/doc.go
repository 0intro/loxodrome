// Package aip holds the helpers shared by the dataset-build commands
// (cmd/airports, cmd/fr, cmd/uk, cmd/es) that turn national AIP exports
// into the committed public/data datasets: reading AIXM source files (SIA
// AIXM 4.5 export zips and NATS / ENAIRE AIXM 5.1 payloads), resolving the
// current / next AIRAC slot, parsing DMS coordinates, registering the
// shared CLI flags, and writing the compact artifact plus pretty meta JSON.
package aip
