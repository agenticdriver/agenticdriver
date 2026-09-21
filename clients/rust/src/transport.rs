use crate::{protocol_error, Error, Result, PROTOCOL_VERSION};

pub(crate) fn endpoint(url: &str, token: &str) -> Result<reqwest::Url> {
    let mut base = reqwest::Url::parse(url).map_err(|_| Error::Protocol("Invalid driver URL."))?;
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
    if token.is_empty()
        || reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")).is_err()
    {
        return Err(Error::Protocol("A valid driver bearer token is required."));
    }
    if !base.path().ends_with('/') {
        base.set_path(&format!("{}/", base.path()));
    }
    Ok(base)
}

pub(crate) fn check_version(headers: &reqwest::header::HeaderMap) -> Result<()> {
    if let Some(version) = headers.get("AgenticDriver-Version") {
        if headers.get_all("AgenticDriver-Version").iter().count() != 1
            || version.to_str().ok() != Some(PROTOCOL_VERSION)
        {
            return Err(protocol_error(
                "UNSUPPORTED_PROTOCOL_VERSION",
                "The host selected an unsupported wire protocol version.",
            ));
        }
    }
    Ok(())
}

pub(crate) fn check_sse(headers: &reqwest::header::HeaderMap) -> Result<()> {
    if headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("text/event-stream"))
    {
        Ok(())
    } else {
        Err(protocol_error(
            "INVALID_RESPONSE",
            "Expected an SSE response.",
        ))
    }
}
