#[cfg(feature = "blocking")]
use crate::{protocol_error, Result};
#[cfg(any(feature = "blocking", feature = "async"))]
use crate::{Event, RunRequest, RunResult, Usage};
use crate::{ModelCatalog, ProviderHealth};
use serde::{Deserialize, Deserializer};
#[cfg(any(feature = "blocking", feature = "async"))]
use serde_json::Value;
#[cfg(feature = "blocking")]
use std::io::BufRead;

#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) const MAX_BYTES: usize = 2_000_000;
const MAX_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) fn optional_outcome<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<crate::ErrorOutcome>, D::Error> {
    Ok(Some(crate::ErrorOutcome::deserialize(deserializer)?))
}

pub(crate) fn optional_health<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<ProviderHealth>, D::Error> {
    let value = ProviderHealth::deserialize(deserializer)?;
    if !matches!(
        value.status.as_str(),
        "ready" | "unauthenticated" | "unavailable" | "unsupported" | "unknown"
    ) || value.code.is_empty()
        || !timestamp_valid(&value.checked_at)
    {
        return Err(serde::de::Error::custom("Invalid provider health"));
    }
    Ok(Some(value))
}
pub(crate) fn optional_catalog<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<ModelCatalog>, D::Error> {
    let value = ModelCatalog::deserialize(deserializer)?;
    if !matches!(
        value.source.as_str(),
        "provider" | "configured" | "unavailable"
    ) || value.models.len() > 1000
    {
        return Err(serde::de::Error::custom("Invalid model catalog"));
    }
    Ok(Some(value))
}

pub(crate) fn optional_count<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<u64>, D::Error> {
    let value = u64::deserialize(deserializer)?;
    if value > MAX_INTEGER {
        return Err(serde::de::Error::custom(
            "Token count exceeds the safe integer range",
        ));
    }
    Ok(Some(value))
}
pub(crate) fn optional_cost<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<f64>, D::Error> {
    let value = f64::deserialize(deserializer)?;
    if !value.is_finite() || value < 0.0 {
        return Err(serde::de::Error::custom("Invalid cost measurement"));
    }
    Ok(Some(value))
}
#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn result_valid(result: &RunResult, request: &RunRequest) -> bool {
    crate::context::relationships_valid(result)
        && crate::retrieval::links(result)
        && crate::retrieval::selection(result.retrieval.as_ref(), request.retrieval.as_ref())
        && !result.run_id.is_empty()
        && result.provider == request.provider
        && result.model == request.model
        && result.steps > 0
        && matches!(result.finish_reason.as_str(), "stop" | "length")
}
#[cfg(any(feature = "blocking", feature = "async"))]
fn text(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|v| !v.is_empty())
}
#[cfg(any(feature = "blocking", feature = "async"))]
fn count(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_u64)
        .is_some_and(|v| v > 0 && v <= MAX_INTEGER)
}

#[cfg(any(feature = "blocking", feature = "async"))]
pub(crate) fn event_valid(event: &Event, request: &RunRequest, first: bool) -> bool {
    if event.kind.is_empty()
        || event.run_id.is_empty()
        || event.sequence == 0
        || event.sequence > MAX_INTEGER
        || !timestamp_valid(&event.timestamp)
        || first != (event.kind == "run.started")
    {
        return false;
    }
    match event.kind.as_str() {
        "run.started" => {
            event.extra.get("provider").and_then(Value::as_str) == Some(&request.provider)
                && event.extra.get("model").and_then(Value::as_str) == Some(&request.model)
        }
        "step.started" => count(event.extra.get("step")),
        "text.delta" => event.text.is_some(),
        "run.progress" => matches!(
            event.extra.get("phase").and_then(Value::as_str),
            Some("model" | "tool" | "context")
        ),
        "tool.called" => event.extra.get("call").is_some_and(|call| {
            text(call.get("id"))
                && text(call.get("name"))
                && call.get("arguments").is_some_and(Value::is_object)
        }),
        "tool.completed" => text(event.extra.get("callId")) && event.extra.contains_key("output"),
        "usage.reported" => {
            count(event.extra.get("step"))
                && event
                    .extra
                    .get("usage")
                    .is_some_and(|usage| serde_json::from_value::<Usage>(usage.clone()).is_ok())
        }
        "run.completed" => event
            .result
            .as_ref()
            .is_some_and(|result| result_valid(result, request) && result.run_id == event.run_id),
        "run.failed" | "run.cancelled" => event
            .error
            .as_ref()
            .is_some_and(|error| !error.code.is_empty()),
        _ => true,
    }
}

// RFC 3339 calendar validation without adding a date/time dependency to the client.
pub(crate) fn timestamp_valid(value: &str) -> bool {
    if !value.is_ascii() || value.len() < 20 {
        return false;
    }
    let b = value.as_bytes();
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return false;
    }
    let part = |start, end| {
        let value: &str = &value[start..end];
        if !value.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        value.parse::<u32>().ok()
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        part(0, 4),
        part(5, 7),
        part(8, 10),
        part(11, 13),
        part(14, 16),
        part(17, 19),
    ) else {
        return false;
    };
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    if year == 0 || day == 0 || day > days || hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    let mut zone = &value[19..];
    if let Some(fraction) = zone.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        zone = &fraction[digits..];
    }
    if zone == "Z" {
        return true;
    }
    if zone.len() != 6 || !matches!(zone.as_bytes()[0], b'+' | b'-') || zone.as_bytes()[3] != b':' {
        return false;
    }
    zone[1..3]
        .bytes()
        .chain(zone[4..6].bytes())
        .all(|b| b.is_ascii_digit())
        && matches!((zone[1..3].parse::<u32>(), zone[4..6].parse::<u32>()), (Ok(h),Ok(m)) if h <= 23 && m <= 59)
}

#[cfg(feature = "blocking")]
pub(crate) struct SseLines<R> {
    reader: R,
    skip_lf: bool,
    first: bool,
}
#[cfg(feature = "blocking")]
impl<R: BufRead> SseLines<R> {
    pub(crate) fn new(reader: R) -> Self {
        Self {
            reader,
            skip_lf: false,
            first: true,
        }
    }
    pub(crate) fn next_line(&mut self) -> Result<Option<String>> {
        let mut line = Vec::new();
        loop {
            let available = self.reader.fill_buf()?;
            if available.is_empty() {
                if line.is_empty() {
                    return Ok(None);
                }
                break;
            }
            if self.skip_lf {
                self.skip_lf = false;
                if available[0] == b'\n' {
                    self.reader.consume(1);
                    continue;
                }
            }
            let end = available.iter().position(|b| matches!(b, b'\r' | b'\n'));
            let bytes = end.unwrap_or(available.len());
            if line.len() + bytes > MAX_BYTES {
                return Err(protocol_error(
                    "RESPONSE_TOO_LARGE",
                    "An event exceeded 2 MB.",
                ));
            }
            line.extend_from_slice(&available[..bytes]);
            if let Some(index) = end {
                self.skip_lf = available[index] == b'\r';
                self.reader.consume(index + 1);
                break;
            }
            self.reader.consume(bytes);
        }
        if self.first {
            self.first = false;
            if line.starts_with(b"\xef\xbb\xbf") {
                line.drain(..3);
            }
        }
        String::from_utf8(line)
            .map(Some)
            .map_err(|_| protocol_error("INVALID_STREAM", "The event stream is not valid UTF-8."))
    }
}
