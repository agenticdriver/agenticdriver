package agenticdriver

import "testing"

func TestCitationMembership(t *testing.T) {
	ids, err := ValidateSourceCitations("Evidence [source:paper-1] and [source:paper-1]", []string{"paper-1"}, true)
	if err != nil || len(ids) != 1 || ids[0] != "paper-1" {
		t.Fatalf("citation result: %v %v", ids, err)
	}
	for _, text := range []string{"No citation", "[source:unknown]", "[source:", "[source:]", "[source:paper-1][source:unknown]"} {
		_, err := ValidateSourceCitations(text, []string{"paper-1"}, true)
		if failure, ok := err.(*Error); !ok || failure.Code != "INVALID_CITATION" {
			t.Fatalf("invalid citation accepted: %q", text)
		}
	}
	if ids, err := ValidateSourceCitations("No citations required", nil, false); err != nil || len(ids) != 0 {
		t.Fatal(err)
	}
}
