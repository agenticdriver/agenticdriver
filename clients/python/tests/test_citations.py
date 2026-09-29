import unittest
from agenticdriver import DriverError, validate_source_citations


class CitationTests(unittest.TestCase):
    def test_exact_manifest_membership(self):
        self.assertEqual(validate_source_citations("Evidence [source:paper-1] and [source:paper-1]", ["paper-1"], require_citation=True), ["paper-1"])
        for text in ["No citation", "[source:unknown]", "[source:", "[source:]", "[source:paper-1][source:unknown]"]:
            with self.assertRaises(DriverError) as error:
                validate_source_citations(text, ["paper-1"], require_citation=True)
            self.assertEqual(error.exception.code, "INVALID_CITATION")
        self.assertEqual(validate_source_citations("No citations required", []), [])
