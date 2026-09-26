export const APP_URL = "agenticdriver://app/";
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'none'; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export function trustedSender(event, contents) {
  return Boolean(
    contents &&
    !contents.isDestroyed() &&
    event.sender === contents &&
    event.senderFrame === contents.mainFrame &&
    event.senderFrame.url === APP_URL,
  );
}
export function externalDocumentation(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      new Set([
        "developers.openai.com",
        "platform.openai.com",
        "code.claude.com",
        "platform.claude.com",
        "docs.anthropic.com",
        "ai.google.dev",
        "geminicli.com",
        "docs.x.ai",
        "docs.cloud.google.com",
        "vercel.com",
        "github.com",
        "agenticdriver.dev",
      ]).has(url.hostname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function boundedRequest(input) {
  try {
    return Buffer.byteLength(JSON.stringify(input)) <= 1_000_000;
  } catch {
    return false;
  }
}
export function assetName(value) {
  const url = new URL(value);
  if (
    url.protocol !== "agenticdriver:" ||
    url.host !== "app" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    return undefined;
  return new Map([
    ["/", "index.html"],
    ["/app.js", "app.js"],
    ["/styles.css", "styles.css"],
    ["/provider-panel.js", "provider-panel.js"],
  ]).get(url.pathname);
}
