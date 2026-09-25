// Runnable single-user loopback example. Application credentials remain in backend memory.
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	driver "github.com/agenticdriver/agenticdriver/clients/go"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"time"
)

func main() {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic("Could not start the local panel.")
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic("Could not create private panel access.")
	}
	prefix := "/" + hex.EncodeToString(key)
	authority := listener.Addr().String()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if file := os.Getenv("AGENTICDRIVER_CA_FILE"); file != "" {
		pem, err := os.ReadFile(file)
		if err != nil {
			panic("Could not read the selected CA file.")
		}
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(pem) {
			panic("The selected CA file is invalid.")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	}
	var client *driver.Client
	var connection *driver.PanelConnection
	var mutex sync.Mutex
	panel := driver.ProviderPanel{
		Client:     func(context.Context) (*driver.Client, error) { return client, nil },
		Connection: func() *driver.PanelConnection { return connection },
		Connect: func(ctx context.Context, invitation string) error {
			if client != nil {
				return &driver.Error{Code: "CONNECTION_EXISTS", Message: "Disconnect the current host first."}
			}
			target, err := driver.ParseConnectionInvitation(invitation)
			if err != nil {
				return err
			}
			pairing, err := driver.NewWithTransport(target.URL, target.Code, transport)
			if err != nil {
				return err
			}
			grant, err := pairing.ExchangeConnection(ctx)
			if err != nil {
				return err
			}
			client, err = driver.NewWithTransport(target.URL, grant.Token, transport)
			if err != nil {
				return err
			}
			connection = &driver.PanelConnection{ID: grant.ID, Label: target.URL, URL: target.URL}
			return nil
		},
		Disconnect: func(context.Context) error { client = nil; connection = nil; return nil },
	}
	markup, err := driver.ProviderPanelHTML(prefix+"/api", prefix+"/panel.js")
	if err != nil {
		panic("Could not render the panel.")
	}
	markup = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgenticDriver · Go</title><style>body{margin:20px;background:#171c2b}</style>` + markup
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
		if r.Host != authority || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != "http://"+authority) {
			w.WriteHeader(403)
			return
		}
		switch {
		case r.Method == "GET" && r.URL.RequestURI() == prefix+"/":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.WriteString(w, markup)
		case r.Method == "GET" && r.URL.RequestURI() == prefix+"/panel.js":
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			_, _ = w.Write(driver.ProviderPanelScript)
		case r.Method == "POST" && r.URL.RequestURI() == prefix+"/api":
			w.Header().Set("Content-Type", "application/json")
			if r.Header.Get("Content-Type") != "application/json" {
				w.WriteHeader(400)
				return
			}
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1_000_000))
			if err != nil {
				w.WriteHeader(400)
				return
			}
			mutex.Lock()
			defer mutex.Unlock()
			result, err := panel.Handle(r.Context(), body)
			if err != nil {
				w.WriteHeader(400)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": "The panel request could not be completed. Refresh and check the selected host."}})
				return
			}
			_ = json.NewEncoder(w).Encode(result)
		default:
			w.WriteHeader(404)
		}
	})
	server := http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second}
	// Private, per-process local access link; do not publish it or log request bodies.
	fmt.Printf("{\"url\":%q}\n", "http://"+authority+prefix+"/")
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		panic("The local panel stopped.")
	}
}
