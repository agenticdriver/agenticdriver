package agenticdriver

import "strings"

// ValidateSourceCitations checks literal source-ID references before accepting a
// draft. It does not establish that a source supports a claim or retry generation.
func ValidateSourceCitations(text string, sourceIDs []string, requireCitation bool) ([]string, error) {
	known, seen := map[string]bool{}, map[string]bool{}
	for _, id := range sourceIDs {
		known[id] = true
	}
	cited := []string{}
	invalid := func() ([]string, error) {
		return nil, &Error{Code: "INVALID_CITATION", Message: "The draft has a missing, malformed or unknown source citation. Review it before acceptance; no correction or retry was attempted."}
	}
	for {
		start := strings.Index(text, "[source:")
		if start < 0 {
			break
		}
		text = text[start+8:]
		end := strings.Index(text, "]")
		if end < 0 {
			return invalid()
		}
		id := text[:end]
		if id == "" || !known[id] {
			return invalid()
		}
		if !seen[id] {
			cited = append(cited, id)
			seen[id] = true
		}
		text = text[end+1:]
	}
	if requireCitation && len(cited) == 0 {
		return invalid()
	}
	return cited, nil
}
