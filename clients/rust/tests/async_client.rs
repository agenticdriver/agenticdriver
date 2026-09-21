#![cfg(feature = "async")]
use agenticdriver::{
    ArtifactRequest, AsyncAgenticClient, ContextInput, ContextSource, Error, ErrorOutcome,
    RetryPolicy, RunRequest,
};

#[tokio::test]
async fn rejects_insecure_urls() {
    for url in [
        "http://example.com",
        "https://user:secret@example.com",
        "https://example.com?token=secret",
    ] {
        assert!(AsyncAgenticClient::new(url, "token").is_err());
    }
}

#[tokio::test]
async fn protocol_round_trip() {
    let Ok(url) = std::env::var("AGENTICDRIVER_TEST_URL") else {
        return;
    };
    let token = std::env::var("AGENTICDRIVER_TEST_TOKEN").unwrap();
    let ca = std::env::var("AGENTICDRIVER_TEST_CA")
        .ok()
        .map(|path| std::fs::read(path).unwrap());
    let client = AsyncAgenticClient::with_ca_pem(&url, token, ca.as_deref()).unwrap();
    assert_eq!(client.providers().await.unwrap()[0].id, "mock");
    let refreshed = client.refresh_providers().await.unwrap();
    assert_eq!(
        refreshed[0].health.as_ref().unwrap().code,
        "DISCOVERY_UNSUPPORTED"
    );
    assert_eq!(
        refreshed[0].model_catalog.as_ref().unwrap().source,
        "configured"
    );
    assert_eq!(client.protocol().await.unwrap().version, "1.0");
    let mut request = RunRequest::new("mock", "demo", "Unicode 🌍 round trip");
    request.idle_timeout_ms = Some(10000);
    assert_eq!(
        client.run(&request).await.unwrap().text,
        "AgenticDriver is connected."
    );
    assert_eq!(
        client.providers().await.unwrap()[0]
            .input_media_types
            .as_ref()
            .unwrap()["demo"],
        vec!["image/png", "application/pdf"]
    );
    let mut contextual = RunRequest::new("mock", "demo", "Summarize");
    contextual.attachments = vec![
        ContextInput::Reference {
            id: "source-one".into(),
            revision: "r1".into(),
            media_type: "text/markdown".into(),
        },
        ContextInput::Image {
            source: ContextSource {
                id: "image-one".into(),
                revision: "r1".into(),
                ..Default::default()
            },
            media_type: "image/png".into(),
            data: "iVBORw0KGgo=".into(),
        },
        ContextInput::Pdf {
            source: ContextSource {
                id: "pdf-one".into(),
                revision: "r1".into(),
                ..Default::default()
            },
            media_type: "application/pdf".into(),
            data: "JVBERi0xLjQKJSVFT0YK".into(),
        },
    ];
    contextual.output_artifact = Some(ArtifactRequest {
        name: "answer.md".into(),
        media_type: "text/markdown".into(),
    });
    let with_context = client.run(&contextual).await.unwrap();
    let sources = with_context.sources.unwrap();
    let artifacts = with_context.artifacts.unwrap();
    assert_eq!(sources.len(), 3);
    assert_eq!(sources[0].source.id, "source-one");
    assert_eq!(
        sources[0]
            .source
            .location
            .as_ref()
            .unwrap()
            .document_id
            .as_deref(),
        Some("doc-one")
    );
    assert_eq!(artifacts[0].status, "draft");
    assert_eq!(
        artifacts[0].source_ids,
        vec!["source-one", "image-one", "pdf-one"]
    );
    let mut terminal = false;
    request.idempotency_key = Some("rust-async-client".into());
    request.retry = Some(RetryPolicy {
        max_attempts: 1,
        base_delay_ms: None,
        max_delay_ms: None,
    });
    let accepted = client.run(&request).await.unwrap();
    assert_eq!(client.run(&request).await.unwrap().run_id, accepted.run_id);
    request.input = "changed".into();
    match client.run(&request).await {
        Err(Error::Driver(error)) => assert_eq!(error.code, "IDEMPOTENCY_CONFLICT"),
        other => panic!("Expected conflict, got {other:?}"),
    }
    request.input = "Unicode 🌍 round trip".into();
    let uncertain = RunRequest::new("mock", "demo", "conformance-uncertain");
    match client.run(&uncertain).await {
        Err(Error::Driver(error)) => {
            assert_eq!(error.code, "IDLE_TIMEOUT");
            assert_eq!(error.outcome, Some(ErrorOutcome::Uncertain));
            assert!(!error.retryable);
        }
        other => panic!("Expected uncertain outcome, got {other:?}"),
    }
    let mut stream = client.stream(&request).await.unwrap();
    while let Some(event) = stream.next().await {
        let event = event.unwrap();
        event.payload().unwrap();
        terminal = event.is_terminal();
    }
    assert!(terminal);
    assert!(stream.is_closed());
}
