//! Reusable provider component and backend bridge. Application authorization remains with the consuming app.
use crate::{Error, Result};
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};

pub const PROVIDER_PANEL_SCRIPT: &str = include_str!("provider-panel.js");
#[derive(Clone, Serialize)]
pub struct PanelConnection {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}
fn invalid() -> Error {
    Error::Protocol("Choose a supported provider panel operation.")
}
fn escaped(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&#39;")
}
pub fn provider_panel_html(api_path: &str, module_path: &str) -> Result<String> {
    for path in [api_path, module_path] {
        if !path.starts_with('/')
            || path.starts_with("//")
            || path
                .chars()
                .any(|c| c.is_whitespace() || "?#\\".contains(c))
            || path.split('/').any(|p| p == "..")
        {
            return Err(Error::Protocol(
                "Use same-origin absolute asset and API paths.",
            ));
        }
    }
    Ok(format!(
        r#"<agenticdriver-providers api="{}"></agenticdriver-providers><script type="module" src="{}"></script>"#,
        escaped(api_path),
        escaped(module_path)
    ))
}

#[cfg(feature = "blocking")]
#[allow(async_fn_in_trait)]
pub trait PanelBackend {
    fn client(&self) -> Option<&crate::AgenticClient>;
    fn connection(&self) -> Option<PanelConnection> {
        None
    }
    fn can_connect(&self) -> bool {
        false
    }
    fn can_disconnect(&self) -> bool {
        false
    }
    fn connect(&mut self, _invitation: &str) -> Result<()> {
        Err(Error::Protocol(
            "This application manages connections outside the panel.",
        ))
    }
    fn disconnect(&mut self) -> Result<()> {
        Err(Error::Protocol(
            "This application manages connections outside the panel.",
        ))
    }
}
#[cfg(feature = "blocking")]
pub fn panel_snapshot<B: PanelBackend>(backend: &B, refresh: bool) -> Result<Value> {
    let mut state = json!({"connected": backend.client().is_some(), "providers": [], "canConnect": backend.can_connect(), "canDisconnect": backend.can_disconnect(), "canInvite": false});
    if let Some(connection) = backend.connection() {
        state["connection"] = serde_json::to_value(connection)?;
    }
    let Some(client) = backend.client() else {
        return Ok(state);
    };
    let providers = if refresh {
        client.refresh_providers()?
    } else {
        client.providers()?
    };
    state["providers"] = serde_json::to_value(providers)?;
    let features = client.protocol()?.features;
    if features.iter().any(|f| f == "provider-management") {
        state["management"] = serde_json::to_value(client.management()?)?;
        if features.iter().any(|f| f == "provider-setup") {
            state["setup"] =
                serde_json::to_value(client.provider_setup(&crate::ProviderSetupRequest::List)?)?;
        }
        state["canInvite"] = json!(
            features.iter().any(|f| f == "client-pairing")
                && backend.connection().and_then(|c| c.url).is_some()
        );
    }
    Ok(state)
}
#[cfg(feature = "blocking")]
pub fn handle_provider_panel<B: PanelBackend>(backend: &mut B, request: &Value) -> Result<Value> {
    let action = request["action"].as_str().ok_or_else(invalid)?;
    if action == "snapshot" {
        return panel_snapshot(backend, request["refresh"].as_bool() == Some(true));
    }
    if action == "connect" && backend.can_connect() {
        let invitation = request["invitation"]
            .as_str()
            .filter(|v| v.len() <= 16384)
            .ok_or_else(invalid)?;
        backend.connect(invitation)?;
        return panel_snapshot(backend, false);
    }
    if action == "disconnect" && backend.can_disconnect() {
        backend.disconnect()?;
        return panel_snapshot(backend, false);
    }
    let client = backend
        .client()
        .ok_or(Error::Protocol("Connect an AgenticDriver host first."))?;
    match action {
        "setup" => Ok(serde_json::to_value(client.provider_setup(
            &serde_json::from_value(request["request"].clone())?,
        )?)?),
        "configure" => {
            client.configure_provider(&serde_json::from_value(request["change"].clone())?)?;
            panel_snapshot(backend, false)
        }
        "connections" => {
            let list = client.connections()?;
            Ok(json!({"invitations": list.invitations, "connections": list.connections}))
        }
        "revoke" => Ok(
            json!({"revoked": client.revoke_connection(request["id"].as_str().ok_or_else(invalid)?)?}),
        ),
        "invite" => {
            let url = backend
                .connection()
                .and_then(|c| c.url)
                .ok_or(Error::Protocol(
                    "Configure the host's public connection URL.",
                ))?;
            let invite = client.create_invitation(&crate::CreateInvitation {
                grant: crate::ConnectionGrant {
                    subject: request["subject"].as_str().ok_or_else(invalid)?.to_owned(),
                    providers: serde_json::from_value(request["providers"].clone())?,
                    manage_providers: request["manageProviders"].as_bool() == Some(true),
                    ..Default::default()
                },
                expires_in_seconds: None,
                connection_lifetime_seconds: None,
            })?;
            let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(url);
            Ok(
                json!({"invitation":format!("ad1.{}.{}",encoded,invite.code),"expiresAt":invite.info.expires_at,"grant":invite.info.grant}),
            )
        }
        _ => Err(invalid()),
    }
}

