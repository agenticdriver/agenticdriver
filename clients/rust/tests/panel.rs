use agenticdriver::panel::{provider_panel_html, PROVIDER_PANEL_SCRIPT};

#[test]
fn component_is_packaged_and_paths_are_same_origin() {
    assert!(PROVIDER_PANEL_SCRIPT.contains("agenticdriver-providers"));
    assert!(provider_panel_html("/settings/driver", "/assets/panel.js")
        .unwrap()
        .contains("api=\"/settings/driver\""));
    for path in [
        "https://untrusted.example",
        "//untrusted.example",
        "/a/../b",
    ] {
        assert!(provider_panel_html(path, "/assets/panel.js").is_err());
    }
}

#[cfg(feature = "blocking")]
#[test]
fn connection_hooks_are_application_owned() {
    use agenticdriver::panel::{handle_provider_panel, PanelBackend};
    struct Backend(String);
    impl PanelBackend for Backend {
        fn client(&self) -> Option<&agenticdriver::AgenticClient> {
            None
        }
        fn can_connect(&self) -> bool {
            true
        }
        fn can_disconnect(&self) -> bool {
            true
        }
        fn connect(&mut self, invitation: &str) -> agenticdriver::Result<()> {
            self.0 = invitation.into();
            Ok(())
        }
        fn disconnect(&mut self) -> agenticdriver::Result<()> {
            self.0.clear();
            Ok(())
        }
    }
    let mut backend = Backend(String::new());
    handle_provider_panel(
        &mut backend,
        &serde_json::json!({"action":"connect","invitation":"application-hook"}),
    )
    .unwrap();
    assert_eq!(backend.0, "application-hook");
    let state =
        handle_provider_panel(&mut backend, &serde_json::json!({"action":"disconnect"})).unwrap();
    assert_eq!(state["connected"], false);
    assert_eq!(backend.0, "");
}
