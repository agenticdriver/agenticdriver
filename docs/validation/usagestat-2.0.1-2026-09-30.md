# Released Usagestat 2.0.1 compatibility — 2026-09-30

Tracking: [AD-085 / #82](https://github.com/agenticdriver/agenticdriver/issues/82).
Dependency: [Usagestat v2.0.1](https://github.com/hashimkarim/usagestat/releases/tag/v2.0.1),
clean source `84bfa891782e1228dd6d2c179f7108e83c5b5aa7`.
The release tag resolves to that source. The Linux x64 archive, its checksum,
manifest and manifest checksum were downloaded and matched their public asset
digests. All 382 extracted manifest files matched their sizes and SHA-256 values.

| Artifact               | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| Linux x64 archive      | `14639690fcba5ed5038628bb6cfd684076e0c494fe6087fd6e01ddbddd299942` |
| Extracted `usagestatd` | `a5e23806972fa7284f3d471880c1ebc1d3254c6c16c28c95f63871a0de8f4542` |

The executable returned `usagestatd 2.0.1`. Its Linux glibc 2.39 baseline remains
separate from the SDK's Node/runtime requirements. These checks used the actual
published native binary and installed registry SDKs, without compiling a new
backend, substituting a provider or submitting a model prompt.

## Existing records and actual observations

A private SQLite backup of the SDK-owned regular LitAgent ingestion store
contained thirteen original native execution records. The released daemon
opened that backup in a separate loopback service. It accepted the existing
private credential references and exact account/subject bindings without changes.
The supported protocol remained `usagestat.run-ingestion.v1`, accepting
`agenticdriver.usage.v2` with a required account.

The installed SDK RC.3 read all thirteen complete original records, resubmitted
each unchanged record for a duplicate receipt, then read them again. No model
execution, tool effect or new event was produced. A real credential for a
different validation service could not read this store. Original records stayed
separate from quota snapshots and daily import totals.

The isolated service also loaded a byte-for-byte copy of the ordinary usage
daemon's actual snapshot cache. The SDK parsed six real cached observations;
original metric values, sources, states and `fetchedAt` remained unchanged.
Five existing administrative validation bindings yielded three available quota
snapshots and two unavailable snapshots; five unbound subjects were rejected.
Those explicit mappings stayed in memory and were not installed on an execution
host. Polling was disabled: this qualifies the new parser/read contract against
real measurements, not fresh provider probes or renewed account qualification.

[Dependency verification](../../release/0.2.0-rc.3/usagestat-2.0.1/dependency-verification.json) ·
[Isolated compatibility receipt](../../release/0.2.0-rc.3/usagestat-2.0.1/qualification.json)

## SDK-owned service maintenance

The regular execution host had no native child work before maintenance. Only its
separate `agenticdriver-litagent-usage.service` was briefly stopped and upgraded
from 2.0.0 to the verified 2.0.1 executable. The prior binary and a private SQLite
backup were retained. The live database was preserved in place.

All thirteen original payloads and digests read back unchanged after startup.
Private configuration and credentials matched before and after, with no new
host/account/subject binding or execution grant. The regular execution host's
process was unchanged and remains on SDK RC.2; its provider catalogs and existing
application credential remained usable. At this maintenance check, the ordinary
usage daemon on port 6736 and separate Prometheus RC.2 validation services still
ran 2.0.0; this operation did not alter them. Application source, enabled choices
and native account profiles were preserved.

Fresh registry RC.3 and the existing RC.2 SDK both used the upgraded normal
service's capability handshake and read every original record: twenty-six complete
readbacks and two duplicate acknowledgements, with zero new records or model
calls. The released backend also passed the desktop's actual empty-profile read
check, without provider discovery or polling. No fixture provider, fake account
or invented usage was supplied.

[Maintenance receipt](../../release/0.2.0-rc.3/usagestat-2.0.1/regular-upgrade.json) ·
[Both SDK versions](../../release/0.2.0-rc.3/usagestat-2.0.1/live-sdk-readback.json) ·
[Retained execution host](../../release/0.2.0-rc.3/usagestat-2.0.1/regular-host-readback.json) ·
[Desktop read contract](../../release/0.2.0-rc.3/usagestat-2.0.1/desktop-readback.json)

Current integration guidance now pins 2.0.1. Earlier RC.2/RC.3 publication records
retain the backend versions tested at their release gates; their archives and
tags were not replaced. This maintenance does not certify Usagestat's new
dashboard settings, RPM update hooks, other platforms or new provider polling.
Usagestat owns those features and its own release evidence. No parallel SDK usage
backend, app authentication migration, model/billing fallback or default execution
timeout was introduced.

## Later ordinary-daemon readback

A later read-only check at 03:45 UTC observed the ordinary daemon on port 6736
reporting 2.0.1. This check did not change its binary, service or configuration.
Installed registry SDK RC.3 parsed its 97 advertised provider definitions and six
actual native snapshots. Provider definitions do not represent connected accounts.
The original metrics, source, state and `fetchedAt` fields matched the actual wire
responses, and quota resources were derived through the supported native usage
routes.

The five existing memory-only administrative bindings again returned three
available and two unavailable quotas. Returned identities and upstream instances
matched those bindings and the exact scoped wire observations; five unbound
subjects were rejected. No host binding, credential, provider refresh or model
request was made. These reads retain each measurement's observation time; reading
cached data does not make it fresh. Native administrative endpoints still require
the consuming server to own application authorization and account mapping.

[Current native readback receipt](../../release/0.2.0-rc.3/usagestat-2.0.1/native-live-readback.json)
