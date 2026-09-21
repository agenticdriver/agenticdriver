package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"

	sdk "github.com/hashimkarim/agenticdriver/clients/go"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}
func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	token, err := os.ReadFile(os.Getenv("AGENTICDRIVER_TOKEN_FILE"))
	must(err)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	defer transport.CloseIdleConnections()
	if path := os.Getenv("AGENTICDRIVER_CA"); path != "" {
		cert, err := os.ReadFile(path)
		must(err)
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(cert) {
			panic("Invalid application CA certificate")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	}
	client, err := sdk.NewWithTransport(os.Getenv("AGENTICDRIVER_URL"), strings.TrimSpace(string(token)), transport)
	must(err)
	result, err := client.Run(ctx, sdk.Request{
		Provider: os.Getenv("AGENTICDRIVER_PROVIDER"), Model: os.Getenv("AGENTICDRIVER_MODEL"),
		Input: "Say hello in one sentence.",
	})
	must(err)
	fmt.Println(result.Text)
}
