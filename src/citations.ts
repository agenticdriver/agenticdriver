import { DriverError } from "./errors.js";

/** Check literal [source:ID] references before accepting a draft. Not a claim-support check. */
export function validateSourceCitations(
  text: string,
  sourceIds: readonly string[],
  options: { requireCitation?: boolean } = {},
): string[] {
  const known = new Set(sourceIds),
    cited = new Set<string>();
  let offset = 0;
  while (true) {
    const start = text.indexOf("[source:", offset);
    if (start < 0) break;
    const end = text.indexOf("]", start + 8);
    const id = end < 0 ? "" : text.slice(start + 8, end);
    if (!id || !known.has(id)) invalid();
    cited.add(id);
    offset = end + 1;
  }
  if (options.requireCitation && !cited.size) invalid();
  return [...cited];
}
function invalid(): never {
  throw new DriverError(
    "INVALID_CITATION",
    "The draft has a missing, malformed or unknown source citation. Review it before acceptance; no correction or retry was attempted.",
  );
}
