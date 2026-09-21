use agenticdriver::{AgenticClient, RunRequest};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let token = std::fs::read_to_string(std::env::var("AGENTICDRIVER_TOKEN_FILE")?)?;
    let ca = std::env::var("AGENTICDRIVER_CA")
        .ok()
        .map(std::fs::read)
        .transpose()?;
    let client = AgenticClient::with_ca_pem(
        &std::env::var("AGENTICDRIVER_URL")?,
        token.trim(),
        ca.as_deref(),
    )?;
    let result = client.run(&RunRequest::new(
        std::env::var("AGENTICDRIVER_PROVIDER")?,
        std::env::var("AGENTICDRIVER_MODEL")?,
        "Say hello in one sentence.",
    ))?;
    println!("{}", result.text);
    Ok(())
}
