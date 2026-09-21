use agenticdriver::{AgenticClient, AsyncAgenticClient, EventPayload, RunRequest};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("AGENTICDRIVER_TEST_URL")?;
    let token = std::env::var("AGENTICDRIVER_TEST_TOKEN")?;
    let ca = std::fs::read(std::env::var("AGENTICDRIVER_TEST_CA")?)?;
    let request = RunRequest::new("fixture", "fixture-model", "Deployment check");
    {
        let client = AgenticClient::with_ca_pem(&url, &token, Some(&ca))?;
        assert_eq!(client.protocol()?.version, "1.0");
        assert_eq!(client.refresh_providers()?[0].id, "fixture");
        assert_eq!(client.run(&request)?.text, "Remote deployment works.");
        let mut text = String::new();
        let mut completed = false;
        client.stream(&request, |event| {
            match event.payload().unwrap() {
                EventPayload::TextDelta { text: delta } => text.push_str(delta),
                EventPayload::RunCompleted { .. } => completed = true,
                _ => {}
            }
            true
        })?;
        assert_eq!(text, "Remote deployment works.");
        assert!(completed);
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            let client = AsyncAgenticClient::with_ca_pem(&url, &token, Some(&ca))?;
            assert_eq!(client.run(&request).await?.text, "Remote deployment works.");
            let mut stream = client.stream(&request).await?;
            let mut completed = false;
            while let Some(event) = stream.next().await {
                if let EventPayload::RunCompleted { result } = event?.payload()? {
                    assert_eq!(result.text, "Remote deployment works.");
                    completed = true;
                }
            }
            assert!(completed);
            Ok::<_, agenticdriver::Error>(())
        })?;
    println!("Installed Rust blocking/async clients passed through verified TLS proxy.");
    Ok(())
}
