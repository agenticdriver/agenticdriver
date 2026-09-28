# Real local and remote connections

Use the execution host on the computer that owns the selected native sign-in or
provider API key. The connecting application needs only its scoped driver
credential. The same installed TypeScript, Python, Go and Rust clients work
through local loopback, verified HTTPS or loopback behind an SSH tunnel.

## Start the host beside the account

Install the [published alpha](alpha.md), then follow the [real-provider
quickstart](quickstart.md#_2-connect-your-provider-account). Select a supported
native runtime and the intended account directory explicitly. Installing a
qualified CLI in a separate directory lets an existing installation keep its
own version. It does not require copying the account's credential files.

Use an independent host configuration and service for testing. Keep the normal
application hosts and CI workers separate. Bind to `127.0.0.1` when using SSH.
All account-reported models remain visible by default; a model catalog is not
proof of entitlement, available quota or successful inference. Every generation
still names its provider instance and exact model.

`agenticdriver serve --config /private/driver/config.json` starts the host in the
foreground. For a persistent process, use the [systemd recipe](host.md#run-as-a-service-and-upgrade).
Grant management separately from model execution. A management-only connection
can administer providers without receiving inference access itself.

## Connect through existing SSH access

On the application backend computer, forward an unused loopback port to the
execution host's loopback listener. This example assumes port `17435` on each:

```sh
ssh -N -T -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes -o ForwardAgent=no -o ForwardX11=no \
  -L 127.0.0.1:17435:127.0.0.1:17435 YOUR_EXISTING_SSH_ALIAS
```

Keep that SSH process running. Use the existing trusted host key and native SSH
login. A loopback address refers to the backend's network namespace; a container
needs the tunnel beside that backend. No public driver port or provider API key
is required on the application computer. The SSH server remains a trusted
endpoint; its administrators can observe traffic on its loopback interface.

On the execution host, create an invitation for the intended application and
explicit provider IDs. Set the invitation URL to the application's tunnel port:

```sh
umask 077
agenticdriver pair --config /private/driver/config.json \
  --subject my-application --provider-ids my-codex,my-claude \
  --url http://127.0.0.1:17435/ --json > /private/invitation-result.json
```

This JSON contains an `invitation` secret. Extract that field into a private text
file and transfer it through SSH to the application machine. Do not paste it into
logs, issues or browser storage. Alternatively use the desktop's **Connections**
screen to create and review an invitation. Include `--manage` only for an intended
operator connection.

On the application machine:

```sh
agenticdriver connect --invite-file /private/invitation.txt \
  --connection /private/my-application/profile.json
```

The command saves a private profile and sibling token file. It does not copy the
provider's login. The invitation is single-use; existing app connections do not
gain access when a new provider is added. Host-side expiry and revocation apply
through SSH just as they do through HTTPS. A dropped tunnel requires an explicit
reconnection; never replay uncertain model work automatically.

## Run meaningful examples

The repository includes a [real-example runner](../examples/javascript/real-applications.mjs)
and its [public prompts](../examples/javascript/real-application-prompts.mjs).
Copy both files into an application directory with `@agenticdriver/sdk@0.2.0-alpha.5`
installed. Choose an inexpensive model actually reported by the selected account:

```sh
node real-applications.mjs \
  --connection /private/my-application/profile.json \
  --provider YOUR_PROVIDER_ID --model YOUR_REPORTED_MODEL \
  --case all --receipt /private/real-results.json
```

The cases cover AgenticDriver's brand brief, evidence selection based on two
published papers, and an email draft based on the actual alpha.5 release handoff.
The runner refuses mock/no-account connections, checks discovery and host model
permissions, and submits each prompt once. Add `--refresh-during-run` to refresh
metadata after each run starts. There is no default generation deadline or
inactivity timeout; Ctrl+C cancels the request. Prompt length guidance is not a
hard token budget enforced by a native CLI.

Receipts include the exact prompts, sources, responses, selected model, runtime,
reported subscription, event counts and usage. Email/name and credential values
are omitted. Receipt files are private and cannot overwrite an earlier run.
Keep them private if you adapt the prompts to application data. Review the actual
answers: a completed stream is not an assertion of accuracy or app acceptance.

For Python, Go and Rust, the [language quickstarts](quickstart.md#_3-connect-a-language-client)
read `AGENTICDRIVER_INPUT_FILE`. Point it at the supplied
[brand brief](../examples/quickstart/brand-brief.txt) or your own permitted example,
and supply the selected host URL, private driver token file, provider and model.
These clients do not need a Node installation; only the execution host does.

## Observed remote results

The [Prometheus receipt](validation/prometheus-real-2026-09-28.md) records nine
completed real requests through SSH using published clients in all four
languages, with Codex Luna and Claude Haiku. It also covers real pairing,
revocation, provider edits and catalog refresh during generation. It does not
certify other models, a container isolation boundary, vector retrieval or the
three applications' complete user flows.
