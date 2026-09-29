use agenticdriver::{AgenticClient, RetrievalSearch};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let token = std::fs::read_to_string(std::env::var("AGENTICDRIVER_TOKEN_FILE")?)?;
    let client = AgenticClient::new(&std::env::var("AGENTICDRIVER_URL")?, token.trim())?;
    let evidence = client.search_context(&RetrievalSearch {
        corpus: std::env::var("AGENTICDRIVER_CORPUS")?,
        source_ids: vec![std::env::var("AGENTICDRIVER_SOURCE_ID")?],
        query: Some(std::fs::read_to_string(std::env::var(
            "AGENTICDRIVER_QUERY_FILE",
        )?)?),
        limit: Some(4),
        ..Default::default()
    })?;
    println!("{}", serde_json::to_string_pretty(&evidence)?);
    Ok(())
}
