# AgenticDriver documentation site

The VitePress site renders the SDK's existing `docs/` Markdown. Its dependencies
and build output are isolated from the published SDK package. Quickstart code
is included from the same examples executed against installed packages in the
container test; the three application recipes also run from the npm archive.

From the SDK repository root, with Node 24 and npm:

```sh
npm ci --prefix site
npm run build --prefix site
npm run preview --prefix site
```

Open `http://127.0.0.1:7438/`. For authoring, use `npm run dev --prefix site`.
The build checks Markdown links and writes static HTML/assets to
`site/.vitepress/dist/`. CI retains that directory as the
`agenticdriver-documentation` artifact for seven days. Local search uses a built
index; it does not send searches to an external service.

Links between docs stay on the site. Links to source, client READMEs and workflow
files resolve to the current private GitHub repository's `sdk-roadmap` branch;
readers need their own repository access. Update those source/edit links when a
release branch or public repository is selected. Local preview is useful now;
this is not a claim that a public package or website has been released.

The intended domain is `agenticdriver.dev`. Public hosting, DNS changes, a
canonical production URL and registry publication require a separately selected
release destination. This build has no deployment credentials or automatic
publication step.
