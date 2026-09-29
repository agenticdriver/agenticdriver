# Search a real connected corpus

These clients call the actual host retrieval service. Provision a corpus with
an explicit real embedding model, persistent store and application-owned source
permissions using [the retrieval guide](../../docs/retrieval.md). Index permitted
documents first. No provider, account, connection or evidence is supplied here.

Set these environment variables in your application shell:

```sh
export AGENTICDRIVER_URL=http://127.0.0.1:7433/
export AGENTICDRIVER_TOKEN_FILE=/private/driver-connection.token
export AGENTICDRIVER_CORPUS=your-corpus
export AGENTICDRIVER_SOURCE_ID=your-authorized-source-id
export AGENTICDRIVER_QUERY_FILE=/private/question.txt
```

The token must grant search on that corpus; the application's authorizer must
grant the selected source at its current revision. Use verified HTTPS for a
remote listener or the [SSH route](../../docs/real-connections.md).

Copy the corresponding client into an application using the published SDK.
For Rust, add `agenticdriver` with its `blocking` feature and `serde_json`; for
Go use the SDK Go module. Python and JavaScript require their SDK package only.
No local model runtime is required by these clients.

Use a meaningful question about your selected document, for example “How do
RAG-Sequence and RAG-Token differ?” when you indexed the actual Lewis et al.
paper. These clients search without requesting generation. The host performs
real embedding computation and any selected embedding API may bill it.
Results contain exact passages, source revision/location, model/index identity
and similarity scores. Protect stdout if your sources are private:

```sh
umask 077
node client.mjs > /private/retrieved-evidence.json
```

An empty result does not authorize switching sources, accounts or models. Review
relevance before using retrieved passages as evidence. To ask a generation
provider, pass a separate explicit provider/model and `retrieval` selection as
shown in [the SDK guide](../../docs/retrieval.md#index-search-and-ask).
