package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"os"

	sdk "github.com/hashimkarim/agenticdriver/clients/go"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}
func main() {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	defer transport.CloseIdleConnections()
	cert, err := os.ReadFile(os.Getenv("AGENTICDRIVER_TEST_CA"))
	must(err)
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(cert) {
		panic("bad fixture CA")
	}
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	client, err := sdk.NewWithTransport(os.Getenv("AGENTICDRIVER_TEST_URL"), os.Getenv("AGENTICDRIVER_TEST_TOKEN"), transport)
	must(err)
	ctx := context.Background()
	info, err := client.Protocol(ctx)
	must(err)
	if info.Version != "1.0" {
		panic("protocol")
	}
	providers, err := client.RefreshProviders(ctx)
	must(err)
	if len(providers) != 1 || providers[0].ID != "fixture" {
		panic("catalog")
	}
	request := sdk.Request{Provider: "fixture", Model: "fixture-model", Input: "Deployment check"}
	result, err := client.Run(ctx, request)
	must(err)
	if result.Text != "Remote deployment works." {
		panic("run")
	}
	text, completed := "", false
	must(client.Stream(ctx, request, func(event sdk.Event) error {
		if event.Type == "text.delta" {
			text += event.Text
		}
		if event.Type == "run.completed" {
			completed = true
		}
		return nil
	}))
	if text != result.Text || !completed {
		panic("stream")
	}
	fmt.Println("Installed Go client passed through verified TLS proxy.")
}
