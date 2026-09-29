use agenticdriver::{validate_source_citations, Error};

#[test]
fn exact_manifest_membership() {
    assert_eq!(
        validate_source_citations(
            "Evidence [source:paper-1] and [source:paper-1]",
            &["paper-1"],
            true
        )
        .unwrap(),
        vec!["paper-1"]
    );
    for text in [
        "No citation",
        "[source:unknown]",
        "[source:",
        "[source:]",
        "[source:paper-1][source:unknown]",
    ] {
        assert!(
            matches!(validate_source_citations(text, &["paper-1"], true), Err(Error::Driver(error)) if error.code == "INVALID_CITATION")
        );
    }
    assert!(
        validate_source_citations("No citations required", &[], false)
            .unwrap()
            .is_empty()
    );
}
