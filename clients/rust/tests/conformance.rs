use agenticdriver::{AgenticClient, Error, RunRequest};
use serde_json::Value;

fn client(url: &str, token: &str, trust_ca: bool) -> AgenticClient {
    let ca = if trust_ca {
        std::env::var("AGENTICDRIVER_TEST_CA")
            .ok()
            .map(|p| std::fs::read(p).unwrap())
    } else {
        None
    };
    AgenticClient::with_ca_pem(url, token, ca.as_deref()).unwrap()
}
fn code(error: &Error) -> Option<&str> {
    if let Error::Driver(value) = error {
        Some(&value.code)
    } else {
        None
    }
}

#[test]
fn reference_peer_conformance() {
    let Ok(base) = std::env::var("AGENTICDRIVER_TEST_REFERENCE_URL") else {
        return;
    };
    let token = std::env::var("AGENTICDRIVER_TEST_TOKEN").unwrap();
    let fixture: Value =
        serde_json::from_str(include_str!("../../../protocol/fixtures/conformance.json")).unwrap();
    let mut failures = Vec::new();
    for example in fixture["cases"].as_array().unwrap() {
        let id = example["id"].as_str().unwrap();
        let peer = client(&format!("{}/fixtures/{}", base, id), &token, true);
        let result = match example["operation"].as_str() {
            Some("providers") => peer.providers().map(|_| ()),
            Some("protocol") => peer.protocol().map(|_| ()),
            _ => peer.stream(&RunRequest::new("mock", "demo", "Hello"), |event| {
                !(example["cancel"] == true && event.kind == "text.delta")
            }),
        };
        if let Some(expected) = example["expectedError"].as_str() {
            if result.as_ref().err().and_then(code) != Some(expected) {
                failures.push(format!("{}: expected {}, got {:?}", id, expected, result));
            }
        } else if example["expectTransportError"] == true {
            if result.is_ok() {
                failures.push(format!("{}: redirect succeeded", id));
            }
        } else if let Err(error) = result {
            failures.push(format!("{}: {:?}", id, error));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn real_host_conformance() {
    if std::env::var("AGENTICDRIVER_TEST_REFERENCE_URL").is_err() {
        return;
    }
    let url = std::env::var("AGENTICDRIVER_TEST_URL").unwrap();
    let token = std::env::var("AGENTICDRIVER_TEST_TOKEN").unwrap();
    let request = RunRequest::new("mock", "demo", "Hello");
    assert_eq!(
        code(&client(&url, "wrong-token", true).run(&request).unwrap_err()),
        Some("UNAUTHORIZED")
    );
    let restricted = client(&url, &(token.clone() + "-restricted"), true);
    assert!(restricted.providers().unwrap().is_empty());
    assert_eq!(
        code(&restricted.run(&request).unwrap_err()),
        Some("FORBIDDEN")
    );
    let peer = client(&url, &token, true);
    let mut forbidden = RunRequest::new("mock", "demo", "Hello");
    forbidden.tools = vec!["echo".into()];
    assert_eq!(code(&peer.run(&forbidden).unwrap_err()), Some("FORBIDDEN"));
    for mode in ["quiet", "progress"] {
        let mut input = RunRequest::new("mock", "demo", format!("conformance-{}", mode));
        if mode == "progress" {
            input.idle_timeout_ms = Some(150);
        }
        assert_eq!(
            peer.run(&input).unwrap().text,
            "AgenticDriver is connected."
        );
    }
    let mut stalled = RunRequest::new("mock", "demo", "conformance-stall");
    stalled.idle_timeout_ms = Some(30);
    assert_eq!(code(&peer.run(&stalled).unwrap_err()), Some("IDLE_TIMEOUT"));
    if url.starts_with("https:") {
        assert!(client(&url, &token, false).providers().is_err());
        assert!(client(&url.replace("127.0.0.1", "localhost"), &token, true)
            .providers()
            .is_err());
    }
}
