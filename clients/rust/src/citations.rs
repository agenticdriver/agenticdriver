//! Source-ID checks before draft acceptance. This does not check factual support.
use crate::{DriverError, Error, Result};
use std::collections::HashSet;

pub fn validate_source_citations(
    text: &str,
    source_ids: &[&str],
    require_citation: bool,
) -> Result<Vec<String>> {
    let known: HashSet<&str> = source_ids.iter().copied().collect();
    let mut cited = Vec::new();
    let mut remaining = text;
    let invalid = || {
        Error::Driver(DriverError {
        code: "INVALID_CITATION".into(), message: "The draft has a missing, malformed or unknown source citation. Review it before acceptance; no correction or retry was attempted.".into(),
        retryable: false, outcome: None,
    })
    };
    while let Some(start) = remaining.find("[source:") {
        remaining = &remaining[start + 8..];
        let end = remaining.find(']').ok_or_else(invalid)?;
        let id = &remaining[..end];
        if id.is_empty() || !known.contains(id) {
            return Err(invalid());
        }
        if !cited.iter().any(|existing| existing == id) {
            cited.push(id.to_string());
        }
        remaining = &remaining[end + 1..];
    }
    if require_citation && cited.is_empty() {
        return Err(invalid());
    }
    Ok(cited)
}
