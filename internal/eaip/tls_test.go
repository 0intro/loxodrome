package eaip

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"testing"
	"time"
)

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

func newCert(t *testing.T, cn string, parent *testCA, ca bool, dns ...string) *testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: cn},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		BasicConstraintsValid: true,
		IsCA:                  ca,
		DNSNames:              dns,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if ca {
		tmpl.KeyUsage = x509.KeyUsageCertSign
	} else {
		tmpl.KeyUsage = x509.KeyUsageDigitalSignature
	}
	signer, signerKey := tmpl, key
	if parent != nil {
		signer, signerKey = parent.cert, parent.key
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, signer, &key.PublicKey, signerKey)
	if err != nil {
		t.Fatal(err)
	}
	c, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &testCA{cert: c, key: key}
}

// Avians sends its leaf alone. The intermediate the site's row supplies
// completes the path, and it is only ever an intermediate: a certificate
// supplied that way does not become a root, so the path must still end at
// one the verifier trusts.
func TestSuppliedCertificatesAreIntermediates(t *testing.T) {
	root := newCert(t, "Root", nil, true)
	inter := newCert(t, "Intermediate", root, true)
	leaf := newCert(t, "leaf", inter, false, "eaip.example.is")
	roots := x509.NewCertPool()
	roots.AddCert(root.cert)
	cs := tls.ConnectionState{ServerName: "eaip.example.is", PeerCertificates: []*x509.Certificate{leaf.cert}}

	if err := verifyWithIntermediates(cs, nil, roots); err == nil {
		t.Error("a leaf sent alone verified with no intermediate supplied")
	}
	if err := verifyWithIntermediates(cs, []*x509.Certificate{inter.cert}, roots); err != nil {
		t.Errorf("the supplied intermediate did not complete the path: %v", err)
	}
	// An untrusted CA handed in as "extra" must not vouch for its leaf.
	rogue := newCert(t, "Rogue", nil, true)
	forged := newCert(t, "leaf", rogue, false, "eaip.example.is")
	cs.PeerCertificates = []*x509.Certificate{forged.cert}
	if err := verifyWithIntermediates(cs, []*x509.Certificate{rogue.cert}, roots); err == nil {
		t.Error("a supplied self-signed certificate was trusted as a root")
	}
	// And the name is still checked.
	cs = tls.ConnectionState{ServerName: "other.example.is", PeerCertificates: []*x509.Certificate{leaf.cert}}
	if err := verifyWithIntermediates(cs, []*x509.Certificate{inter.cert}, roots); err == nil {
		t.Error("a certificate for another name verified")
	}
}
