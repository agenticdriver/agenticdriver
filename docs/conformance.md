# Protocol conformance

Run `npm run check` and `npm run test:clients` to verify the protocol and all four
clients. The suite uses synthetic data and a local reference peer; it never
loads an API key or starts a native agent.

Scheduling tests check tenant rotation, account alias isolation, bounded queues,
cancellation, shutdown and control requests under saturation. Fake-clock checks
keep queued work pending for 30 days without starting a configured inactivity
timer. Resource tests cover unknown/partial usage, observed caps before tools,
authority failures and the existing Usagestat quota API. These fixtures do not
certify live provider costs, quota freshness or an external reservation service.

`protocol/fixtures/versioning.json` supplies seven shared compatibility cases.
`protocol/fixtures/conformance.json` supplies transport and payload cases that
every client executes against identical responses from
`tests/conformance-host.ts`. The host can fragment UTF-8 across writes, vary SSE
line endings, send oversized frames, return invalid payloads, leave a stream
open for cancellation, or attempt a redirect. Fixture bodies remain readable;
large payloads are represented as repeat instructions.

The same harness also starts the real SDK host. It checks provider/tool scopes,
unknown or unauthorized tokens, quiet execution without a configured timeout,
progress that outlives a configured idle interval, and a stalled run that expires
only when an idle timeout is supplied. The runtime's fake-clock unit tests cover
a week of silence with the default timer disabled and verify that transport
pings cannot keep an idle run alive.

Each language closes an unfinished reference stream; host metrics verify all
four disconnects and assert that no redirect target was contacted. The harness
runs over loopback HTTP and certificate-verified HTTPS using an ephemeral test
certificate. It also checks certificate hostname mismatch, and clients with
per-instance trust stores reject the certificate when the test CA is omitted.

## Consumer rules

- SSE accepts LF, CRLF and CR, including split delimiters, a leading UTF-8 BOM,
  comments and multiline `data` fields. Invalid UTF-8 is rejected.
- The 2 MB event bound counts UTF-8 bytes in the frame's lines, including field
  names and comments but excluding line terminators and the leading BOM. It is
  not a character count. JSON responses have a separate 2 MB byte bound.
- `run.started` must come first and cannot repeat. Every event has a valid
  timestamp and the next wire sequence, and belongs to the same run. Optional
  extensions do not bypass these checks.
- Known payloads are validated before delivery. A terminal result must belong
  to the requested provider/model and the same run, and must include valid
  usage, steps and finish reason. Missing or negative measurements are not
  silently normalized into a successful result.
- A client completes on its first valid terminal event and closes the response;
  hosts must not emit further events. EOF before a terminal event produces
  `INCOMPLETE_STREAM`. Cancellation by the application closes the connection.
- Malformed JSON/event shapes produce `INVALID_RESPONSE` or `INVALID_STREAM`
  according to the operation; event byte-limit failures produce
  `RESPONSE_TOO_LARGE`. Provider error codes remain intact, including unknown
  codes. Transport-library errors can still identify initial connection or TLS
  failures; they never represent a successful run.

The harness verifies behavior in the environment where it runs. It does not
certify vendor accounts, operating systems outside the CI matrix, or package
publication; those have separate roadmap items.

## Application function bridge

Each binding executes its own lookup function against the real host over HTTP
and verified HTTPS, with both automatic read-only execution and interactive
approval. The tests assert one invocation, accepted progress/results, the returned
output, a successful terminal event and rejection of a stale result. Shared peer
fixtures also reject malformed/unselected invocations, duplicate execution or call
IDs, unnegotiated events and receipts with altered identities or status. Core tests
cover scopes, host/token review requirements, input/output schemas, cancellation,
explicit idle expiry, pending capacity and replay without redispatch.

The shared suite also checks session metadata, identity/revision matching, visible-history shapes, deletion receipts and selected-run continuation. Every language creates a session, completes two turns through run/stream APIs, rejects a stale revision, reads its visible history and deletes it against HTTP and verified HTTPS hosts. Native API fixtures check private state preservation without including it in public history.
