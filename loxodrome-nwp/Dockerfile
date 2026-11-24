# The ingest Container: cmd/nwp built static into a distroless image (CA
# certificates for the publishers' HTTPS, /tmp for the archives being
# built). The build context is the repository root, of which BuildKit sends
# only the COPY sources: wrangler pipes this file on stdin, so no ignore
# file beside it is ever read.
#
# The runtime base is distroless's CURRENT Debian, the only one it rebuilds:
# its Debian 12 images stopped on 2026-09-10 and froze, CA bundle included.
# wrangler builds without --pull and Docker prefers a local tagged copy of a
# base, so never pull or run these bases by hand.
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/nwp ./cmd/nwp
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /nwp ./cmd/nwp

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /nwp /nwp
ENTRYPOINT ["/nwp"]
