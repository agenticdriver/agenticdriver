import { readFile } from "node:fs/promises";
import { AgenticClient } from "@agenticdriver/sdk/client";

function required(name) {
  const value = process.env[name];
  if (!value)
    throw new Error(`Set ${name}. No connection or corpus is inferred.`);
  return value;
}
const client = new AgenticClient({
  url: required("AGENTICDRIVER_URL"),
  token: (await readFile(required("AGENTICDRIVER_TOKEN_FILE"), "utf8")).trim(),
});
const evidence = await client.searchContext({
  corpus: required("AGENTICDRIVER_CORPUS"),
  sourceIds: [required("AGENTICDRIVER_SOURCE_ID")],
  query: await readFile(required("AGENTICDRIVER_QUERY_FILE"), "utf8"),
  limit: 4,
});
console.log(JSON.stringify(evidence, null, 2));
