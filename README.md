# @pipeworx/uspto-office-actions

USPTO patent prosecution history — office action full text, examiner/applicant
citations (plus AI/ML-extracted "enriched citation" metadata), claim-level
rejection data (35 U.S.C. 101/102/103/112), and Commissioner final decisions on
patent application petitions.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `search_office_actions(application_number | patent_number, limit)` — office
  actions on an application: action type, mail date, examiner employee number,
  art unit, newest first.
- `get_office_action_text(document_id | (application_number + mail_date))` —
  one office action's full text, its length, and a truncation flag.
- `get_office_action_rejections(application_number, limit)` — claim-level
  rejection data: AGGREGATE counts of 101/102/103/112/double-patenting
  rejection records first, per-record detail last.
- `get_office_action_citations(application_number, limit)` — references cited
  in office actions, who cited them (examiner vs applicant), plus the
  AI/ML-extracted enriched-citation fields (category code, claim/paragraph
  passage mapping) when USPTO has them for that citation.
- `search_petition_decisions(query | application_number, decided_after,
  decided_before, limit, offset)` — Commissioner / Office of Petitions final
  decisions: decision type, decision date, petition type, deciding office.

## Auth

Platform key (`PLATFORM_USPTO_KEY`) with BYO override via `_apiKey`. Get a free
key at https://data.uspto.gov/myodp. As of 2026-10, USPTO requires ID.me
identity verification plus four profile fields on new/renewed ODP accounts —
a BYO key from an account that has not completed that will read as rejected
even though it is correctly formatted.

## Data sources

- USPTO, Open Data Portal — Office Action Text Retrieval dataset (public
  domain, CC0 mark). Covers published office actions starting with the
  12-million application series.
- USPTO, Open Data Portal — Office Action Citations dataset.
- USPTO, Open Data Portal — Office Action Rejection dataset.
- USPTO, Open Data Portal — Enriched Citation (AI/ML-extracted) dataset.
- USPTO, Open Data Portal — Final Petition Decisions dataset.

Name the publisher and dataset only, never a route — the exact endpoints live
in `src/index.ts`.

## Notes

- **The legacy `developer.uspto.gov` Office Action APIs are dead** (blanket
  301 to `data.uspto.gov/home`, confirmed 2026-10-18). This pack calls their
  live replacements on `api.uspto.gov`.
- **The real request shape took FIVE rounds of live probing to find** (fleet
  #3305, 2026-10-18 — cluster-c's own probe, then Antonio, then this pack's
  own follow-ups, then Antonio again). THREE shapes are disproven, not just
  untried — do not re-try them: (1) a simple `GET /office-actions` resource
  exists (401 with no key, 403 "Forbidden" with a bad one) but rejects every
  query shape tried against it (`q`/`size` alone, or hedged with legacy
  `criteria`/`rows`) with `"missing path or query params"` — its real
  contract is still unknown and this pack does NOT call it; (2) `GET
  <route>/search` and `GET <route>/<applicationNumber>` are both disproven
  directly against the live upstream — both answer `403 "Missing
  Authentication Token"` on ANY key, the AWS routing-level "no such
  resource" signature; neither sub-path exists. (3) **What this pack
  actually calls**: `POST /api/v1/patent/oa/<dataset>/<version>/records`,
  form-encoded `criteria` (Lucene)/`start`/`rows` — the ORIGINAL dataset
  routes from the open-source `patent-dev/uspto-odp` Go client's own
  checked-in OpenAPI specs, first misread as dead because a bogus-key probe
  against them returned the SAME STATUS CODE (403) as this pack's own
  bogus-path control. The actual distinguishing signal on this subtree is
  the BODY: `{"message":"Forbidden"}` means "real route, bad key";
  `{"message":"Missing Authentication Token"}` means "no such resource" —
  two different 403 bodies, previously conflated into one status code. A
  live keyless probe confirmed all four dataset/version pairs answer
  "Forbidden". See `OA_DATASETS` in `src/index.ts` for the exact
  dataset/version table and which swagger file backs each entry — enriched
  citations' primary candidate uses the swagger file's own dataset name
  (`enriched_cited_reference_metadata`, v3) rather than the
  `oa_enriched_citations` v1/v2 guessed live, kept as a fallback. If this is
  STILL wrong, **every tool accepts `include_raw: true`**, which skips
  normal parsing/error-handling and returns the bare upstream HTTP status +
  first 500 chars of body instead — a live probe can self-diagnose the next
  miss without a code change + redeploy cycle.
- **The response envelope** is the classic Solr shape
  (`{response:{numFound,docs:[...]}}`, confirmed via real response examples
  from the open-source `patent-dev/uspto-odp` Go client). An unrecognized
  shape throws loudly (`upstream_parse: ...`) with the raw body, rather than
  returning a quiet empty result.
- **Final Petition Decisions is fully confirmed**, not inferred: both its
  route (`/api/v1/petition/decisions/search`, POST, JSON
  `{q, pagination:{offset,limit}, filters:[{name,value}]}`) and its response
  shape (`{count, petitionDecisionDataBag:[...]}`) match the same Go client's
  checked-in real example responses, and the route itself was independently
  confirmed live (401 Unauthorized) by this pack's own probe.
- **USPTO's null-date sentinel is `"0001-01-01T00:00:00"`** — treated as
  `null` everywhere in this pack's output (an ungranted application has no
  `grant_date`, not a 1-AD one).
- `obsoleteDocumentIdentifier` (USPTO's own, oddly-retained field name) is
  exposed to callers as `document_id` — it is the stable per-document key, not
  actually obsolete data.
- No fleet-held credential was reachable from a local/dev run while building
  this pack (the platform key lives only in the deployed gateway's secret
  store), so the pre-deploy smoke test below exercises real network calls to
  `api.uspto.gov` and confirms the request/response code runs cleanly, but
  could only observe the auth-rejection path, not a real payload. The first
  real verification is the live, authenticated post-deploy probe.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "uspto-office-actions": {
      "url": "https://gateway.pipeworx.io/uspto-office-actions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/uspto-office-actions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/search_office_actions \
  -H 'Content-Type: application/json' \
  -d '{"application_number":"17248024","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/search_office_actions`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-uspto-office-actions` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/uspto-office-actions/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "uspto-office-actions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-uspto-office-actions"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Uspto Office Actions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
