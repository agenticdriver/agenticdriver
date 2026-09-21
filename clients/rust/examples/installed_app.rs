//! External application smoke example for the disposable SDK conformance host.
use agenticdriver::{AgenticClient, AsyncAgenticClient, EventPayload, RunRequest};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("AGENTICDRIVER_TEST_URL")?;
    let token = std::env::var("AGENTICDRIVER_TEST_TOKEN")?;
    let ca = std::env::var("AGENTICDRIVER_TEST_CA")
        .ok()
        .map(std::fs::read)
        .transpose()?;
    let request = RunRequest::new("mock", "demo", "Installed Rust 🌍");
    // Construct and drop the blocking client outside the async runtime.
    {
        let client = AgenticClient::with_ca_pem(&url, &token, ca.as_deref())?;
        assert_eq!(client.protocol()?.version, "1.0");
        assert_eq!(client.refresh_providers()?[0].id, "mock");
        let result = client.run(&request)?;
        let mut text = String::new();
        client.stream(&request, |event| {
            match event.payload().unwrap() {
                EventPayload::TextDelta { text: delta } => text.push_str(delta),
                EventPayload::RunCompleted { result } => assert_eq!(result.text, text),
                _ => {}
            }
            true
        })?;
        assert_eq!(text, result.text);
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            let client = AsyncAgenticClient::with_ca_pem(&url, &token, ca.as_deref())?;
            assert_eq!(client.protocol().await?.version, "1.0");
            assert_eq!(client.refresh_providers().await?[0].id, "mock");
            let result = client.run(&request).await?;
            let mut stream = client.stream(&request).await?;
            let mut text = String::new();
            let mut completed = false;
            while let Some(event) = stream.next().await {
                match event?.payload()? {
                    EventPayload::TextDelta { text: delta } => text.push_str(delta),
                    EventPayload::RunCompleted { result } => {
                        completed = true;
                        assert_eq!(result.text, text);
                    }
                    EventPayload::RunFailed { error } | EventPayload::RunCancelled { error } => {
                        return Err(agenticdriver::Error::Driver(error.clone()))
                    }
                    _ => {}
                }
            }
            assert!(completed && stream.is_closed());
            assert_eq!(text, result.text);
            Ok::<_, agenticdriver::Error>(())
        })?;
    Ok(())
}
