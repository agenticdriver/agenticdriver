# Application examples

All examples require an explicitly selected real provider, account and model.
The desktop starts empty; there is no offline provider or canned response mode.

The [real application runner](../examples/javascript/real-applications.mjs)
uses a paired connection profile and records the actual response and reported usage.
Its [public prompts](../examples/javascript/real-application-prompts.mjs) cover:

- **Brandstorm:** three brand directions for AgenticDriver, preserving its name,
  audience and product constraints.
- **Literature review:** experiments for evidence selection and ordering, grounded
  in notes from Lewis et al. (arXiv:2005.11401) and Liu et al. (arXiv:2307.03172).
- **Email workspace:** a draft of the actual alpha.5 release handoff, distinguishing
  published artifacts, pending PyPI approval and unconfirmed app adoption.

```sh
npm run test:real -- --connection /private/app/profile.json \
  --provider YOUR_CONNECTED_INSTANCE --model YOUR_SELECTED_MODEL \
  --case all --receipt /private/results.json
```

This makes three model requests and can consume the selected account's allowance.
Use `--case brandstorm`, `literature` or `workspace` for one request. The runner
checks the account-reported catalog and host permissions before inference. It never
switches providers, accounts, models or billing modes. Review the answers as well as
the completion receipt; a completed stream is not proof of answer quality.

For an embedded TypeScript runtime, use `examples/brandstorm.ts`,
`examples/literature-review.ts` or `examples/email-workspace.ts`. Set
`AGENTICDRIVER_PROVIDER`, `AGENTICDRIVER_ACCOUNT_ID` (the selected instance ID),
and `AGENTICDRIVER_MODEL`. Native sessions can additionally select
`AGENTICDRIVER_BINARY` and `AGENTICDRIVER_ACCOUNT_DIRECTORY`; API adapters require
their documented provider key on the execution host. The installed npm archive
contains equivalent `.mts` examples under `examples/javascript`.

The [application-tool example](../examples/application-tools.ts) performs an actual
text search over the Markdown file named by `AGENTICDRIVER_INPUT_FILE`, using a
real provider that supports application tools. It is a lexical search example;
semantic indexing requires a real embedding account and the [retrieval API](retrieval.md).
The [approval example](../examples/approvals.ts) asks a real model for a brand
proposal and saves it in memory only after human approval.

Full app acceptance belongs to Brandstorm, LitAgent and AI Workspace. These SDK
examples do not send mail, modify a research library or save product designs.
See [real connection setup and evidence](real-connections.md).
