/** Synthetic visual acceptance fixture. No provider credentials or inference. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const script = new URL("./fixtures/provider-details.mjs", import.meta.url);
const panel = new URL("../dist/provider-panel.js", import.meta.url);
const server = createServer(async (req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/panel.js" || req.url === "/fixture.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(await readFile(req.url === "/panel.js" ? panel : script));
  } else if (req.url === "/fixture.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(
      "html{background:#202535;color:#d9def2;font:14px system-ui}body{margin:24px auto;padding:0 20px;max-width:1240px}body>p{margin:0 0 18px;color:#a6aec4}@media(max-width:600px){body{margin:12px auto;padding:0 8px}}",
    );
  } else if (req.url === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgenticDriver · Provider details</title><link rel="stylesheet" href="/fixture.css"></head><body><p>Provider settings preview · Synthetic accounts · No model calls</p><script type="module" src="/fixture.js"></script></body></html>',
    );
  } else res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () =>
  console.log(
    `Provider details fixture: http://127.0.0.1:${server.address().port}`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => server.close());
