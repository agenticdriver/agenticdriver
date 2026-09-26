#![cfg(feature = "async")]
use agenticdriver::{AsyncAgenticClient, Error, RunRequest};
use serde_json::Value;

fn client(url: &str, token: &str, trust_ca: bool) -> AsyncAgenticClient {
    let ca = if trust_ca {
        std::env::var("AGENTICDRIVER_TEST_CA")
            .ok()
            .map(|p| std::fs::read(p).unwrap())
    } else {
        None
    };
    AsyncAgenticClient::with_ca_pem(url, token, ca.as_deref()).unwrap()
}
fn code(error: &Error) -> Option<&str> {
    if let Error::Driver(value) = error {
        Some(&value.code)
    } else {
        None
    }
}

#[tokio::test]
async fn reference_peer_conformance() {
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
            Some("provider-setup") => peer
                .provider_setup(&serde_json::from_value(example["setupRequest"].clone()).unwrap())
                .await
                .map(|_| ()),
            Some("providers") => peer.providers().await.map(|_| ()),
            Some("protocol") => peer.protocol().await.map(|_| ()),
            Some("job-submit") => peer
                .submit_job(&agenticdriver::JobSubmit {
                    key: example["jobSubmit"]["key"].as_str().unwrap().into(),
                    request: RunRequest::new("mock", "demo", "Hello"),
                })
                .await
                .map(|_| ()),
            Some("job-read") => peer
                .read_job(&serde_json::from_value(example["jobIdentity"].clone()).unwrap())
                .await
                .map(|_| ()),
            Some("job-cancel") => peer
                .cancel_job(&serde_json::from_value(example["jobIdentity"].clone()).unwrap())
                .await
                .map(|_| ()),
            Some("job-events") => peer
                .job_events(&serde_json::from_value(example["jobEvents"].clone()).unwrap())
                .await
                .map(|_| ()),
            Some("session-create") => peer
                .create_session(&serde_json::from_value(example["sessionCreate"].clone()).unwrap())
                .await
                .map(|_| ()),
            Some("session-read") => peer
                .read_session(&serde_json::from_value(example["sessionIdentity"].clone()).unwrap())
                .await
                .map(|_| ()),
            Some("session-delete") => peer
                .delete_session(
                    &serde_json::from_value(example["sessionIdentity"].clone()).unwrap(),
                )
                .await
                .map(|_| ()),
            Some("tool-result") => peer
                .complete_tool(&serde_json::from_value(example["toolResult"].clone()).unwrap())
                .await
                .map(|_| ()),
            Some("tool-progress") => peer
                .report_tool_progress(
                    &serde_json::from_value(example["toolIdentity"].clone()).unwrap(),
                )
                .await
                .map(|_| ()),
            Some("approval") => peer
                .decide_approval(&serde_json::from_value(example["decision"].clone()).unwrap())
                .await
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
                .await
                .map(|_| ()),
            _ => consume(&peer, &request, example["cancel"] == true).await,
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

#[tokio::test]
async fn real_host_conformance() {
    if std::env::var("AGENTICDRIVER_TEST_REFERENCE_URL").is_err() {
        return;
    }
    let url = std::env::var("AGENTICDRIVER_TEST_URL").unwrap();
    let token = std::env::var("AGENTICDRIVER_TEST_TOKEN").unwrap();
    let request = RunRequest::new("mock", "demo", "Hello");
    assert_eq!(
        code(
            &client(&url, "wrong-token", true)
                .run(&request)
                .await
                .unwrap_err()
        ),
        Some("UNAUTHORIZED")
    );
    let restricted = client(&url, &(token.clone() + "-restricted"), true);
    assert!(restricted.providers().await.unwrap().is_empty());
    assert_eq!(
        code(&restricted.run(&request).await.unwrap_err()),
        Some("FORBIDDEN")
    );
    let peer = client(&url, &token, true);
    let estimated = peer
        .run(&RunRequest::new("mock", "demo", "conformance-cost"))
        .await
        .unwrap();
    assert_eq!(estimated.usage.api_equivalent_cost_usd, Some(0.25));
    assert_eq!(estimated.usage.cost_usd, None);
    let mut forbidden = RunRequest::new("mock", "demo", "Hello");
    forbidden.tools = vec!["echo".into()];
    assert_eq!(
        code(&peer.run(&forbidden).await.unwrap_err()),
        Some("FORBIDDEN")
    );
    for mode in ["quiet", "progress"] {
        let mut input = RunRequest::new("mock", "demo", format!("conformance-{}", mode));
        if mode == "progress" {
            input.idle_timeout_ms = Some(150);
        }
        assert_eq!(
            peer.run(&input).await.unwrap().text,
            "AgenticDriver is connected."
        );
    }
    let mut stalled = RunRequest::new("mock", "demo", "conformance-stall");
    stalled.idle_timeout_ms = Some(30);
    assert_eq!(
        code(&peer.run(&stalled).await.unwrap_err()),
        Some("IDLE_TIMEOUT")
    );
    if url.starts_with("https:") {
        assert!(client(&url, &token, false).providers().await.is_err());
        assert!(client(&url.replace("127.0.0.1", "localhost"), &token, true)
            .providers()
            .await
            .is_err());
    }
}

#[tokio::test]
async fn retrieval_round_trip() {
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
            id: "rust-async-paper".into(),
            revision: "r1".into(),
            ..Default::default()
        },
        chunks: vec![RetrievalChunk {
            id: "rust-async-p1".into(),
            text: "Solar batteries retain energy.".into(),
            location: Some(SourceLocation {
                page: Some(2),
                ..Default::default()
            }),
        }],
    };
    assert_eq!(
        peer.index_context(&document).await.unwrap().status,
        "indexed"
    );
    let search = RetrievalSearch {
        corpus: "library".into(),
        source_ids: vec!["rust-async-paper".into()],
        query: Some("solar energy".into()),
        ..Default::default()
    };
    assert_eq!(
        peer.search_context(&search).await.unwrap().hits[0].chunk_id,
        "rust-async-p1"
    );
    let mut request = RunRequest::new("mock", "demo", "Question");
    request.retrieval = Some(search);
    request.output_artifact = Some(ArtifactRequest {
        name: "answer.md".into(),
        media_type: "text/markdown".into(),
    });
    let result = peer.run(&request).await.unwrap();
    assert_eq!(
        result.retrieval.unwrap().hits[0].source.id,
        "rust-async-paper"
    );
    assert_eq!(result.sources.unwrap()[0].origin, "retrieval");
    assert_eq!(
        result.artifacts.unwrap()[0].source_ids,
        vec!["rust-async-p1"]
    );
    consume(&peer, &request, false).await.unwrap();
    assert!(
        peer.delete_context(&RetrievalDelete {
            corpus: "library".into(),
            source_id: "rust-async-paper".into(),
            revision: "r1".into()
        })
        .await
        .unwrap()
        .deleted
    );
    assert!(peer
        .search_context(request.retrieval.as_ref().unwrap())
        .await
        .unwrap()
        .hits
        .is_empty());
}

