"""Fetch a published Go module and exercise it without checkout-relative replacements."""
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
MODULE = "github.com/hashimkarim/agenticdriver/clients/go"
if len(sys.argv) != 2 or re.fullmatch(r"[a-f0-9]{7,40}|v[0-9]+\.[0-9]+\.[0-9]+(?:[-.a-zA-Z0-9]+)?", sys.argv[1]) is None:
    raise SystemExit("Usage: python3 scripts/test-go-install.py PUSHED_COMMIT_OR_VERSION")
version = sys.argv[1]
with tempfile.TemporaryDirectory(prefix="agenticdriver-go-install-") as directory:
    work = Path(directory)
    app = work / "application"
    app.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith("AGENTICDRIVER_")}
    env.update(GOWORK="off", GOFLAGS="-mod=mod", GOPATH=str(work / "gopath"), GOMODCACHE=str(work / "modules"))
    # This repository may be private. Do not send its revision to a public
    # module proxy or checksum database; use the caller's existing Git login.
    private = "github.com/hashimkarim/agenticdriver"
    for key in ("GOPRIVATE", "GONOPROXY", "GONOSUMDB"):
        env[key] = ",".join(filter(None, (env.get(key, ""), private)))
    env["GIT_TERMINAL_PROMPT"] = "0"
    def run(*args, **kwargs):
        return subprocess.run(args, cwd=app, env=env, check=True, timeout=240, text=True, **kwargs)
    run("go", "mod", "init", "example.test/installed-agenticdriver")
    run("go", "get", MODULE + "@" + version)
    module = json.loads(run("go", "list", "-m", "-json", MODULE, capture_output=True).stdout)
    assert module["Path"] == MODULE and not module.get("Replace"), module
    assert "replace" not in (app / "go.mod").read_text()
    assert Path(module["Dir"]).is_relative_to(work / "modules"), module
    assert (Path(module["Dir"]) / "LICENSE").exists(), "Module archive must include its license"
    (app / "main.go").write_text(r'''
package main
import (
    "context"
    "crypto/tls"
    "crypto/x509"
    "errors"
    "fmt"
    "net/http"
    "os"
    sdk "github.com/hashimkarim/agenticdriver/clients/go"
)
func must(err error) { if err != nil { panic(err) } }
func main() {
    transport:=http.DefaultTransport.(*http.Transport).Clone()
    defer transport.CloseIdleConnections()
    if path:=os.Getenv("AGENTICDRIVER_TEST_CA");path!="" {
        cert,err:=os.ReadFile(path);must(err);pool:=x509.NewCertPool()
        if !pool.AppendCertsFromPEM(cert) {panic("bad fixture CA")}
        transport.TLSClientConfig=&tls.Config{RootCAs:pool,MinVersion:tls.VersionTLS12}
    }
    client,err:=sdk.NewWithTransport(os.Getenv("AGENTICDRIVER_TEST_URL"),os.Getenv("AGENTICDRIVER_TEST_TOKEN"),transport);must(err)
    ctx:=context.Background()
    info,err:=client.Protocol(ctx);must(err);if info.Version!="1.0"{panic("protocol")}
    providers,err:=client.RefreshProviders(ctx);must(err);if len(providers)!=1 || providers[0].ID!="mock"{panic("catalog")}
    request:=sdk.Request{Provider:"mock",Model:"demo",Input:"Question"}
    result,err:=client.Run(ctx,request);must(err);if result.Text!="AgenticDriver is connected."{panic("run")}
    started,completed:=false,false
    must(client.Stream(ctx,request,func(e sdk.Event)error{
        if e.Type=="run.started" {started=e.Provider=="mock" && e.Model=="demo"}
        if e.Type=="run.completed" {completed=e.Result!=nil}
        return nil
    }));if !started || !completed{panic("typed stream")}
    receipt,err:=client.IngestContext(ctx,sdk.IngestRequest{Corpus:"library",Document:sdk.IngestionDocument{Type:"text",Source:&sdk.ContextSource{ID:"go-markdown",Revision:"r1"},MediaType:"text/markdown",Text:"# Evidence\nSolar batteries retain energy."}});must(err)
    if receipt.Ingestion==nil || receipt.Ingestion.Format!="markdown"{panic("ingestion")}
    evidence,err:=client.SearchContext(ctx,sdk.RetrievalSearch{Corpus:"library",SourceIDs:[]string{"go-markdown"},Query:"solar"});must(err)
    if len(evidence.Hits)!=1 || evidence.Hits[0].Ingestion.InputSHA256!=receipt.Ingestion.InputSHA256{panic("provenance")}
    _,err=client.Run(ctx,sdk.Request{Provider:"mock",Model:"demo",Input:"Question",Tools:[]string{"echo"}})
    var rejected *sdk.Error
    if !errors.As(err,&rejected)||rejected.Code!="FORBIDDEN"{panic("error inspection")}
    stop:=errors.New("application stopped")
    err=client.Stream(ctx,request,func(sdk.Event)error{return stop});if !errors.Is(err,stop){panic("callback cancellation")}
    cancelled,cancel:=context.WithCancel(ctx);cancel()
    _,err=client.Run(cancelled,request);if !errors.Is(err,context.Canceled){panic("context cancellation")}
    fmt.Println("Installed Go module passed: verified transport, discovery, typed run/events, ingestion, provenance, errors and cancellation")
}
''')
    cert, key = work / "cert.pem", work / "key.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=serverAuth"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for secure in (False, True):
        token = secrets.token_urlsafe(32)
        host_env = {**env, "AGENTICDRIVER_TOKEN": token}
        if secure: host_env.update(AGENTICDRIVER_TLS_CERT=str(cert), AGENTICDRIVER_TLS_KEY=str(key))
        host = subprocess.Popen(["node", "--import", "tsx", "tests/conformance-host.ts"], cwd=ROOT, env=host_env, stdout=subprocess.PIPE, stderr=sys.stderr, text=True)
        try:
            hosts = json.loads(host.stdout.readline())
            env.update(AGENTICDRIVER_TEST_URL=hosts["url"], AGENTICDRIVER_TEST_TOKEN=token, AGENTICDRIVER_TEST_CA=str(cert) if secure else "")
            run("go", "run", "-race", ".")
        finally:
            host.terminate()
            try: host.wait(timeout=10)
            except subprocess.TimeoutExpired:
                host.kill(); host.wait()
    print(json.dumps({"module": MODULE, "version": module["Version"], "replace": False, "http": "passed", "verifiedHttps": "passed"}))
