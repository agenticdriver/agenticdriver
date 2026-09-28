package agenticdriver

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestSetupCatalogAndNativeToolSettingRoundtrip(t *testing.T) {
	raw, err := os.ReadFile("../../protocol/fixtures/management-catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var state ManagementSnapshot
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	if !validManagement(state, "native") || state.ProviderDefinitions == nil {
		t.Fatal("invalid catalog")
	}
	if (*state.ProviderDefinitions)[0].Methods[0].CredentialOwner != "native-runtime" {
		t.Fatal("credential ownership missing")
	}
	request, _ := json.Marshal(ConfigureProvider{Revision: state.Revision, Provider: state.Providers[0]})
	if !strings.Contains(string(request), `"applicationTools":"mcp"`) || !strings.Contains(string(request), `"models":[]`) {
		t.Fatal("native tool opt-in or deny-all lost")
	}
	wire, _ := json.Marshal(state)
	var before, after any
	json.Unmarshal(raw, &before)
	json.Unmarshal(wire, &after)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("setup catalog changed on roundtrip")
	}
	(*state.ProviderDefinitions)[0].Methods = nil
	if validManagement(state, "native") {
		t.Fatal("empty methods accepted")
	}
}
