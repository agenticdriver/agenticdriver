# Adopt 0.2.0-rc.3

The release candidate targets Linux x64 hosts and the desktop companion, with
TypeScript/JavaScript, Python, Go and Rust clients. Wire protocol remains **1.0**.
RC.3 adds the desktop Overview and explicit local/remote Codex installation,
retaining RC.2's native quota correction and released Usagestat 2.0.0 integration.
The [publication receipt](validation/release-0.2.0-rc.3.md) records source
`f319f173f55069a2ca0f91969bac99c169a063d2`, package integrity and current adoption.
The three apps' accepted workflows remain RC.2 evidence until their RC.3 updates
pass their own checks.
Check the [release inventory](releases.md) and [qualification gate](release-candidate.md)
for the current download and acceptance status. A release candidate is an opt-in
version; stable npm `latest` remains **0.1.0**.

## Install an exact version

```sh
npm install --save-exact @agenticdriver/sdk@0.2.0-rc.3
go get github.com/agenticdriver/agenticdriver/clients/go@v0.2.0-rc.3
```

Rust: use `agenticdriver = "=0.2.0-rc.3"` in `Cargo.toml`.
Commit the version and lockfile. The npm archive SHA-256 is
`23db3a8269357b1e4f2568a4836588c3c70e8bf60e3869e5d940b362ebe3f070`.
Verify other download digests against the release `ASSET-SHA256SUMS`.

Python uses **0.2.0rc3**. Download
`agenticdriver-0.2.0rc3-py3-none-any.whl` from the
[RC release](https://github.com/agenticdriver/agenticdriver/releases/tag/v0.2.0-rc.3),
verify its entry in `ASSET-SHA256SUMS`, then install it in a virtual environment:

```sh
python -m pip install ./agenticdriver-0.2.0rc3-py3-none-any.whl
```

The selected PyPI organization is still awaiting approval. No personal publisher
or unrelated PyPI package is substituted. The source distribution is also
included in the release downloads.

The Linux desktop download is `AgenticDriver-0.2.0-rc.3-linux-x64.tar.gz`.
After checking its digest, extract it and launch `agenticdriver-desktop`.
Node and Electron are bundled. Native provider CLIs are separate dependencies;
RC.3 can explicitly install the qualified Codex 0.157.0 Linux x64 executable on
the selected local or remote host. Its [managed runtime guide](provider-runtimes.md)
covers download verification, progress, cancellation and explicit executable
selection. Installation creates no provider, sign-in or application execution
grant and makes no model call. Other native runtimes use official manual routes.
The [desktop guide](desktop.md) covers private state, user-local installation,
upgrades and retained previous versions. There is no automatic updater.

## Connect an application

1. Start the desktop and add an existing native provider account, or configure a
   real host using the [host guide](host.md). New profiles contain no providers,
   connections or invented usage. Provider sign-in and model execution are
   separate steps; metadata refresh does not submit a prompt.
2. In **Connections**, name the application and select its providers, permissions
   and lifetime. Choose where the application's backend runs, then create a
   one-use invitation. Keep operator credentials on the original host.
3. Import the invitation using the application's settings or the language
   client's [pairing API](connections.md). Keep its resulting credential in the
   application's private backend store. A local browser does not make a remote
   backend's `127.0.0.1` refer to your computer.
4. For another computer, use reachable HTTPS with a trusted certificate or an
   explicitly configured SSH route. The desktop can manage outbound OpenSSH
   routes to existing trusted destinations; it does not provide a public relay,
   copy provider credentials or open firewall ports.
5. Select the provider instance, account and exact model in the application.
   All reported account models remain discoverable. Host permissions and
   per-connection overrides, application enablement and live qualification are
   separate. A refresh preserves saved choices and leaves active runs running.

The [shared provider component](provider-panel.md) works through native backend
bindings in all four languages. It displays reported CLI versions, subscription
information and account identity masked until Reveal. A management grant permits
remote settings changes; an execution-only connection remains read-only.

Applications retain their authentication, source permissions and accepted data.
An SDK update neither installs an authentication system nor expands a host grant.
Do not use an expiring validation connection as a production credential.

## Upgrade safely

Check active work and drain the host before restarting it. Preserve its private
configuration, native account directories, connection state, usage identity and
durable records. Upgrade the host before management clients, or coordinate both
in one maintenance window. An application dependency update cannot replace a
separately running host. Older pre-alpha.6 management hosts advertise a removed
provider category; see [migration notes](migrations.md).

Verify connection/reload, explicit selection, disabled execution, cancellation
and recovery using useful public or permitted content. Do not switch accounts,
models or billing modes to conceal a failure. `RATE_LIMITED` reports a provider
quota rejection; it does not authorize an automatic retry or overage billing.
Generation has no default deadline or inactivity timeout.

## Retrieval and usage

Real PDF, Markdown and email ingestion can feed a scoped persistent vector
index. The optional [local embedding adapter](local-embeddings.md) uses a pinned
CPU model and requires an explicit model download and host setup. Ordinary
SDK installs do not include its Transformers runtime. Enabling retrieval also
requires corpus/source permissions; installing the package does not grant them.
Citation-ID helpers check that references exist in the supplied evidence; they
do not prove entailment or factual correctness.

Usage continues through the existing [Usagestat integration](usagestat.md).
The desktop reads its configured service and shows reported freshness and
missing measurements. Selecting a remote host does not automatically bind its
accounts to a local usage endpoint. Keep unknown usage unknown.

## Qualified scope

The selected inexpensive native models are Codex **0.157.0**, **gpt-6-luna**
with **medium** reasoning, and Claude Code **2.1.282**,
**claude-haiku-4-5-20251001**. Read the [current evidence](release-candidate.md)
before treating a particular workflow as accepted. Other native providers,
API billing routes, models, macOS and Windows require separate live checks.
Successful model completion does not by itself accept an application artifact
or authorize sending email, modifying a library or applying brand decisions.
