//! Runnable single-user loopback panel. Credentials stay only in backend memory.
//! Integrations use the consuming application's existing authorization and secret store.
use agenticdriver::panel::{
    handle_provider_panel_async, provider_panel_html, AsyncPanelBackend, PanelConnection,
    PROVIDER_PANEL_SCRIPT,
};
use agenticdriver::{AsyncAgenticClient, Error, Result};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    body::{Bytes, Incoming},
    server::conn::http1,
    service::service_fn,
    Request, Response,
};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::Mutex};

#[derive(Default)]
struct Settings {
    client: Option<AsyncAgenticClient>,
    connection: Option<PanelConnection>,
    ca: Option<Vec<u8>>,
}
impl AsyncPanelBackend for Settings {
    fn client(&self) -> Option<&AsyncAgenticClient> {
        self.client.as_ref()
    }
    fn connection(&self) -> Option<PanelConnection> {
        self.connection.clone()
    }
    fn can_connect(&self) -> bool {
        true
    }
    fn can_disconnect(&self) -> bool {
        true
    }
    async fn connect(&mut self, invitation: &str) -> Result<()> {
        if self.client.is_some() {
            return Err(Error::Protocol("Disconnect the current host first."));
        }
        let (url, code) = agenticdriver::connections::connection_target(invitation)?;
        let grant = AsyncAgenticClient::with_ca_pem(&url, code, self.ca.as_deref())?
            .exchange_connection()
            .await?;
        self.client = Some(AsyncAgenticClient::with_ca_pem(
            &url,
            grant.token,
            self.ca.as_deref(),
        )?);
        self.connection = Some(PanelConnection {
            id: grant.info.id,
            label: url.clone(),
            url: Some(url),
        });
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<()> {
        self.client = None;
        self.connection = None;
        Ok(())
    }
}
fn reply(status: u16, content_type: &str, body: impl Into<Bytes>) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
        )
        .body(Full::new(body.into()))
        .unwrap()
}
async fn handle(
    request: Request<Incoming>,
    state: Arc<Mutex<Settings>>,
    authority: String,
    prefix: String,
) -> Response<Full<Bytes>> {
    if request.headers().get("Host").and_then(|v| v.to_str().ok()) != Some(authority.as_str())
        || request
            .headers()
            .get("Origin")
            .is_some_and(|v| v != format!("http://{authority}").as_str())
    {
        return reply(403, "application/json", "{}");
    }
    let path = request
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("");
    if request.method() == "GET" && path == format!("{prefix}/") {
        let html =
            provider_panel_html(&format!("{prefix}/api"), &format!("{prefix}/panel.js")).unwrap();
        return reply(200, "text/html; charset=utf-8", format!("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>AgenticDriver · Rust</title><style>body{{margin:20px;background:#171c2b}}</style>{html}"));
    }
    if request.method() == "GET" && path == format!("{prefix}/panel.js") {
        return reply(200, "text/javascript; charset=utf-8", PROVIDER_PANEL_SCRIPT);
    }
    if request.method() != "POST" || path != format!("{prefix}/api") {
        return reply(404, "application/json", "{}");
    }
    if request
        .headers()
        .get("Content-Type")
        .and_then(|v| v.to_str().ok())
        != Some("application/json")
    {
        return reply(400, "application/json", "{}");
    }
    let body = tokio::time::timeout(
        Duration::from_secs(30),
        Limited::new(request.into_body(), 1_000_000).collect(),
    )
    .await;
    let Ok(Ok(body)) = body else {
        return reply(400, "application/json", "{}");
    };
    let Ok(input) = serde_json::from_slice::<Value>(&body.to_bytes()) else {
        return reply(400, "application/json", "{}");
    };
    let mut settings = state.lock().await;
    match handle_provider_panel_async(&mut *settings, &input).await {
        Ok(value) => reply(200,"application/json",value.to_string()),
        Err(_) => reply(400,"application/json",json!({"error":{"message":"The panel request could not be completed. Refresh and check the selected host."}}).to_string()),
    }
}
#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let authority = listener.local_addr()?.to_string();
    let mut key = [0u8; 32];
    getrandom::fill(&mut key)
        .map_err(|_| std::io::Error::other("Could not create private panel access."))?;
    let prefix = format!(
        "/{}",
        key.iter().map(|b| format!("{b:02x}")).collect::<String>()
    );
    let ca = std::env::var("AGENTICDRIVER_CA_FILE")
        .ok()
        .map(std::fs::read)
        .transpose()?;
    let state = Arc::new(Mutex::new(Settings {
        ca,
        ..Default::default()
    }));
    // This per-process private local link is the only output; never log requests or credentials.
    println!("{}", json!({"url":format!("http://{authority}{prefix}/")}));
    loop {
        let (socket, _) = listener.accept().await?;
        let (state, authority, prefix) = (state.clone(), authority.clone(), prefix.clone());
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let (state, authority, prefix) = (state.clone(), authority.clone(), prefix.clone());
                async move { Ok::<_, Infallible>(handle(request, state, authority, prefix).await) }
            });
            let _ = http1::Builder::new()
                .max_buf_size(32768)
                .serve_connection(TokioIo::new(socket), service)
                .await;
        });
    }
}
