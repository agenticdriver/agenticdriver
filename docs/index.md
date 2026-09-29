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
    details: Keep your application's authentication, explicit tool approvals and existing Usagestat backend. Apps own identities, workflows and accepted changes.
    link: /authentication
---

## Build with a tested foundation

The **0.2.0-rc.1** packages are published on npm, crates.io and the public Go
module proxy. Follow [RC adoption](rc.md) for exact versions, host upgrades and
connection setup. Stable npm `latest` remains **0.1.0**. Python uses reviewed
archives while approval of the selected PyPI organization remains pending.
The [release inventory](releases.md) records download availability; the
[RC gate](release-candidate.md) separates real account checks, application
acceptance and build verification. Fresh hosts start empty and connect actual
provider accounts. Other models, providers and operating systems need their own
qualification.

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
package. Use public or permitted content and deliberately select a provider instance,
account and model that your host is authorized to use.

The [provider settings component](provider-panel.md) embeds provider/model management and guided connection setup in the four published RC language packages. The [Linux desktop companion](desktop.md) manages local and remote hosts, provider accounts, usage and application connections.
