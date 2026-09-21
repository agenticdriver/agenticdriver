#![cfg(feature = "blocking")]
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
        let mut request = RunRequest::new("mock", "demo", "Hello");
        if let Some(session) = example.get("session") {
            request.session = Some(serde_json::from_value(session.clone()).unwrap());
        }
        if let Some(definitions) = example.get("applicationTools") {
            request.application_tools = serde_json::from_value(definitions.clone()).unwrap();
        }
        if let Some(tools) = example.get("tools") {
            request.tools = serde_json::from_value(tools.clone()).unwrap();
        }
        if let Some(approvals) = example.get("approvals") {
            request.approvals = Some(serde_json::from_value(approvals.clone()).unwrap());
        }
        if let Some(retrieval) = example.get("retrieval") {
            request.retrieval = Some(serde_json::from_value(retrieval.clone()).unwrap());
        }
        let result = match example["operation"].as_str() {
            Some("providers") => peer.providers().map(|_| ()),
            Some("protocol") => peer.protocol().map(|_| ()),
            Some("session-create") => peer
                .create_session(&serde_json::from_value(example["sessionCreate"].clone()).unwrap())
                .map(|_| ()),
            Some("session-read") => peer
                .read_session(&serde_json::from_value(example["sessionIdentity"].clone()).unwrap())
                .map(|_| ()),
            Some("session-delete") => peer
                .delete_session(
                    &serde_json::from_value(example["sessionIdentity"].clone()).unwrap(),
                )
                .map(|_| ()),
            Some("tool-result") => peer
                .complete_tool(&serde_json::from_value(example["toolResult"].clone()).unwrap())
                .map(|_| ()),
            Some("tool-progress") => peer
                .report_tool_progress(
                    &serde_json::from_value(example["toolIdentity"].clone()).unwrap(),
                )
                .map(|_| ()),
            Some("approval") => peer
                .decide_approval(&serde_json::from_value(example["decision"].clone()).unwrap())
                .map(|_| ()),
            Some("ingest") => peer
                .ingest_context(&agenticdriver::IngestRequest {
                    corpus: "library".into(),
                    document: agenticdriver::IngestionDocument::Reference {
                        id: "paper".into(),
                        revision: "r1".into(),
                        media_type: "text/markdown".into(),
                    },
                    chunking: None,
                    idle_timeout_ms: None,
                })
                .map(|_| ()),
            _ => peer.stream(&request, |event| {
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
    let estimated = peer
        .run(&RunRequest::new("mock", "demo", "conformance-cost"))
        .unwrap();
    assert_eq!(estimated.usage.api_equivalent_cost_usd, Some(0.25));
    assert_eq!(estimated.usage.cost_usd, None);
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

#[test]
fn retrieval_round_trip() {
    use agenticdriver::{
        ArtifactRequest, ContextSource, RetrievalChunk, RetrievalDelete, RetrievalIndexRequest,
        RetrievalSearch, SourceLocation,
    };
    let Ok(base) = std::env::var("AGENTICDRIVER_TEST_URL") else {
        return;
    };
    let token = std::env::var("AGENTICDRIVER_TEST_TOKEN").unwrap();
    let peer = client(&base, &token, true);
    let document = RetrievalIndexRequest {
        ingestion: None,
        corpus: "library".into(),
        source: ContextSource {
            id: "rust-paper".into(),
            revision: "r1".into(),
            ..Default::default()
        },
        chunks: vec![RetrievalChunk {
            id: "rust-p1".into(),
            text: "Solar batteries retain energy.".into(),
            location: Some(SourceLocation {
                page: Some(2),
                ..Default::default()
            }),
        }],
    };
    assert_eq!(peer.index_context(&document).unwrap().status, "indexed");
    let search = RetrievalSearch {
        corpus: "library".into(),
        source_ids: vec!["rust-paper".into()],
        query: Some("solar energy".into()),
        ..Default::default()
    };
    assert_eq!(
        peer.search_context(&search).unwrap().hits[0].chunk_id,
        "rust-p1"
    );
    let mut request = RunRequest::new("mock", "demo", "Question");
    request.retrieval = Some(search);
    request.output_artifact = Some(ArtifactRequest {
        name: "answer.md".into(),
        media_type: "text/markdown".into(),
    });
    let result = peer.run(&request).unwrap();
    assert_eq!(result.retrieval.unwrap().hits[0].source.id, "rust-paper");
    assert_eq!(result.sources.unwrap()[0].origin, "retrieval");
    assert_eq!(result.artifacts.unwrap()[0].source_ids, vec!["rust-p1"]);
    let mut completed = false;
    peer.stream(&request, |event| {
        completed = event.kind == "run.completed";
        true
    })
    .unwrap();
    assert!(completed);
    assert!(
        peer.delete_context(&RetrievalDelete {
            corpus: "library".into(),
            source_id: "rust-paper".into(),
            revision: "r1".into()
        })
        .unwrap()
        .deleted
    );
    assert!(peer
        .search_context(request.retrieval.as_ref().unwrap())
        .unwrap()
        .hits
        .is_empty());
}

#[test]
fn ingestion_round_trips() {
    use agenticdriver::{
        ContextSource, EmailMessage, IngestRequest, IngestionDocument, RetrievalRequest,
    };
    let Ok(base) = std::env::var("AGENTICDRIVER_TEST_URL") else {
        return;
    };
    let token = std::env::var("AGENTICDRIVER_TEST_TOKEN").unwrap();
    let peer = client(&base, &token, true);
    for format in ["markdown", "email", "pdf", "reference"] {
        let id = if format == "reference" {
            "ingestion-reference".into()
        } else {
            format!("rust-{format}")
        };
        let source = ContextSource {
            id: id.clone(),
            revision: "r1".into(),
            ..Default::default()
        };
        let document = match format {
            "email" => IngestionDocument::Email {
                source,
                thread_id: "thread-one".into(),
                messages: vec![EmailMessage {
                    id: "message-one".into(),
                    text: "Solar evidence.".into(),
                }],
            },
            "pdf" => IngestionDocument::Pdf {
                source,
                media_type: "application/pdf".into(),
                data: "JVBERi0xLjQKJSVFT0YK".into(),
            },
            "reference" => IngestionDocument::Reference {
                id: id.clone(),
                revision: "r1".into(),
                media_type: "text/markdown".into(),
            },
            _ => IngestionDocument::Text {
                source,
                media_type: "text/markdown".into(),
                text: "# Solar evidence\nEnergy from sunlight.".into(),
            },
        };
        let request = IngestRequest {
            corpus: "library".into(),
            document,
            chunking: None,
            idle_timeout_ms: None,
        };
        let receipt = peer.ingest_context(&request).unwrap();
        assert_eq!(
            receipt.ingestion.format,
            if format == "reference" {
                "markdown"
            } else {
                format
            }
        );
        assert_eq!(peer.ingest_context(&request).unwrap().status, "unchanged");
        let mut run = RunRequest::new("mock", "demo", "solar evidence");
        run.retrieval = Some(RetrievalRequest {
            corpus: "library".into(),
            source_ids: vec![id.clone()],
            ..Default::default()
        });
        let result = peer.run(&run).unwrap();
        let hit = &result.retrieval.as_ref().unwrap().hits[0];
        let manifest = hit.ingestion.as_ref().unwrap();
        assert_eq!(manifest.input_sha256, receipt.ingestion.input_sha256);
        let location = hit.source.location.as_ref().unwrap();
        assert_eq!(location.document_id.as_ref(), Some(&id));
        if format == "pdf" {
            assert_eq!(manifest.pages.as_ref().unwrap().total, 2);
        }
        if format == "email" {
            assert_eq!(location.message_id.as_deref(), Some("message-one"));
        }
        if format == "markdown" {
            assert_eq!(location.section.as_deref(), Some("Solar evidence"));
        }
    }
}

#[test]
fn interactive_approvals() {
    use agenticdriver::{
        ApprovalAction, ApprovalIdlePolicy, ApprovalOutcome, ApprovalPolicy, EventPayload,
    };
    let Ok(url) = std::env::var("AGENTICDRIVER_TEST_URL") else {
        return;
    };
    let peer = client(
        &url,
        &std::env::var("AGENTICDRIVER_TEST_TOKEN").unwrap(),
        true,
    );
    for action in [
        Some(ApprovalAction::Approve),
        Some(ApprovalAction::Deny),
        Some(ApprovalAction::Cancel),
        None,
    ] {
        let mut request = RunRequest::new("mock", "demo", "conformance-approval");
        request.tools = vec!["approved_echo".into()];
        let mut policy = ApprovalPolicy::interactive(ApprovalIdlePolicy::Pause);
        if action.is_none() {
            policy.expires_after_ms = Some(20);
        }
        request.approvals = Some(policy);
        let mut resolved = None;
        let mut completed = false;
        let mut terminal = String::new();
        let result = peer.stream(&request, |event| {
            match event.payload().unwrap() {
                EventPayload::ApprovalRequested { approval } => {
                    if let Some(action) = action {
                        let decision = approval.decision(action);
                        let receipt = peer.decide_approval(&decision).unwrap();
                        assert_eq!(receipt.call_id, approval.call.id);
                        assert_eq!(
                            code(&peer.decide_approval(&decision).unwrap_err()),
                            Some("APPROVAL_NOT_FOUND")
                        );
                    }
                }
                EventPayload::ApprovalResolved { resolution } => {
                    resolved = Some(resolution.outcome)
                }
                EventPayload::ToolCompleted { .. } => completed = true,
                _ => {}
            }
            if event.is_terminal() {
                terminal = event.kind.clone();
            }
            true
        });
        match action {
            Some(ApprovalAction::Approve) => result.unwrap(),
            Some(ApprovalAction::Deny) => {
                assert_eq!(code(&result.unwrap_err()), Some("APPROVAL_DENIED"))
            }
            Some(ApprovalAction::Cancel) => {
                assert_eq!(code(&result.unwrap_err()), Some("CANCELLED"))
            }
            None => assert_eq!(code(&result.unwrap_err()), Some("APPROVAL_EXPIRED")),
        }
        assert_eq!(completed, action == Some(ApprovalAction::Approve));
        assert_eq!(
            resolved,
            Some(match action {
                Some(ApprovalAction::Approve) => ApprovalOutcome::Approved,
                Some(ApprovalAction::Deny) => ApprovalOutcome::Denied,
                Some(ApprovalAction::Cancel) => ApprovalOutcome::Cancelled,
                None => ApprovalOutcome::Expired,
            })
        );
        assert_eq!(
            terminal,
            match action {
                Some(ApprovalAction::Approve) => "run.completed",
                Some(ApprovalAction::Cancel) => "run.cancelled",
                _ => "run.failed",
            }
        );
    }
}

#[test]
fn application_owned_function() {
    use agenticdriver::{
        ApplicationToolDefinition, ApprovalAction, ApprovalIdlePolicy, ApprovalPolicy,
        EventPayload, ToolExecutionStatus,
    };
    use serde_json::json;
    let Ok(url) = std::env::var("AGENTICDRIVER_TEST_URL") else {
        return;
    };
    let peer = client(
        &url,
        &std::env::var("AGENTICDRIVER_TEST_TOKEN").unwrap(),
        true,
    );
    for review in [false, true] {
        let mut calls = 0;
        let mut lookup = |call: &agenticdriver::ToolCall| {
            calls += 1;
            json!({"passages": [format!("Evidence for {}", call.arguments["query"].as_str().unwrap())]})
        };
        let mut request = RunRequest::new("mock", "demo", "conformance-application-tool");
        request.tools = vec!["application_lookup".into()];
        request.application_tools = vec![ApplicationToolDefinition {
            name: "application_lookup".into(),
            description: "Find application-owned evidence".into(),
            input_schema: json!({"type":"object","required":["query"],"properties":{"query":{"type":"string"}}}),
            output_schema: Some(
                json!({"type":"object","required":["passages"],"properties":{"passages":{"type":"array","items":{"type":"string"}}}}),
            ),
            requires_approval: Some(review),
        }];
        if review {
            request.approvals = Some(ApprovalPolicy::interactive(ApprovalIdlePolicy::Pause));
        }
        let mut approved = false;
        let mut completed = false;
        peer.stream(&request, |event| {
            match event.payload().unwrap() {
                EventPayload::ApprovalRequested { approval } => {
                    peer.decide_approval(&approval.decision(ApprovalAction::Approve))
                        .unwrap();
                    approved = true;
                }
                EventPayload::ToolExecutionRequested { execution } => {
                    assert_eq!(approved, review);
                    let output = lookup(&execution.call);
                    assert_eq!(
                        peer.report_tool_progress(&execution.identity())
                            .unwrap()
                            .status,
                        ToolExecutionStatus::Progress
                    );
                    let value = execution.success(output);
                    assert_eq!(
                        peer.complete_tool(&value).unwrap().status,
                        ToolExecutionStatus::Accepted
                    );
                    assert_eq!(
                        code(&peer.complete_tool(&value).unwrap_err()),
                        Some("TOOL_EXECUTION_NOT_FOUND")
                    );
                }
                EventPayload::RunCompleted { .. } => completed = true,
                EventPayload::RunFailed { error } | EventPayload::RunCancelled { error } => {
                    panic!("unexpected failure: {:?}", error)
                }
                _ => {}
            }
            true
        })
        .unwrap();
        assert!(completed);
        assert_eq!(calls, 1);
    }
}

#[test]
fn conversation_sessions() {
    use agenticdriver::{EventPayload, SessionCreate, SessionHandle, SessionMode};
    let Ok(url) = std::env::var("AGENTICDRIVER_TEST_URL") else {
        return;
    };
    let peer = client(
        &url,
        &std::env::var("AGENTICDRIVER_TEST_TOKEN").unwrap(),
        true,
    );
    for mode in [SessionMode::History, SessionMode::Native] {
        let created = peer
            .create_session(&SessionCreate::new("mock", "demo", mode))
            .unwrap();
        let identity = created.session.identity();
        let mut request = RunRequest::new("mock", "demo", "session-first");
        request.session = Some(created.session.handle.clone());
        let first = peer.run(&request).unwrap();
        assert_eq!(first.session.unwrap().handle.revision, 1);
        assert_eq!(
            code(&peer.run(&request).unwrap_err()),
            Some("SESSION_REVISION_CONFLICT")
        );
        let saved = peer.read_session(&identity).unwrap();
        assert_eq!(saved.history.len(), 2);
        assert!(!format!("{:?}", saved).contains("private-state"));
        request.input = "session-next".into();
        request.session = Some(SessionHandle {
            id: identity.id.clone(),
            revision: 1,
        });
        let mut completed = false;
        peer.stream(&request, |event| {
            match event.payload().unwrap() {
                EventPayload::RunCompleted { result } => {
                    assert_eq!(result.text, "continued");
                    assert_eq!(result.session.as_ref().unwrap().handle.revision, 2);
                    completed = true;
                }
                EventPayload::RunFailed { error } | EventPayload::RunCancelled { error } => {
                    panic!("unexpected failure: {:?}", error)
                }
                _ => {}
            }
            true
        })
        .unwrap();
        assert!(completed);
        assert!(peer.delete_session(&identity).unwrap().deleted);
        assert_eq!(
            code(&peer.read_session(&identity).unwrap_err()),
            Some("SESSION_NOT_FOUND")
        );
    }
}
