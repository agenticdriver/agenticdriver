//! Authenticated AgenticDriver v1 client. Runs locally over loopback or remotely over HTTPS.
use reqwest::blocking::{Client as HttpClient, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};
use std::time::Duration;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Deserialize)]
pub struct DriverError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}
#[derive(Debug)]
pub enum Error {
    Driver(DriverError),
    Http(reqwest::Error),
    Json(serde_json::Error),
    Io(std::io::Error),
    Protocol(&'static str),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Driver(e) => write!(f, "{}: {}", e.code, e.message),
            Self::Http(e) => write!(f, "{e}"),
            Self::Json(e) => write!(f, "{e}"),
            Self::Io(e) => write!(f, "{e}"),
            Self::Protocol(e) => write!(f, "{e}"),
        }
    }
}
impl std::error::Error for Error {}
impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Self::Http(e)
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub provider: String,
    pub model: String,
    pub input: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<Message>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_steps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, String>,
}
impl RunRequest {
    pub fn new(
        provider: impl Into<String>,
        model: impl Into<String>,
        input: impl Into<String>,
    ) -> Self {
        Self {
            provider: provider.into(),
            model: model.into(),
            input: input.into(),
            ..Self::default()
        }
    }
}
#[derive(Debug, Serialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub run_id: String,
    pub provider: String,
    pub model: String,
    pub text: String,
    pub output: Option<Value>,
    pub usage: Usage,
    pub steps: u32,
    pub finish_reason: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub tools: bool,
    pub text_streaming: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub auth_mode: String,
    pub models: Option<Vec<String>>,
    pub usage_stat_id: Option<String>,
    pub capabilities: Capabilities,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    #[serde(rename = "type")]
    pub kind: String,
    pub run_id: String,
    pub sequence: u64,
    pub timestamp: String,
    pub text: Option<String>,
    pub result: Option<RunResult>,
    pub error: Option<DriverError>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

pub struct AgenticClient {
    base: reqwest::Url,
    token: String,
    http: HttpClient,
}
impl AgenticClient {
    pub fn new(url: &str, token: impl Into<String>) -> Result<Self> {
        Self::with_ca_pem(url, token, None)
    }
    /// Add a private CA without disabling certificate or hostname verification.
    pub fn with_ca_pem(url: &str, token: impl Into<String>, ca: Option<&[u8]>) -> Result<Self> {
        let mut base =
            reqwest::Url::parse(url).map_err(|_| Error::Protocol("Invalid driver URL."))?;
        let local = matches!(
            base.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        );
        if !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || base.host_str().is_none()
            || !(base.scheme() == "https" || (base.scheme() == "http" && local))
        {
            return Err(Error::Protocol(
                "Use HTTPS, or HTTP on loopback, without URL credentials, query, or fragment.",
            ));
        }
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        let token = token.into();
        if token.is_empty() {
            return Err(Error::Protocol("A driver bearer token is required."));
        }
        let mut builder = HttpClient::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(None)
            .connect_timeout(Duration::from_secs(10));
        if let Some(pem) = ca {
            builder = builder.add_root_certificate(reqwest::Certificate::from_pem(pem)?);
        }
        Ok(Self {
            base,
            token,
            http: builder.build()?,
        })
    }
    fn request(&self, path: &str, body: Option<&RunRequest>, stream: bool) -> Result<Response> {
        let url = self
            .base
            .join(path)
            .map_err(|_| Error::Protocol("Invalid endpoint."))?;
        let mut request = if let Some(data) = body {
            self.http.post(url).json(data)
        } else {
            self.http.get(url)
        };
        request = request.bearer_auth(&self.token).header(
            "Accept",
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            },
        );
        if body.is_none() {
            request = request.timeout(Duration::from_secs(10));
        }
        let response = request.send()?;
        if !response.status().is_success() {
            #[derive(Deserialize)]
            struct Envelope {
                error: DriverError,
            }
            return match read_json::<Envelope>(response) {
                Ok(payload) => Err(Error::Driver(payload.error)),
                Err(_) => Err(Error::Protocol("The driver returned an HTTP error.")),
            };
        }
        Ok(response)
    }
    pub fn providers(&self) -> Result<Vec<Provider>> {
        #[derive(Deserialize)]
        struct Catalog {
            providers: Vec<Provider>,
        }
        Ok(read_json::<Catalog>(self.request("v1/providers", None, false)?)?.providers)
    }
    pub fn run(&self, request: &RunRequest) -> Result<RunResult> {
        read_json(self.request("v1/runs", Some(request), false)?)
    }
    /// Return false from `visit` to close the response and cancel an unfinished run.
    /// Use a blocking worker when calling this synchronous API from an async runtime.
    pub fn stream(&self, request: &RunRequest, mut visit: impl FnMut(Event) -> bool) -> Result<()> {
        let response = self.request("v1/runs", Some(request), true)?;
        if !response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .contains("text/event-stream")
        {
            return Err(Error::Protocol("Expected an SSE response."));
        }
        let mut reader = BufReader::new(response);
        let mut fields = Vec::new();
        let mut sequence = 0;
        let mut run_id = String::new();
        let mut size = 0;
        loop {
            let mut line = Vec::new();
            let n = reader
                .by_ref()
                .take(2_000_001)
                .read_until(b'\n', &mut line)?;
            if n == 0 {
                return Err(Error::Protocol(
                    "Connection closed before a terminal run event.",
                ));
            }
            size += n;
            if size > 2_000_000 {
                return Err(Error::Protocol("An event exceeded 2 MB."));
            }
            let line = std::str::from_utf8(&line)
                .map_err(|_| Error::Protocol("Invalid event encoding."))?
                .trim_end_matches(['\r', '\n']);
            if let Some(data) = line.strip_prefix("data:") {
                fields.push(data.strip_prefix(' ').unwrap_or(data).to_owned());
            }
            if line.is_empty() {
                if !fields.is_empty() {
                    let event: Event = serde_json::from_str(&fields.join("\n"))?;
                    if event.run_id.is_empty()
                        || event.sequence != sequence + 1
                        || (!run_id.is_empty() && run_id != event.run_id)
                    {
                        return Err(Error::Protocol("Invalid or out-of-order event."));
                    }
                    run_id.clone_from(&event.run_id);
                    sequence = event.sequence;
                    let terminal = matches!(
                        event.kind.as_str(),
                        "run.completed" | "run.failed" | "run.cancelled"
                    );
                    let failure = if event.kind == "run.failed" || event.kind == "run.cancelled" {
                        event.error.as_ref().map(|e| DriverError {
                            code: e.code.clone(),
                            message: e.message.clone(),
                            retryable: e.retryable,
                        })
                    } else {
                        None
                    };
                    if !visit(event) {
                        return Ok(());
                    }
                    if let Some(error) = failure {
                        return Err(Error::Driver(error));
                    }
                    if terminal {
                        return Ok(());
                    }
                }
                fields.clear();
                size = 0;
            }
        }
    }
}
fn read_json<T: serde::de::DeserializeOwned>(response: Response) -> Result<T> {
    let mut data = Vec::new();
    response.take(2_000_001).read_to_end(&mut data)?;
    if data.len() > 2_000_000 {
        return Err(Error::Protocol("Response exceeded 2 MB."));
    }
    Ok(serde_json::from_slice(&data)?)
}
