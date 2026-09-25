---
layout: home
title: Bring your agent to your application
description: AgenticDriver is an SDK for explicitly selected AI accounts, local and remote execution, application tools, selected context and usage.
hero:
  name: AgenticDriver
  text: Your agent. Your application.
  tagline: One SDK for local and remote execution. Bring the account, choose the model, and keep your application's data and decisions in your application.
  actions:
    - theme: brand
      text: Install and connect
      link: /quickstart
    - theme: alt
      text: Explore three recipes
      link: /applications
features:
  - title: Choose your execution host
    details: Embed the runtime in TypeScript or connect JavaScript, Python, Go and Rust clients over verified HTTPS. Provider credentials stay on the host.
    link: /deployment
  - title: Bring selected context
    details: Index PDF, Markdown and email evidence. Scope retrieval to authorized sources and keep source revisions and citation locations with the answer.
    link: /retrieval
  - title: Keep application control
    details: Use Better Auth with AuthYard, explicit tool approvals and your existing Usagestat backend. Apps own identities, workflows and accepted changes.
    link: /authentication
---

## Build with a tested foundation

SDK 0.1.0 is available on npm, crates.io and the public Go module proxy. Python
archives are available from the GitHub release while PyPI organization approval
is pending. See the [release inventory](releases.md) for immutable artifacts and
the distinction between published packages and newer development source.
The selected local Codex route passed [live checks](validation/codex-2026-09-25.md);
other provider and full application qualifications remain pending. Synthetic
examples and container/client tests are labeled throughout these guides.

There is no default run deadline or inactivity timeout. Applications can opt into
an inactivity timeout that resets on real model or tool progress, and can cancel
work explicitly. Read the [compatibility matrix](compatibility.md) and
[provider setup](providers.md) before selecting a live route.

| Application       | Start with                                         | Keep in your application                                         |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| Brandstorm        | Structured brand directions from a chosen brief    | Revisions, accepted identity decisions and approvals             |
| Literature review | Questions over selected evidence with citation IDs | Papers, review stages, passage ownership and citation validation |
| Email workspace   | Summaries, reply drafts and task proposals         | Mailbox OAuth, thread access, sending and action approval        |

The [three recipes](applications.md) use the same SDK and run from its installed
package. Start with synthetic data, then deliberately select a provider instance,
account and model that your host is authorized to use.

The [provider settings component](provider-panel.md) embeds provider/model management and guided connection setup in TypeScript, Python, Go and Rust applications. It is available in development source after 0.1.0.
