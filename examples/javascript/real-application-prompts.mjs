// Public project facts and paraphrases of published research, not private app data.
export const applicationPrompts = {
  brandstorm: {
    title: "Brand directions for AgenticDriver",
    sources: ["https://github.com/agenticdriver/agenticdriver"],
    input: `Develop three distinct brand directions for AgenticDriver (agenticdriver.dev).
The product is an SDK for TypeScript, Python, Go and Rust applications. Developers
connect their own provider API accounts or supported native subscription sessions.
Execution can happen locally or on a remote host using HTTPS or an SSH tunnel.
Applications explicitly choose the provider, account connection and model. The
target audience is developers building research assistants, email workspaces and
creative tools. The name AgenticDriver must stay. Do not promise universal provider
compatibility, unlimited usage, automatic model routing or guaranteed accuracy.
For each direction give a tagline, two hex colours, a visual motif, and one sentence
explaining why it fits this audience. Keep the whole answer below 220 words.`,
  },
  literature: {
    title: "Evidence selection and ordering in a literature assistant",
    sources: [
      "https://arxiv.org/abs/2005.11401v4",
      "https://arxiv.org/abs/2307.03172v3",
    ],
    input: `Answer using only these notes from two real papers; cite the arXiv IDs.
[2005.11401] Lewis et al., Retrieval-Augmented Generation for Knowledge-Intensive
NLP Tasks (NeurIPS 2020). The work combines a pretrained sequence-to-sequence model
with neural retrieval over a Wikipedia vector index. It compares shared passages
throughout generation with passages that can change per token. Evaluations found
better factuality than the tested parametric-only baseline.
[2307.03172] Liu et al., Lost in the Middle: How Language Models Use Long Contexts
(TACL 2023). On multi-document question answering and key-value retrieval tasks,
performance depended on where relevant information appeared. It was often better
near either end than in the middle, including for models designed for long context.
Question: What two design experiments should a literature assistant run for evidence
selection and ordering? Separate reported findings from your proposed experiments.
Explain why neither paper establishes that every generated answer will be correct.
Use at most 160 words. Do not invent results, statistics or additional references.`,
  },
  workspace: {
    title: "Draft the actual alpha.5 application handoff email",
    sources: [
      "https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-alpha.5",
    ],
    input: `Draft an email from these AgenticDriver release handoff notes dated
2026-09-28. This is a draft only; no email will be sent.
The npm package @agenticdriver/sdk@0.2.0-alpha.5 is published under the alpha tag.
Rust agenticdriver 0.2.0-alpha.5 and the Go clients/go/v0.2.0-alpha.5 tag are published.
Python 0.2.0a5 wheel and source archives are on the GitHub prerelease; PyPI organization
approval is still pending. Brandstorm, LitAgent and AI Workspace should pin alpha.5,
refresh their connected host's provider catalog, then validate an explicitly selected
provider and inexpensive model. Application authentication stays owned by each app.
Catalog discovery alone does not prove model execution. Adoption by all three apps
has not yet been confirmed. Do not claim the Python package is on PyPI or that the
apps have already upgraded. Produce a subject, a concise body and three action items,
below 170 words total. Do not invent recipients, deadlines or completed checks.`,
  },
};