#[cfg(feature = "async")]
#[allow(async_fn_in_trait)]
pub trait AsyncPanelBackend {
    fn client(&self) -> Option<&crate::AsyncAgenticClient>;
    fn connection(&self) -> Option<PanelConnection> {
        None
    }
    fn can_connect(&self) -> bool {
        false
    }
    fn can_disconnect(&self) -> bool {
        false
    }
    async fn connect(&mut self, _invitation: &str) -> Result<()> {
        Err(Error::Protocol(
            "This application manages connections outside the panel.",
        ))
    }
    async fn disconnect(&mut self) -> Result<()> {
        Err(Error::Protocol(
            "This application manages connections outside the panel.",
        ))
    }
}
#[cfg(feature = "async")]
pub async fn panel_snapshot_async<B: AsyncPanelBackend>(
    backend: &B,
    refresh: bool,
) -> Result<Value> {
    let mut state = json!({"connected": backend.client().is_some(), "providers": [], "canConnect": backend.can_connect(), "canDisconnect": backend.can_disconnect(), "canInvite": false});
    if let Some(connection) = backend.connection() {
        state["connection"] = serde_json::to_value(connection)?;
    }
    let Some(client) = backend.client() else {
        return Ok(state);
    };
    let providers = if refresh {
        client.refresh_providers().await?
    } else {
        client.providers().await?
    };
    state["providers"] = serde_json::to_value(providers)?;
    let features = client.protocol().await?.features;
    if features.iter().any(|f| f == "provider-management") {
        state["management"] = serde_json::to_value(client.management().await?)?;
        if features.iter().any(|f| f == "provider-setup") {
            state["setup"] = serde_json::to_value(
                client
                    .provider_setup(&crate::ProviderSetupRequest::List)
                    .await?,
            )?;
        }
        state["canInvite"] = json!(
            features.iter().any(|f| f == "client-pairing")
                && backend.connection().and_then(|c| c.url).is_some()
        );
    }
    Ok(state)
}
#[cfg(feature = "async")]
pub async fn handle_provider_panel_async<B: AsyncPanelBackend>(
    backend: &mut B,
    request: &Value,
) -> Result<Value> {
    let action = request["action"].as_str().ok_or_else(invalid)?;
    if action == "snapshot" {
        return panel_snapshot_async(backend, request["refresh"].as_bool() == Some(true)).await;
    }
    if action == "connect" && backend.can_connect() {
        let invitation = request["invitation"]
            .as_str()
            .filter(|v| v.len() <= 16384)
            .ok_or_else(invalid)?;
        backend.connect(invitation).await?;
        return panel_snapshot_async(backend, false).await;
    }
    if action == "disconnect" && backend.can_disconnect() {
        backend.disconnect().await?;
        return panel_snapshot_async(backend, false).await;
    }
    let client = backend
        .client()
        .ok_or(Error::Protocol("Connect an AgenticDriver host first."))?;
    match action {
        "setup" => Ok(serde_json::to_value(
            client
                .provider_setup(&serde_json::from_value(request["request"].clone())?)
                .await?,
        )?),
        "configure" => {
            client
                .configure_provider(&serde_json::from_value(request["change"].clone())?)
                .await?;
            panel_snapshot_async(backend, false).await
        }
        "connections" => {
            let list = client.connections().await?;
            Ok(json!({"invitations": list.invitations, "connections": list.connections}))
        }
        "revoke" => Ok(
            json!({"revoked": client.revoke_connection(request["id"].as_str().ok_or_else(invalid)?).await?}),
        ),
        "invite" => {
            let url = backend
                .connection()
                .and_then(|c| c.url)
                .ok_or(Error::Protocol(
                    "Configure the host's public connection URL.",
                ))?;
            let invite = client
                .create_invitation(&crate::CreateInvitation {
                    grant: crate::ConnectionGrant {
                        subject: request["subject"].as_str().ok_or_else(invalid)?.to_owned(),
                        providers: serde_json::from_value(request["providers"].clone())?,
                        manage_providers: request["manageProviders"].as_bool() == Some(true),
                        ..Default::default()
                    },
                    expires_in_seconds: None,
                    connection_lifetime_seconds: None,
                })
                .await?;
            let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(url);
            Ok(
                json!({"invitation":format!("ad1.{}.{}",encoded,invite.code),"expiresAt":invite.info.expires_at,"grant":invite.info.grant}),
            )
        }
        _ => Err(invalid()),
    }
}
