# Provider icons

AgenticDriver and UsageStat-Bar use the same independent
[provider-icons library](https://github.com/agenticdriver/provider-icons).
The SDK pins its immutable release archive in `package.json` and its integrity
in `package-lock.json`. Update that dependency to adopt new artwork; do not edit
SVG copies in an application. The collection currently has 155 provider/product
marks (262 SVGs), with upstream MIT notices and source checksums.

The provider panel bundles the library, including the Python, Go, Rust and
Companion copies. It makes no icon CDN requests. Settings offer full colour or
monochrome and related product marks (ChatGPT/Codex, Anthropic/Claude/Claude Code
and Copilot/GitHub Copilot). Choices are stored per connection and provider on
this device; changing a mark never changes runtime, account, permissions or
billing. A provider without artwork gets initials. When a product has no colour
variant the monochrome artwork is used and the UI says so.

Applications can still supply their reviewed Usagestat asset presentation. It
is used unless the user explicitly selects a bundled icon preference. The
existing asset-cache allowlist and licence checks remain available for custom
marks. Bundled mono SVGs inherit text colour; gradients use unique identifiers.
The generated panel includes no inline SVG styles or external image references.
All packages retain `provider-icons.NOTICE.txt` alongside the component.
