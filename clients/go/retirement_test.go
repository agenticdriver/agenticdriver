package agenticdriver

import (
	"encoding/json"
	"testing"
)

func TestRetirementRequiresExactAffirmativeFence(t *testing.T) {
	request := RetrievalRetire{Corpus: "library", SourceID: "paper-immutable", Revision: "revision-1"}
	var wire wireObject
	data, _ := json.Marshal(map[string]any{"corpus": request.Corpus, "sourceId": request.SourceID, "revision": request.Revision, "deleted": false})
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatal(err)
	}
	if _, err := retirementReceipt(wire, request); err == nil {
		t.Fatal("ordinary deletion must not acknowledge retirement")
	}
	wire["retired"] = []byte("false")
	if _, err := retirementReceipt(wire, request); err == nil {
		t.Fatal("false fence must be rejected")
	}
	wire["retired"] = []byte("true")
	result, err := retirementReceipt(wire, request)
	if err != nil || !result.Retired || result.Deleted {
		t.Fatalf("valid absent-document fence rejected: %v", err)
	}
	wire["revision"] = []byte(`"other-revision"`)
	if _, err := retirementReceipt(wire, request); err == nil {
		t.Fatal("wrong identity must not acknowledge retirement")
	}
}
