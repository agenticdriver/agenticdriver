import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { RetrievalHit } from "../src/retrieval-types.js";

const base = {
  id: z.string(),
  sourceId: z.string(),
  revision: z.string(),
  chunkId: z.string(),
  text: z.string(),
  question: z.string(),
  reference: z.unknown(),
};
const scenarioSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("brand"),
      rules: z
        .object({
          count: z.number().int().positive(),
          minNameLength: z.number().int(),
          maxNameLength: z.number().int(),
          maxTaglineWords: z.number().int(),
          requiredWord: z.string(),
          forbiddenWords: z.array(z.string()),
          colours: z.array(z.string()),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("literature"),
      facts: z.array(z.object({ id: z.string(), text: z.string() }).strict()),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("email"),
      threadId: z.string(),
      label: z.string(),
      draft: z.string(),
    })
    .strict(),
]);
const bytes = readFileSync(
  new URL("../evaluations/scenarios.json", import.meta.url),
);
export const dataset = z
  .object({
    version: z.literal(1),
    classification: z.string(),
    scenarios: z.array(scenarioSchema).length(3),
  })
  .strict()
  .parse(JSON.parse(bytes.toString("utf8")));
export const datasetSha256 = createHash("sha256").update(bytes).digest("hex");
export type Scenario = z.infer<typeof scenarioSchema>;
export interface Check {
  id: string;
  passed: boolean;
}
export interface QualityScore {
  passed: boolean;
  checks: Check[];
}
const finish = (checks: Check[]): QualityScore => ({
  passed: checks.every((c) => c.passed),
  checks,
});
const normal = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** A versioned synthetic rubric. Evidence ID validity alone does not establish claim support. */
export function scoreScenario(
  scenario: Scenario,
  output: unknown,
  evidence: readonly RetrievalHit[],
): QualityScore {
  const checks: Check[] = [];
  const check = (id: string, passed: boolean) => checks.push({ id, passed });
  if (scenario.kind === "brand") {
    const parsed = z
      .object({
        proposals: z
          .array(
            z
              .object({
                name: z.string(),
                tagline: z.string(),
                colour: z.string(),
              })
              .strict(),
          )
          .max(20),
      })
      .strict()
      .safeParse(output);
    check("shape", parsed.success);
    if (!parsed.success) return finish(checks);
    const proposals = parsed.data.proposals,
      r = scenario.rules;
    check("proposal-count", proposals.length === r.count);
    check(
      "distinct-names",
      new Set(proposals.map((p) => normal(p.name))).size === proposals.length,
    );
    check(
      "name-length-and-alphabet",
      proposals.every(
        (p) =>
          /^[a-z ]+$/i.test(p.name.trim()) &&
          p.name.trim().length >= r.minNameLength &&
          p.name.trim().length <= r.maxNameLength,
      ),
    );
    check(
      "tagline-constraint",
      proposals.every(
        (p) =>
          normal(p.tagline).split(" ").length <= r.maxTaglineWords &&
          normal(p.tagline).split(/\W+/).includes(r.requiredWord),
      ),
    );
    check(
      "forbidden-words",
      proposals.every(
        (p) =>
          !normal(p.name + " " + p.tagline)
            .split(/\W+/)
            .some((w) => r.forbiddenWords.includes(w)),
      ),
    );
    check(
      "selected-palette",
      proposals.every((p) => r.colours.includes(p.colour.toUpperCase())),
    );
  } else if (scenario.kind === "literature") {
    const parsed = z
      .object({
        claims: z
          .array(
            z
              .object({
                id: z.string(),
                text: z.string(),
                citations: z
                  .array(
                    z
                      .object({
                        sourceId: z.string(),
                        revision: z.string(),
                        chunkId: z.string(),
                        quote: z.string().min(1),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(16),
              })
              .strict(),
          )
          .max(20),
      })
      .strict()
      .safeParse(output);
    check("shape", parsed.success);
    if (!parsed.success) return finish(checks);
    const claims = parsed.data.claims;
    check(
      "required-facts",
      claims.length === scenario.facts.length &&
        scenario.facts.every(
          (f) => claims.filter((c) => c.id === f.id).length === 1,
        ),
    );
    check(
      "supported-claims",
      claims.every((c) =>
        scenario.facts.some(
          (f) => f.id === c.id && normal(f.text) === normal(c.text),
        ),
      ),
    );
    check(
      "selected-current-evidence",
      claims.every((c) =>
        c.citations.every(
          (cite) =>
            cite.sourceId === scenario.sourceId &&
            cite.revision === scenario.revision &&
            evidence.some(
              (hit) =>
                hit.source.id === cite.sourceId &&
                hit.source.revision === cite.revision &&
                hit.chunkId === cite.chunkId &&
                hit.text.includes(cite.quote),
            ),
        ),
      ),
    );
    check(
      "claim-supporting-quote",
      claims.every((c) =>
        c.citations.some((cite) => normal(cite.quote) === normal(c.text)),
      ),
    );
  } else {
    const parsed = z
      .object({
        actions: z
          .array(
            z.discriminatedUnion("type", [
              z
                .object({
                  type: z.literal("label"),
                  threadId: z.string(),
                  label: z.string(),
                })
                .strict(),
              z
                .object({
                  type: z.literal("draft"),
                  threadId: z.string(),
                  body: z.string(),
                })
                .strict(),
            ]),
          )
          .max(20),
      })
      .strict()
      .safeParse(output);
    check("review-only-action-shape", parsed.success);
    if (!parsed.success) return finish(checks);
    const actions = parsed.data.actions;
    check(
      "selected-thread",
      actions.every((a) => a.threadId === scenario.threadId),
    );
    check(
      "exact-action-set",
      actions.length === 2 &&
        actions.filter((a) => a.type === "label").length === 1 &&
        actions.filter((a) => a.type === "draft").length === 1,
    );
    check(
      "correct-label",
      actions.some((a) => a.type === "label" && a.label === scenario.label),
    );
    check(
      "correct-draft",
      actions.some((a) => a.type === "draft" && a.body === scenario.draft),
    );
  }
  return finish(checks);
}
