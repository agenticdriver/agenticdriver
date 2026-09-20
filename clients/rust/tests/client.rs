use agenticdriver::{AgenticClient, Error, ErrorOutcome, RetryPolicy, RunRequest};

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
    request.idempotency_key = Some("rust-client".into());
    request.retry = Some(RetryPolicy {
        max_attempts: 1,
        base_delay_ms: None,
        max_delay_ms: None,
    });
    let accepted = client.run(&request).unwrap();
    assert_eq!(client.run(&request).unwrap().run_id, accepted.run_id);
    request.input = "changed".into();
    match client.run(&request) {
        Err(Error::Driver(error)) => assert_eq!(error.code, "IDEMPOTENCY_CONFLICT"),
        other => panic!("Expected conflict, got {other:?}"),
    }
    request.input = "Unicode 🌍 round trip".into();
    let uncertain = RunRequest::new("mock", "demo", "conformance-uncertain");
    match client.run(&uncertain) {
        Err(Error::Driver(error)) => {
            assert_eq!(error.code, "IDLE_TIMEOUT");
            assert_eq!(error.outcome, Some(ErrorOutcome::Uncertain));
            assert!(!error.retryable);
        }
        other => panic!("Expected uncertain outcome, got {other:?}"),
    }
    client
        .stream(&request, |event| {
            terminal = event.kind == "run.completed";
            true
        })
        .unwrap();
    assert!(terminal);
}
