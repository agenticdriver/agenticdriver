"""Check source-ID references before draft acceptance, not factual support."""
from collections.abc import Sequence
from ._errors import DriverError


def validate_source_citations(text: str, source_ids: Sequence[str], *, require_citation: bool = False) -> list[str]:
    known, cited = set(source_ids), []
    offset = 0
    while True:
        start = text.find("[source:", offset)
        if start < 0:
            break
        end = text.find("]", start + 8)
        source_id = "" if end < 0 else text[start + 8:end]
        if not source_id or source_id not in known:
            raise DriverError("INVALID_CITATION", "The draft has a malformed or unknown source citation. Review it before acceptance; no correction or retry was attempted.")
        if source_id not in cited:
            cited.append(source_id)
        offset = end + 1
    if require_citation and not cited:
        raise DriverError("INVALID_CITATION", "The draft requires a source citation. Review it before acceptance; no correction or retry was attempted.")
    return cited
