use agenticdriver::{ConfigureProvider, ManagementSnapshot};

#[test]
fn provider_settings_preserve_absent_empty_and_explicit_overrides() {
    let state: ManagementSnapshot =
        serde_json::from_str(include_str!("../../../protocol/fixtures/management.json")).unwrap();
    assert!(state.providers[0].models.is_none());
    assert_eq!(state.providers[1].models.as_ref().unwrap().len(), 0);
    assert_eq!(
        state.providers[2].models.as_ref().unwrap(),
        &vec!["explicit".to_owned()]
    );
    for provider in state.providers {
        let request = ConfigureProvider {
            revision: state.revision.clone(),
            provider: provider.clone(),
            api_key: None,
        };
        let wire = serde_json::to_value(request).unwrap();
        assert!(wire.get("apiKey").is_none());
        if provider.models.is_none() {
            assert!(wire["provider"].get("models").is_none());
        } else {
            assert_eq!(
                wire["provider"]["models"],
                serde_json::to_value(provider.models.unwrap()).unwrap()
            );
        }
    }
}