#[tokio::test]
async fn ingestion_round_trips() {
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
            format!("rust-async-{format}")
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
        let receipt = peer.ingest_context(&request).await.unwrap();
        assert_eq!(
            receipt.ingestion.format,
            if format == "reference" {
                "markdown"
            } else {
                format
            }
        );
        assert_eq!(
            peer.ingest_context(&request).await.unwrap().status,
            "unchanged"
        );
        let mut run = RunRequest::new("mock", "demo", "solar evidence");
        run.retrieval = Some(RetrievalRequest {
            corpus: "library".into(),
            source_ids: vec![id.clone()],
            ..Default::default()
        });
        let result = peer.run(&run).await.unwrap();
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

async fn consume(
    peer: &AsyncAgenticClient,
    request: &RunRequest,
    cancel: bool,
) -> agenticdriver::Result<()> {
    let mut stream = peer.stream(request).await?;
    while let Some(event) = stream.next().await {
        let event = event?;
        event.payload()?;
        if cancel && event.kind == "text.delta" {
            drop(stream);
            return Ok(());
        }
        if let Some(error) = event.error {
            return Err(Error::Driver(error));
        }
    }
    Ok(())
}

#[tokio::test]
async fn interactive_approvals() {
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
        let mut stream = peer.stream(&request).await.unwrap();
        while let Some(event) = stream.next().await {
            let event = event.unwrap();
            match event.payload().unwrap() {
                EventPayload::ApprovalRequested { approval } => {
                    if let Some(action) = action {
                        let decision = approval.decision(action);
                        let receipt = peer.decide_approval(&decision).await.unwrap();
                        assert_eq!(receipt.call_id, approval.call.id);
                        assert_eq!(
                            code(&peer.decide_approval(&decision).await.unwrap_err()),
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

#[tokio::test]
async fn application_owned_function() {
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
        let mut stream = peer.stream(&request).await.unwrap();
        while let Some(event) = stream.next().await {
            let event = event.unwrap();
            match event.payload().unwrap() {
                EventPayload::ApprovalRequested { approval } => {
                    peer.decide_approval(&approval.decision(ApprovalAction::Approve))
                        .await
                        .unwrap();
                    approved = true;
                }
                EventPayload::ToolExecutionRequested { execution } => {
                    assert_eq!(approved, review);
                    let output = lookup(&execution.call);
                    assert_eq!(
                        peer.report_tool_progress(&execution.identity())
                            .await
                            .unwrap()
                            .status,
                        ToolExecutionStatus::Progress
                    );
                    let value = execution.success(output);
                    assert_eq!(
                        peer.complete_tool(&value).await.unwrap().status,
                        ToolExecutionStatus::Accepted
                    );
                    assert_eq!(
                        code(&peer.complete_tool(&value).await.unwrap_err()),
                        Some("TOOL_EXECUTION_NOT_FOUND")
                    );
                }
                EventPayload::RunCompleted { .. } => completed = true,
                EventPayload::RunFailed { error } | EventPayload::RunCancelled { error } => {
                    panic!("unexpected failure: {:?}", error)
                }
                _ => {}
            }
        }
        assert!(completed);
        assert_eq!(calls, 1);
    }
}

#[tokio::test]
async fn durable_jobs() {
    use agenticdriver::{JobEventsRequest, JobState, JobSubmit};
    let Ok(base) = std::env::var("AGENTICDRIVER_TEST_URL") else {
        return;
    };
    let token = std::env::var("AGENTICDRIVER_TEST_TOKEN").unwrap();
    let peer = client(&base, &token, true);
    let input = JobSubmit {
        key: "rust-async-job".into(),
        request: RunRequest::new("mock", "demo", "Hello"),
    };
    let mut job = peer.submit_job(&input).await.unwrap();
    assert_eq!(peer.submit_job(&input).await.unwrap().id, job.id);
    let identity = job.identity();
    for _ in 0..200 {
        job = peer.read_job(&identity).await.unwrap();
        if job.state == JobState::Completed {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(job.state, JobState::Completed);
    let mut cursor = 0;
    while cursor < job.cursor {
        let page = peer
            .job_events(&JobEventsRequest {
                id: job.id.clone(),
                after: cursor,
                limit: Some(2),
            })
            .await
            .unwrap();
        cursor = page.next_cursor;
    }
    assert_eq!(
        peer.cancel_job(&identity).await.unwrap().state,
        JobState::Completed
    );
    let stalled = peer
        .submit_job(&JobSubmit {
            key: "rust-async-job-cancel".into(),
            request: RunRequest::new("mock", "demo", "conformance-stall"),
        })
        .await
        .unwrap();
    let identity = stalled.identity();
    peer.cancel_job(&identity).await.unwrap();
    for _ in 0..200 {
        job = peer.read_job(&identity).await.unwrap();
        if job.state == JobState::Cancelled {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(job.state, JobState::Cancelled);
}

#[tokio::test]
async fn conversation_sessions() {
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
            .await
            .unwrap();
        let identity = created.session.identity();
        let mut request = RunRequest::new("mock", "demo", "session-first");
        request.session = Some(created.session.handle.clone());
        let first = peer.run(&request).await.unwrap();
        assert_eq!(first.session.unwrap().handle.revision, 1);
        assert_eq!(
            code(&peer.run(&request).await.unwrap_err()),
            Some("SESSION_REVISION_CONFLICT")
        );
        let saved = peer.read_session(&identity).await.unwrap();
        assert_eq!(saved.history.len(), 2);
        assert!(!format!("{:?}", saved).contains("private-state"));
        request.input = "session-next".into();
        request.session = Some(SessionHandle {
            id: identity.id.clone(),
            revision: 1,
        });
        let mut completed = false;
        let mut stream = peer.stream(&request).await.unwrap();
        while let Some(event) = stream.next().await {
            let event = event.unwrap();
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
        }
        assert!(completed);
        assert!(peer.delete_session(&identity).await.unwrap().deleted);
        assert_eq!(
            code(&peer.read_session(&identity).await.unwrap_err()),
            Some("SESSION_NOT_FOUND")
        );
    }
}

#[tokio::test]
async fn provider_management_roundtrip() {
    let Ok(url) = std::env::var("AGENTICDRIVER_TEST_MANAGEMENT_URL") else {
        return;
    };
    let manager = client(
        &url,
        &std::env::var("AGENTICDRIVER_TEST_TOKEN").unwrap(),
        true,
    );
    let before = manager.management().await.unwrap();
    assert_eq!(
        before
            .provider_definitions
            .as_ref()
            .unwrap()
            .iter()
            .find(|d| d.kind == "codex")
            .unwrap()
            .methods[0]
            .interaction,
        "external"
    );
    let provider = agenticdriver::ProviderConfiguration {
        id: "rust-async".into(),
        kind: "mock".into(),
        models: Some(vec![]),
        ..Default::default()
    };
    let input = agenticdriver::ConfigureProvider {
        revision: before.revision,
        provider,
        api_key: None,
    };
    struct Backend<'a>(&'a agenticdriver::AsyncAgenticClient);
    impl agenticdriver::panel::AsyncPanelBackend for Backend<'_> {
        fn client(&self) -> Option<&agenticdriver::AsyncAgenticClient> {
            Some(self.0)
        }
    }
    let panel = agenticdriver::panel::handle_provider_panel_async(
        &mut Backend(&manager),
        &serde_json::json!({"action":"configure","change": input}),
    )
    .await
    .unwrap();
    let next: agenticdriver::ManagementSnapshot =
        serde_json::from_value(panel["management"].clone()).unwrap();
    assert!(next.execution_providers.is_some());
    assert_eq!(
        panel["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == input.provider.id)
            .unwrap()["models"],
        serde_json::json!([])
    );
    assert!(next
        .providers
        .iter()
        .find(|p| p.id == "rust-async")
        .unwrap()
        .models
        .as_ref()
        .unwrap()
        .is_empty());
    let error = manager.configure_provider(&input).await.err().unwrap();
    assert_eq!(code(&error), Some("CONFIG_CONFLICT"));
}

#[tokio::test]
async fn connection_pairing() {
    let Ok(url) = std::env::var("AGENTICDRIVER_TEST_MANAGEMENT_URL") else {
        return;
    };
    let manager = client(
        &url,
        &std::env::var("AGENTICDRIVER_TEST_TOKEN").unwrap(),
        true,
    );
    let invitation = manager
        .create_invitation(&agenticdriver::CreateInvitation {
            grant: agenticdriver::ConnectionGrant {
                subject: "rust-pairing".into(),
                providers: vec!["fixture".into()],
                ..Default::default()
            },
            expires_in_seconds: None,
            connection_lifetime_seconds: None,
        })
        .await
        .unwrap();
    let pairing = client(&url, &invitation.code, true);
    let credential = pairing.exchange_connection().await.unwrap();
    assert_eq!(
        code(&pairing.exchange_connection().await.err().unwrap()),
        Some("INVITATION_REJECTED")
    );
    let connected = client(&url, &credential.token, true);
    assert_eq!(connected.providers().await.unwrap()[0].id, "fixture");
    assert_eq!(
        code(&connected.management().await.err().unwrap()),
        Some("FORBIDDEN")
    );
    let links = manager.connections().await.unwrap();
    let activity = links
        .connections
        .iter()
        .find(|c| c.id == credential.info.id)
        .unwrap();
    assert!(activity.last_seen_at.is_some());
    assert_eq!(activity.active_requests, Some(0));
    assert!(manager
        .revoke_connection(&credential.info.id)
        .await
        .unwrap());
    assert_eq!(
        code(&connected.providers().await.err().unwrap()),
        Some("UNAUTHORIZED")
    );
}
