# Real managed runtime validation — 2026-09-30

The post-RC.2 source candidate installs the qualified Codex CLI from the shared
provider panel on Linux x64. This evidence concerns issue
[AD-082 / #79](https://github.com/agenticdriver/agenticdriver/issues/79). Released
RC.2 hosts do not yet offer `provider-runtimes`. Fresh hosts remained empty until
an explicit provider configuration was saved. No provider substitute, seeded
account, canned response or invented usage was used.

## Actual local and remote installation

The desktop renderer and real desktop controller used a separate private local
host. The second host ran in Prometheus's independent
`agenticdriver-managed-runtime-test.service`, bound to `127.0.0.1:17444` and reached
through verified OpenSSH. Existing application hosts, RC.2 services, CI workers
and native sign-ins were preserved. Provider credentials stayed on Prometheus.

Both hosts downloaded the official OpenAI `rust-v0.157.0` Linux x64 musl asset:

| Artifact             |       Bytes | SHA-256                                                            |
| -------------------- | ----------: | ------------------------------------------------------------------ |
| Release archive      | 107,842,066 | `db3fe3adaa35c50edfb68a988a117782fe3492960fb63d7003eb6748ccc0657b` |
| Extracted executable | 285,340,072 | `1a822376d4634ac32dddc030e5117c63359f7f8cd4b1b64382c68190287d0258` |

The executable returned `codex-cli 0.157.0` using a new empty version-check
profile. Its files were private to the host user. Native account profiles and the
normal CLI were not replaced. Installation did not configure a provider, sign in,
run a model or alter execution grants.

Local cancellation followed actual download progress of 23,319 bytes. The owning
credential cancelled the attempt; a second management credential could inspect
status but was rejected when attempting cancellation. Staging and lock files
were removed, provider configuration bytes stayed unchanged, and the temporary
peer grant was revoked. The desktop subsequently retried and completed the real
installation. Remote installation was also cancelled through the panel and then
explicitly retried to completion on Prometheus.

A further real local lifecycle check used the official download and verified:

- Graceful shutdown cancels the owned install and removes staging/lock files.
- Restart reports a missing runtime after cancellation and an installed runtime
  after completed verification.
- Unsafe permissions on the actual executable report `RUNTIME_DAMAGED`; an
  install request does not overwrite it. Restoring private permissions permits
  a fresh integrity check.
- Moving the completed installation out of the store reports `missing` and
  returns no executable path, even within the process that completed the install.
  Restoring it permits reuse.

## Actual account and model run

After installation, an explicit management request configured one provider on
the separate Prometheus host using the new executable and the existing selected
native account directory. The account reported a ChatGPT Pro sign-in, Codex CLI
`0.157.0` and nine catalog entries. No host model allowlist override was added.
The management connection retained an empty execution grant.

One new, short-lived execution connection received only this provider instance.
It ran `gpt-6-luna` with medium reasoning in native subscription mode. The
meaningful [brand brief](../../examples/javascript/real-application-prompts.mjs)
requested three AgenticDriver directions with taglines, hex colours, motifs and
developer-audience rationales. It explicitly excluded universal compatibility,
automatic routing and guaranteed-accuracy claims. No private application content
was submitted.

Run `24f5308c-4586-4ad8-bfa0-d46ac75a2f47` completed with three distinct directions:
Control Plane, Workshop and Field Notes. The answer included the requested
elements and was reviewed against the brief. A catalog refresh after run start
returned all nine entries without cancelling the run. Only Luna was executed;
catalog discovery does not qualify the remaining models.

| Native reported measurement |        Value |
| --------------------------- | -----------: |
| Input tokens                |        6,129 |
| Output tokens               |          235 |
| Cached input tokens         |            0 |
| Reasoning tokens            |            0 |
| Billed cost                 | Not reported |

The independent host's JSONL usage record matched those measurements. It had no
Usagestat ingestion binding; this check does not claim automatic forwarding from
the new test host. Existing metered RC.2 application services were untouched.
The execution grant was revoked after the run. There was one attempt and one
model step, with no generation deadline or inactivity timeout.

## Shared component and language checks

The actual desktop panel displayed remote installation, progress, cancellation,
retry and explicit **Use for this connection**. That action selected the
Prometheus filesystem path in the new connection draft. It did not save a
provider or start sign-in. After restarting the desktop controller, the managed
runtime remained verified and reusable.

Native collaborative-browser checks covered 1920×1080 and 390×844 layouts with
no horizontal overflow. The existing connection displayed its real CLI version,
subscription and masked identity. The Overview displayed one signed-in configured
provider and nine reported models after refresh. This is renderer/controller
evidence; it does not assert every native-window interaction was tested.

All four language clients read the actual remote `installed` status. Python used
a freshly built, installed wheel for sync/async calls; Rust used the packaged
crate in an independent application for blocking/async calls. Go compiled an
independent application with the source candidate module. Its source-module check
is not a claim of registry availability. A Python install request against the
already verified runtime returned the same executable without another download.
Those management checks caused no additional model calls.

Local typechecking, 34 pure/real-empty-host tests (one live-account-dependent skip),
all language package checks, seven desktop checks, protocol generation and a fresh
npm package installation passed. Protocol/IPC/schema checks use no replacement
model server and are separate from the actual install and inference above.
Prometheus CI and the resulting immutable desktop artifact are tracked on #79.

Private full receipts and profiles are retained under local validation state.
Public evidence excludes account email/name, native account paths and credential
values. This qualifies the selected Linux x64 Codex runtime and connection at the
recorded time; it does not qualify other providers, OS installers, auto-update,
new sign-in completion, other models or the three consuming applications' full
workflows.
