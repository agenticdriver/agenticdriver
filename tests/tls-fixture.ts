import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

/** A real CA/leaf chain, with no trust-store changes or disabled TLS checks. */
export async function createTlsFixture(directory: string) {
  const ca = join(directory, "ca.pem"),
    caKey = join(directory, "ca-key.pem");
  const cert = join(directory, "cert.pem"),
    key = join(directory, "key.pem");
  const csr = join(directory, "server.csr"),
    extensions = join(directory, "server.ext");
  const openssl = async (args: string[]) => {
    return await promisify(execFile)("openssl", args, {
      timeout: 15_000,
      maxBuffer: 100_000,
    });
  };
  const version = (await openssl(["version"])).stdout.trim();
  assert.match(
    version,
    /^OpenSSL [3-9]\./,
    "TLS fixtures require OpenSSL 3 or newer, including Homebrew OpenSSL on macOS.",
  );
  await openssl([
    "req",
    "-x509",
    "-sha256",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    ca,
    "-days",
    "1",
    "-subj",
    "/CN=AgenticDriver fixture CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-addext",
    "subjectKeyIdentifier=hash",
  ]);
  await openssl([
    "req",
    "-new",
    "-sha256",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    csr,
    "-subj",
    "/CN=127.0.0.1",
  ]);
  await writeFile(
    extensions,
    [
      "subjectAltName=IP:127.0.0.1",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid,issuer",
      "",
    ].join("\n"),
  );
  await openssl([
    "x509",
    "-req",
    "-sha256",
    "-in",
    csr,
    "-CA",
    ca,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    cert,
    "-days",
    "1",
    "-extfile",
    extensions,
  ]);
  const root = new X509Certificate(await readFile(ca));
  const leaf = new X509Certificate(await readFile(cert));
  assert.ok(
    root.ca && root.checkIssued(root) && root.verify(root.publicKey),
    "The fixture root must be a self-signed CA.",
  );
  assert.ok(
    !leaf.ca && leaf.checkIssued(root) && leaf.verify(root.publicKey),
    "The fixture leaf must chain to its generated CA.",
  );
  await openssl(["verify", "-CAfile", ca, "-purpose", "sslserver", cert]);
  return { ca, cert, key };
}

// Shared by the Python/Go/Rust installation harness, which already uses this Node toolchain.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2]) throw new Error("Supply a private fixture directory.");
  console.log(JSON.stringify(await createTlsFixture(resolve(process.argv[2]))));
}
