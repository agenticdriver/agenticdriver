use agenticdriver::{AgenticClient, RunRequest};

#[test]
fn rejects_insecure_urls() {
    for url in [
        "http://example.com",
        "https://user:secret@example.com",
        "https://example.com?token=secret",
    ] {
        assert!(AgenticClient::new(url, "token").is_err());
    }
}

#[test]
fn protocol_round_trip() {
    let Ok(url) = std::env::var("AGENTICDRIVER_TEST_URL") else {
        return;
    };
    let token = std::env::var("AGENTICDRIVER_TEST_TOKEN").unwrap();
    let ca = std::env::var("AGENTICDRIVER_TEST_CA")
        .ok()
        .map(|path| std::fs::read(path).unwrap());
    let client = AgenticClient::with_ca_pem(&url, token, ca.as_deref()).unwrap();
    assert_eq!(client.providers().unwrap()[0].id, "mock");
    let refreshed = client.refresh_providers().unwrap();
    assert_eq!(
        refreshed[0].health.as_ref().unwrap().code,
        "DISCOVERY_UNSUPPORTED"
    );
    assert_eq!(
        refreshed[0].model_catalog.as_ref().unwrap().source,
        "configured"
    );
    assert_eq!(client.protocol().unwrap().version, "1.0");
    let mut request = RunRequest::new("mock", "demo", "Unicode 🌍 round trip");
    request.idle_timeout_ms = Some(10000);
    assert_eq!(
        client.run(&request).unwrap().text,
        "AgenticDriver is connected."
    );
    let mut terminal = false;
    client
        .stream(&request, |event| {
            terminal = event.kind == "run.completed";
            true
        })
        .unwrap();
    assert!(terminal);
}
