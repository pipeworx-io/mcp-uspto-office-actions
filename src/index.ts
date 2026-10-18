interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * USPTO patent prosecution history: office action full text, examiner
 * citations, claim-level rejections (35 U.S.C. 101/102/103/112), enriched
 * (AI/ML-extracted) citation metadata, and Commissioner final decisions on
 * patent application petitions — the USPTO's own patent-examination records.
 *
 * AUTH: X-Api-Key header, same shape as mcps/patents. Platform key required
 * (PLATFORM_USPTO_KEY) or BYO via _apiKey.
 *
 * ROUTE PROVENANCE — read before touching the office-action query shape.
 * The legacy `developer.uspto.gov` Office Action Text Retrieval / Citations /
 * Rejections / Enriched Citation APIs are DEAD (blanket 301 to
 * data.uspto.gov, confirmed live 2026-10-18). FIVE rounds of live probing
 * (fleet #3305, 2026-10-18 — cluster-c's own probe, then Antonio, then this
 * pack's own follow-ups, then Antonio again) found where they moved to —
 * read the whole history before changing this again, because THREE
 * plausible-looking shapes are already disproven, not just untried:
 *
 *   1. A simple singular/plural REST resource (`GET /office-actions`,
 *      `/office-action-citations`, etc.) exists and takes a real key (401
 *      with none, 403 "Forbidden" with a bad one) but REJECTS every query
 *      shape tried against it — both `q`/`size` alone and `q`/`size` +
 *      legacy `criteria`/`rows` hedged together 400'd with
 *      `"detailedMessage":"Invalid request, missing path or query params"`.
 *      The failure did not change between 2 params and 4, which rules out
 *      "too many params" as the cause — some REQUIRED name was simply never
 *      sent, name unknown. This resource's real query contract is still not
 *      known; it is NOT what this pack calls today.
 *   2. `GET <route>/search` and `GET <route>/<applicationNumber>` (patents'
 *      own proven `/applications/search` convention, and a direct
 *      per-application path) are BOTH DISPROVEN, directly, no redeploy
 *      needed: both answer `403 "Missing Authentication Token"` on ANY key,
 *      valid or not — AWS API Gateway's routing-level "no such resource"
 *      signature, which fires before any authorizer runs. Checked against
 *      both `office-actions` and `office-action-citations`. Neither
 *      sub-path exists for this resource family.
 *   3. **What this pack actually calls**: the original DSAPI dataset
 *      routes the `patent-dev/uspto-odp` open-source Go client's own
 *      checked-in OpenAPI specs name — `POST
 *      /api/v1/patent/oa/<dataset>/<version>/records`, form-encoded
 *      `criteria` (Lucene `field:value`) / `start` / `rows` — were
 *      INITIALLY read as dead, because a bogus-key probe against them
 *      returned 403 "Forbidden", the SAME STATUS CODE this pack's own
 *      bogus-path control also returned. That was the actual mistake:
 *      on THIS subtree, `{"message":"Forbidden"}` means "real route, bad
 *      key" and `{"message":"Missing Authentication Token"}` means
 *      "no such resource" — two different 403 BODIES, conflated into one
 *      status code. A live keyless probe (Antonio, 2026-10-18) hit all
 *      four dataset/version pairs directly and got "Forbidden" on every
 *      one, confirming they are real. `OA_DATASETS` below is the
 *      dataset/version table, each entry traceable to the matching
 *      downloaded swagger file (`oa-text-retrieval.yaml`, `oa-rejections.yaml`,
 *      `oa-citations.yaml`, `oa-enriched-citations.yaml`) — EXCEPT enriched
 *      citations' primary candidate, where the swagger file's own dataset
 *      name (`enriched_cited_reference_metadata`, v3) was used instead of
 *      the `oa_enriched_citations` v1/v2 guessed live, which is kept as a
 *      fallback in case the swagger file is itself stale.
 *
 * `include_raw: true` on every tool skips error-summarization and returns
 * the exact upstream HTTP status + body (first 500 chars), so the next live
 * probe is self-diagnosing rather than another blind guess.
 *
 * Final Petition Decisions is NOT inferred and is NOT part of this history:
 * `/api/v1/petition/decisions/search` (POST, JSON `{q,
 * pagination:{offset,limit}, filters:[{name,value}]}`) and its exact
 * response shape (`{count, petitionDecisionDataBag:[...]}`) are both
 * confirmed from the same Go client's example responses, and the search
 * path itself was independently confirmed live (401) by this wave's own
 * probe. It has worked, unchanged, since the first deploy.
 *
 * Tools:
 * - search_office_actions: office actions for an application — action type,
 *   mail date, examiner, art unit.
 * - get_office_action_text: one office action's full text by document id, or
 *   by application number + mail date.
 * - get_office_action_rejections: claim-level rejection types (101/102/103/112)
 *   for an application — aggregate counts first, records last.
 * - get_office_action_citations: references cited in office actions, who cited
 *   them (examiner vs applicant), plus enriched (AI/ML-extracted) citation
 *   metadata when present.
 * - search_petition_decisions: Commissioner / Office of Petitions final
 *   decisions, by application number or free text.
 *
 * Source: USPTO Open Data Portal (data.uspto.gov) — Office Action Text
 * Retrieval, Office Action Citations, Office Action Rejections, and Enriched
 * Citation datasets (public domain, CC0 per the Office Action Text Retrieval
 * dataset's own catalog.data.gov listing), and the Final Petition Decisions
 * dataset.
 */


const UA = 'pipeworx-mcp-uspto-office-actions/1.0 (+https://pipeworx.io)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'USPTO Open Data Portal');
}

const BASE = 'https://api.uspto.gov/api/v1';

function resolveApiKey(args: Record<string, unknown>): string {
  const key = (args._apiKey as string | undefined)?.trim();
  if (key) return key;
  throw new Error(
    'USPTO ODP API key required. Get one free at https://data.uspto.gov/myodp and pass via _apiKey, or contact the operator about platform credentials.',
  );
}

/** Strip slashes/commas/spaces from an application or patent number. */
function digitsOnly(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/\D/g, '');
  return s.length >= 5 ? s : null;
}

/** ODP returns some office-action fields as 1-element arrays, others scalar. Flatten either. */
function firstOf<T>(v: T | T[] | undefined | null): T | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length > 0 ? v[0] : null;
  return v;
}

/** USPTO's null-date sentinel is "0001-01-01T00:00:00" — treat it as absent. */
function realDate(v: unknown): string | null {
  const s = firstOf(v as string | string[] | null);
  if (!s || typeof s !== 'string') return null;
  if (s.startsWith('0001-01-01')) return null;
  return s;
}

function escapeLucene(v: string): string {
  return v.replace(/["\\]/g, '');
}

// Non-exhaustive map of document type codes actually seen in the office-action
// dataset (including some, like PETDEC, that surface in the oa_actions index
// alongside true office actions). Unknown codes fall back to the raw code —
// never invent a label for one we have not seen.
const ACTION_TYPE_LABELS: Record<string, string> = {
  CTNF: 'Non-Final Rejection',
  CTFR: 'Final Rejection',
  CTAV: 'Advisory Action',
  CTEX: "Examiner's Answer",
  NOA: 'Notice of Allowance and Fees Due',
  ABN: 'Abandonment',
  PETDEC: 'Petition Decision',
  EXIN: 'Examiner Interview Summary',
  NFRJ: 'Non-Final Rejection',
};

/** `include_raw: true` on a tool call short-circuits normal parsing/error
 *  handling for that tool and reports the bare upstream HTTP status + body
 *  instead — a deliberate escape hatch (fleet #3305) for diagnosing a
 *  genuinely unconfirmed request shape from a live probe, without needing a
 *  code change + redeploy cycle for each guess. */
function wantsRaw(args: Record<string, unknown>): boolean {
  return args.include_raw === true || args.include_raw === 'true';
}

/**
 * The USPTO Data Set API (DSAPI) dataset+version pairs this pack calls.
 * Confirmed from TWO independent sources: the open-source `patent-dev/uspto-odp`
 * Go client's own checked-in OpenAPI specs (downloaded directly, not
 * second-hand), AND a live keyless probe (fleet #3305, 2026-10-18, Antonio)
 * against `POST https://api.uspto.gov/api/v1/patent/oa/<dataset>/<version>/records`
 * for all four — every one answered `403 {"message":"Forbidden"}`, the
 * "route exists, key required" signature on THIS subtree (distinct from
 * `{"message":"Missing Authentication Token"}`, the routing-level "no such
 * resource" signature a genuinely dead path answers with regardless of any
 * key — conflating the two was this pack's own earlier mistake, corrected
 * here). `enriched_citations` lists `v3` first: the downloaded swagger file
 * (`swagger/oa-enriched-citations.yaml` in that repo) names the dataset
 * `enriched_cited_reference_metadata` at version v3, not `oa_enriched_citations`
 * v1/v2 as first guessed live — `v1`/`v2` under that OTHER name are kept as
 * a fallback in case the swagger file is itself stale.
 */
const OA_DATASETS: Record<string, Array<{ dataset: string; version: string }>> = {
  'office-actions': [{ dataset: 'oa_actions', version: 'v1' }],
  'office-action-rejections': [{ dataset: 'oa_rejections', version: 'v2' }],
  'office-action-citations': [{ dataset: 'oa_citations', version: 'v2' }],
  'office-action-enriched-citations': [
    { dataset: 'enriched_cited_reference_metadata', version: 'v3' },
    { dataset: 'oa_enriched_citations', version: 'v1' },
    { dataset: 'oa_enriched_citations', version: 'v2' },
  ],
};

function dsapiUrl(dataset: string, version: string): URL {
  return new URL(`${BASE}/patent/oa/${dataset}/${version}/records`);
}

function dsapiBody(criteria: string, start: number, rows: number): string {
  return new URLSearchParams({ criteria, start: String(start), rows: String(rows) }).toString();
}

/** Fire one DSAPI POST and hand back the bare upstream status + body, no
 * interpretation at all — what `include_raw: true` returns to the caller.
 * Tries each candidate in `OA_DATASETS[path]` in order and reports the
 * LAST one tried (the most-confirmed candidate is tried first, so a caller
 * reading this under `include_raw` sees the one that matters unless every
 * candidate 404s on "wrong version/dataset"). */
async function oaRawProbe(
  apiKey: string,
  path: string,
  criteria: string,
  rows: number,
): Promise<{ route: string; body: string; status: number; body_excerpt: string }> {
  const candidates = OA_DATASETS[path] ?? [];
  let last = { route: path, body: '', status: 0, body_excerpt: '(no candidates registered)' };
  for (const { dataset, version } of candidates) {
    const url = dsapiUrl(dataset, version);
    const body = dsapiBody(criteria, 0, rows);
    const res = await pwFetch(url, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text().catch(() => '');
    last = { route: url.pathname, body, status: res.status, body_excerpt: text.slice(0, 500) };
    if (res.status !== 404) break; // a non-404 (even an error) means this candidate is the real one
  }
  return last;
}

/** Pull a rows array + total out of the classic Solr `{response:{docs,numFound}}`
 * envelope (confirmed via the Go client's real example payloads). Returns
 * null on a genuinely unrecognized shape, which the caller turns into a LOUD
 * error rather than a quiet empty result (fleet silent-zero policy). */
function parseOaRows(data: Record<string, unknown>): { docs: Record<string, unknown>[]; total: number } | null {
  const asSolr = data.response as { docs?: unknown; numFound?: unknown } | undefined;
  if (asSolr && Array.isArray(asSolr.docs)) {
    return { docs: asSolr.docs as Record<string, unknown>[], total: typeof asSolr.numFound === 'number' ? asSolr.numFound : asSolr.docs.length };
  }
  if (Array.isArray(data)) {
    return { docs: data as unknown as Record<string, unknown>[], total: (data as unknown[]).length };
  }
  return null;
}

/**
 * POST one of the four DSAPI datasets (`OA_DATASETS[path]`), form-encoded
 * `criteria`/`start`/`rows` — the Go client's own working shape, confirmed
 * live. Tries each candidate dataset/version pair in order; a 404 moves to
 * the next candidate (it means THAT dataset/version combination is not
 * published), anything else (success or a real error) stops there.
 */
async function oaDatasetFetch(
  apiKey: string,
  path: string,
  criteria: string,
  rows: number,
): Promise<{ docs: Record<string, unknown>[]; total: number }> {
  const candidates = OA_DATASETS[path];
  if (!candidates?.length) throw new Error(`no DSAPI dataset registered for "${path}"`);

  let lastNotFound: { status: number; text: string } | null = null;
  for (const { dataset, version } of candidates) {
    const url = dsapiUrl(dataset, version);
    const res = await pwFetch(url, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: dsapiBody(criteria, 0, rows),
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error('USPTO ODP rejected the API key. Verify the key at https://data.uspto.gov/myodp');
    }
    if (res.status === 429) {
      throw new Error('USPTO ODP rate limit hit (429) — back off and retry.');
    }
    if (res.status === 404) {
      const text = await res.text().catch(() => '');
      if (/no matching records/i.test(text)) {
        return { docs: [], total: 0 };
      }
      // A 404 that is not "no matching records" means THIS dataset/version
      // combination is not published — try the next candidate, if any.
      lastNotFound = { status: res.status, text };
      continue;
    }
    if (!res.ok) {
      // 400 in particular is worth showing UNSUMMARIZED: it is the one status
      // where "the extracted message is short" and "there was never anything
      // more to extract" (AWS API Gateway's own generic request-validation
      // rejection) look identical, and the difference matters for diagnosis.
      const text = await res.text().catch(() => '');
      const detail = text ? summarizeErrorBody(text) : '';
      throw new Error(
        `USPTO ODP error ${res.status} on ${url.pathname}${detail ? `: ${detail}` : ''}` +
          (res.status === 400 && text ? ` [raw body: ${text.slice(0, 300)}]` : ''),
      );
    }

    const data = await parseJson<Record<string, unknown>>(res, 'USPTO ODP office-action dataset');
    const parsed = parseOaRows(data);
    if (parsed) return parsed;

    // Genuinely empty / unrecognized shape — surface it loudly with the raw
    // response rather than returning an empty result that looks like a clean
    // zero-hit search.
    throw new Error(
      `upstream_parse: USPTO ODP office-action dataset (${url.pathname}) returned a response with no recognizable rows array. ` +
        `Raw (first 500 chars): ${JSON.stringify(data).slice(0, 500)}`,
    );
  }

  throw new Error(
    `USPTO ODP error 404: no candidate dataset/version for "${path}" was found` +
      (lastNotFound ? ` (last tried: ${lastNotFound.status}${lastNotFound.text ? `, ${summarizeErrorBody(lastNotFound.text)}` : ''})` : ''),
  );
}

// ── Tool definitions ─────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'search_office_actions',
    description:
      "Search USPTO office actions (and related prosecution-history documents, e.g. petition decisions filed in the same document stream) for one patent application. Returns action type (non-final rejection, final rejection, notice of allowance, etc.), mail date, examiner employee number, and art unit — newest first. Use get_office_action_text with the returned document_id to fetch one office action's full text. Pass application_number (preferred) or patent_number.",
    inputSchema: {
      type: 'object',
      properties: {
        application_number: { type: 'string', description: 'US patent application number, digits only or formatted, e.g. "16123456" or "16/123,456".' },
        patent_number: { type: 'string', description: 'Granted US patent number, as an alternative to application_number.' },
        limit: { type: 'number', description: 'Max rows to return (default 10, max 100).' },
        _apiKey: { type: 'string', description: 'USPTO ODP API key. Get free at https://data.uspto.gov/myodp. Falls back to platform key if configured.' },
        include_raw: { type: 'boolean', description: 'Debug escape hatch: skip normal parsing and return the bare upstream HTTP status + first 500 chars of body instead (fleet #3305 — diagnosing a request shape live, no redeploy needed).' },
      },
    },
  },
  {
    name: 'get_office_action_text',
    description:
      "Fetch one USPTO office action's full text. Pass document_id (from search_office_actions' document_id field) for an exact match, or application_number + mail_date to look it up by application and date. Returns the office action body text, its character length, and a truncation flag.",
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: "The office action's document id, as returned by search_office_actions (field document_id)." },
        application_number: { type: 'string', description: 'US patent application number — use with mail_date when you do not have a document_id.' },
        mail_date: { type: 'string', description: 'The office action mail date (ISO YYYY-MM-DD), from search_office_actions\' mail_date field. Required when document_id is not given.' },
        _apiKey: { type: 'string', description: 'USPTO ODP API key. Get free at https://data.uspto.gov/myodp.' },
        include_raw: { type: 'boolean', description: 'Debug escape hatch: skip normal parsing and return the bare upstream HTTP status + first 500 chars of body instead (fleet #3305 — diagnosing a request shape live, no redeploy needed).' },
      },
    },
  },
  {
    name: 'get_office_action_rejections',
    description:
      'Claim-level rejection data for every office action on one application. Returns AGGREGATE counts first (how many rejection records cite 35 U.S.C. 101/102/103/112, and double-patenting) and per-claim/per-record detail last. Use this before get_office_action_citations when the question is "what did the examiner reject this on", not "what references were cited".',
    inputSchema: {
      type: 'object',
      properties: {
        application_number: { type: 'string', description: 'US patent application number, digits only or formatted.' },
        limit: { type: 'number', description: 'Max per-record rows to return in `records` (default 25, max 100). The `aggregate` block always covers every record USPTO returned for this application, not just `limit` of them.' },
        _apiKey: { type: 'string', description: 'USPTO ODP API key. Get free at https://data.uspto.gov/myodp.' },
        include_raw: { type: 'boolean', description: 'Debug escape hatch: skip normal parsing and return the bare upstream HTTP status + first 500 chars of body instead (fleet #3305 — diagnosing a request shape live, no redeploy needed).' },
      },
      required: ['application_number'],
    },
  },
  {
    name: 'get_office_action_citations',
    description:
      'References cited in office actions for one application — who cited each one (examiner vs applicant), the legal basis (102/103 etc.) it was cited under, and the AI/ML-extracted "enriched citation" fields (category code, claim/paragraph passage mapping) when USPTO has them for that citation. Returns `citations` (basic citation records) and `enriched_citations` (richer subset) separately rather than force-merged, since the two datasets are not joined by a shared key.',
    inputSchema: {
      type: 'object',
      properties: {
        application_number: { type: 'string', description: 'US patent application number, digits only or formatted.' },
        limit: { type: 'number', description: 'Max rows per array to return (default 25, max 100).' },
        _apiKey: { type: 'string', description: 'USPTO ODP API key. Get free at https://data.uspto.gov/myodp.' },
        include_raw: { type: 'boolean', description: 'Debug escape hatch: skip normal parsing and return the bare upstream HTTP status + first 500 chars of body instead (fleet #3305 — diagnosing a request shape live, no redeploy needed).' },
      },
      required: ['application_number'],
    },
  },
  {
    name: 'search_petition_decisions',
    description:
      'Search USPTO Commissioner / Office of Petitions final decisions. Pass application_number for one application\'s petition history, or query for free-text search across decisions (petition issue text, invention title). Optional decided_after/decided_before (ISO YYYY-MM-DD) bound the decision date. Returns decision type, decision date, petition type, and the deciding office.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search, e.g. an invention title fragment or petition issue (e.g. "revival", "extension of time"). Omit to list recent decisions, or combine with application_number.' },
        application_number: { type: 'string', description: 'Filter to one US patent application number.' },
        decided_after: { type: 'string', description: 'Only decisions on/after this date (ISO YYYY-MM-DD).' },
        decided_before: { type: 'string', description: 'Only decisions on/before this date (ISO YYYY-MM-DD).' },
        limit: { type: 'number', description: 'Max rows to return (default 10, max 100).' },
        offset: { type: 'number', description: 'Pagination offset (default 0).' },
        _apiKey: { type: 'string', description: 'USPTO ODP API key. Get free at https://data.uspto.gov/myodp.' },
        include_raw: { type: 'boolean', description: 'Debug escape hatch: skip normal parsing and return the bare upstream HTTP status + first 500 chars of body instead (fleet #3305 — diagnosing a request shape live, no redeploy needed).' },
      },
    },
  },
];

// ── Tool implementations ─────────────────────────────────────────────

function clampLimit(v: unknown, def: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.floor(n));
}

function numberCriteria(args: Record<string, unknown>): { field: 'patentApplicationNumber' | 'patentNumber'; value: string } {
  const appNum = digitsOnly(args.application_number);
  if (appNum) return { field: 'patentApplicationNumber', value: appNum };
  const patNum = digitsOnly(args.patent_number);
  if (patNum) return { field: 'patentNumber', value: patNum };
  throw new Error('Required argument missing: pass application_number (or patent_number).');
}

async function searchOfficeActions(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const { field, value } = numberCriteria(args);
  const limit = clampLimit(args.limit, 10, 100);
  const luceneQuery = `${field}:${value}`;

  const plainNumber = field === 'patentApplicationNumber' ? value : undefined;
  if (wantsRaw(args)) return { debug: true, ...(await oaRawProbe(apiKey, 'office-actions', luceneQuery, limit)) };

  const { docs, total } = await oaDatasetFetch(apiKey, 'office-actions', luceneQuery, limit);

  const results = docs.slice(0, limit).map((doc) => {
    const code = (firstOf(doc.legacyDocumentCodeIdentifier as string | string[]) ?? '').toString();
    return {
      document_id: firstOf(doc.obsoleteDocumentIdentifier as string | string[]),
      application_number: firstOf(doc.patentApplicationNumber as string | string[]),
      patent_number: firstOf(doc.patentNumber as string | string[])?.toString().trim() || null,
      action_type_code: code || null,
      action_type: code ? (ACTION_TYPE_LABELS[code] ?? code) : null,
      mail_date: realDate(doc.submissionDate),
      invention_title: firstOf(doc.inventionTitle as string | string[]),
      examiner_employee_number: firstOf(doc.examinerEmployeeNumber as string | string[])?.toString().trim() || null,
      group_art_unit: doc.groupArtUnitNumber ?? null,
      application_status_code: doc.applicationStatusNumber ?? null,
      filing_date: realDate(doc.filingDate),
      grant_date: realDate(doc.grantDate),
    };
  });

  return {
    application_number: field === 'patentApplicationNumber' ? value : null,
    patent_number: field === 'patentNumber' ? value : null,
    total,
    returned: results.length,
    results,
    source: 'USPTO Open Data Portal, Office Action Text Retrieval dataset',
  };
}

async function getOfficeActionText(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const documentId = typeof args.document_id === 'string' ? args.document_id.trim() : '';
  const appNum = digitsOnly(args.application_number);
  const mailDate = typeof args.mail_date === 'string' ? args.mail_date.trim() : '';

  let luceneQuery: string;
  if (documentId) {
    luceneQuery = `obsoleteDocumentIdentifier:${escapeLucene(documentId)}`;
  } else if (appNum && mailDate) {
    luceneQuery = `patentApplicationNumber:${appNum} AND submissionDate:[${mailDate}T00:00:00 TO ${mailDate}T23:59:59]`;
  } else {
    throw new Error('Pass document_id, or both application_number and mail_date.');
  }

  if (wantsRaw(args)) return { debug: true, ...(await oaRawProbe(apiKey, 'office-actions', luceneQuery, 1)) };

  // If the bare-number hedge params end up being what the upstream actually
  // reads (rather than the `submissionDate` range inside `q`), it would
  // return every office action for the application, not the one exact date
  // — fetch enough rows to cover a real prosecution history and filter to
  // the requested mail_date client-side either way, rather than trusting
  // either shape to have done the narrowing itself.
  const { docs: allDocs } = await oaDatasetFetch(apiKey, 'office-actions', luceneQuery, appNum && mailDate ? 100 : 1);
  const docs = appNum && mailDate ? allDocs.filter((d) => realDate(d.submissionDate) === mailDate) : allDocs;
  const doc = docs[0];
  if (!doc) {
    return {
      found: false,
      document_id: documentId || null,
      application_number: appNum,
      mail_date: mailDate || null,
      hint: 'No office action matched. Confirm the document_id from search_office_actions, or that application_number + mail_date are an exact pair returned by that tool.',
    };
  }

  const bodyParts = Array.isArray(doc.bodyText) ? (doc.bodyText as string[]) : doc.bodyText ? [String(doc.bodyText)] : [];
  const text = bodyParts.join('\n\n');
  const code = (firstOf(doc.legacyDocumentCodeIdentifier as string | string[]) ?? '').toString();

  return {
    found: true,
    document_id: firstOf(doc.obsoleteDocumentIdentifier as string | string[]),
    application_number: firstOf(doc.patentApplicationNumber as string | string[]),
    action_type_code: code || null,
    action_type: code ? (ACTION_TYPE_LABELS[code] ?? code) : null,
    mail_date: realDate(doc.submissionDate),
    examiner_employee_number: firstOf(doc.examinerEmployeeNumber as string | string[])?.toString().trim() || null,
    text,
    length: text.length,
    truncated: false,
    source: 'USPTO Open Data Portal, Office Action Text Retrieval dataset',
  };
}

async function getOfficeActionRejections(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const appNum = digitsOnly(args.application_number);
  if (!appNum) throw new Error('Required argument "application_number" is missing or empty.');
  const limit = clampLimit(args.limit, 25, 100);
  if (wantsRaw(args)) return { debug: true, ...(await oaRawProbe(apiKey, 'office-action-rejections', `patentApplicationNumber:${appNum}`, 100)) };
  // Fetch up to 100 rows for the aggregate — the upstream page cap, not an
  // arbitrary choice: `total` below is USPTO's own count, reported honestly
  // even when it exceeds how many rows we actually aggregated over.
  const { docs, total } = await oaDatasetFetch(apiKey, 'office-action-rejections', `patentApplicationNumber:${appNum}`, 100);

  const agg = {
    section_101: 0,
    section_102: 0,
    section_103: 0,
    section_112: 0,
    double_patenting: 0,
    by_action_type: {} as Record<string, number>,
  };
  for (const doc of docs) {
    if (doc.hasRej101 === 1 || doc.hasRej101 === true) agg.section_101++;
    if (doc.hasRej102 === 1 || doc.hasRej102 === true) agg.section_102++;
    if (doc.hasRej103 === 1 || doc.hasRej103 === true) agg.section_103++;
    if (doc.hasRej112 === 1 || doc.hasRej112 === true) agg.section_112++;
    if (doc.hasRejDP === 1 || doc.hasRejDP === true) agg.double_patenting++;
    const cat = (doc.actionTypeCategory as string) || 'unspecified';
    agg.by_action_type[cat] = (agg.by_action_type[cat] ?? 0) + 1;
  }

  const records = docs.slice(0, limit).map((doc) => ({
    document_id: doc.obsoleteDocumentIdentifier ?? null,
    action_type_code: doc.legacyDocumentCodeIdentifier ?? null,
    action_type_category: doc.actionTypeCategory || null,
    mail_date: realDate(doc.submissionDate),
    claim_numbers: doc.claimNumberArrayDocument ?? [],
    legal_section_code: doc.legalSectionCode || null,
    rejections: {
      '101': !!(doc.hasRej101 === 1 || doc.hasRej101 === true),
      '102': !!(doc.hasRej102 === 1 || doc.hasRej102 === true),
      '103': !!(doc.hasRej103 === 1 || doc.hasRej103 === true),
      '112': !!(doc.hasRej112 === 1 || doc.hasRej112 === true),
      double_patenting: !!(doc.hasRejDP === 1 || doc.hasRejDP === true),
    },
    alice_indicator: doc.aliceIndicator ?? null,
    allowed_claim_indicator: doc.allowedClaimIndicator ?? null,
    group_art_unit: doc.groupArtUnitNumber ?? null,
  }));

  return {
    application_number: appNum,
    total_rejection_records: total,
    aggregated_over: docs.length,
    aggregate: agg,
    returned: records.length,
    records,
    source: 'USPTO Open Data Portal, Office Action Rejection dataset',
  };
}

async function getOfficeActionCitations(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const appNum = digitsOnly(args.application_number);
  if (!appNum) throw new Error('Required argument "application_number" is missing or empty.');
  const limit = clampLimit(args.limit, 25, 100);
  if (wantsRaw(args)) {
    const [basicRaw, enrichedRaw] = await Promise.all([
      oaRawProbe(apiKey, 'office-action-citations', `patentApplicationNumber:${appNum}`, limit),
      oaRawProbe(apiKey, 'office-action-enriched-citations', `patentApplicationNumber:${appNum}`, limit),
    ]);
    return { debug: true, citations: basicRaw, enriched_citations: enrichedRaw };
  }

  const [basic, enriched] = await Promise.all([
    oaDatasetFetch(apiKey, 'office-action-citations', `patentApplicationNumber:${appNum}`, limit),
    oaDatasetFetch(apiKey, 'office-action-enriched-citations', `patentApplicationNumber:${appNum}`, limit).catch((err) => {
      // Enriched citations is a smaller, newer dataset — not every
      // application has rows in it. Degrade to an empty set rather than
      // failing the whole tool on a sibling dataset's genuine zero.
      if (/upstream_parse|USPTO ODP error 404/.test(String(err?.message))) return { docs: [] as Record<string, unknown>[], total: 0 };
      throw err;
    }),
  ]);

  const citations = basic.docs.map((doc) => ({
    reference: doc.referenceIdentifier || null,
    parsed_reference_number: doc.parsedReferenceIdentifier || null,
    cited_by_examiner: !!doc.examinerCitedReferenceIndicator,
    cited_by_applicant: !!doc.applicantCitedExaminerReferenceIndicator,
    legal_section_code: doc.legalSectionCode || null,
    action_type_category: doc.actionTypeCategory || null,
    document_id: doc.obsoleteDocumentIdentifier ?? null,
    tech_center: doc.techCenter ?? null,
    group_art_unit: doc.groupArtUnitNumber ?? null,
  }));

  const enrichedCitations = enriched.docs.map((doc) => ({
    cited_document: doc.citedDocumentIdentifier || null,
    publication_number: doc.publicationNumber || null,
    country_code: doc.countryCode || null,
    kind_code: doc.kindCode || null,
    citation_category_code: doc.citationCategoryCode || null,
    cited_by_examiner: !!doc.examinerCitedReferenceIndicator,
    cited_by_applicant: !!doc.applicantCitedExaminerReferenceIndicator,
    inventor_name: doc.inventorNameText || null,
    related_claim_numbers: doc.relatedClaimNumberText || null,
    passage_locations: doc.passageLocationText ?? [],
    office_action_date: realDate(doc.officeActionDate),
    office_action_category: doc.officeActionCategory || null,
    quality_summary: doc.qualitySummaryText || null,
  }));

  return {
    application_number: appNum,
    total_citations: basic.total,
    returned_citations: citations.length,
    citations,
    total_enriched_citations: enriched.total,
    returned_enriched_citations: enrichedCitations.length,
    enriched_citations: enrichedCitations,
    source: 'USPTO Open Data Portal, Office Action Citations + Enriched Citation datasets',
  };
}

async function searchPetitionDecisions(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const limit = clampLimit(args.limit, 10, 100);
  const offset = typeof args.offset === 'number' && args.offset >= 0 ? Math.floor(args.offset) : 0;
  const appNum = digitsOnly(args.application_number);
  const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : '';
  const decidedAfter = typeof args.decided_after === 'string' ? args.decided_after.trim() : '';
  const decidedBefore = typeof args.decided_before === 'string' ? args.decided_before.trim() : '';

  const filters: Array<{ name: string; value: string[] }> = [];
  if (appNum) filters.push({ name: 'applicationNumberText', value: [appNum] });

  const rangeFilters: Array<{ field: string; valueFrom?: string; valueTo?: string }> = [];
  if (decidedAfter || decidedBefore) {
    rangeFilters.push({ field: 'decisionDate', ...(decidedAfter ? { valueFrom: decidedAfter } : {}), ...(decidedBefore ? { valueTo: decidedBefore } : {}) });
  }

  if (!query && filters.length === 0 && rangeFilters.length === 0) {
    // A bare browse of "recent decisions" is a real, valid use of this tool —
    // ODP's own `q` default is "*" / match-all, same convention as the
    // sibling /applications/search endpoint's "*" for an unconstrained list.
  }

  const body: Record<string, unknown> = {
    q: query || '*',
    pagination: { offset, limit },
  };
  if (filters.length) body.filters = filters;
  if (rangeFilters.length) body.rangeFilters = rangeFilters;

  const res = await pwFetch(`${BASE}/petition/decisions/search`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (wantsRaw(args)) {
    const text = await res.text().catch(() => '');
    return { debug: true, route: '/api/v1/petition/decisions/search', request_body: body, status: res.status, body_excerpt: text.slice(0, 500) };
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('USPTO ODP rejected the API key. Verify the key at https://data.uspto.gov/myodp');
  }
  if (res.status === 429) {
    throw new Error('USPTO ODP rate limit hit (429) — back off and retry.');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const detail = text ? summarizeErrorBody(text) : '';
    throw new Error(
      `USPTO ODP error ${res.status}${detail ? `: ${detail}` : ''}` +
        (res.status === 400 && text ? ` [raw body: ${text.slice(0, 300)}]` : ''),
    );
  }

  const data = await parseJson<{ count?: number; petitionDecisionDataBag?: Record<string, unknown>[] }>(res, 'USPTO ODP Final Petition Decisions');
  const docs = data.petitionDecisionDataBag ?? [];

  const results = docs.map((doc) => ({
    application_number: doc.applicationNumberText ?? null,
    decision_record_id: doc.petitionDecisionRecordIdentifier ?? null,
    decision_type_code: doc.decisionTypeCode ?? null,
    decision_date: doc.decisionDate ?? null,
    petition_type_code: doc.decisionPetitionTypeCode ?? null,
    petition_type: doc.decisionPetitionTypeCodeDescriptionText ?? null,
    petition_mail_date: doc.petitionMailDate ?? null,
    final_deciding_office: doc.finalDecidingOfficeName ?? null,
    invention_title: doc.inventionTitle ?? null,
    petition_issues: doc.petitionIssueConsideredTextBag ?? [],
    prosecution_status: doc.prosecutionStatusCodeDescriptionText ?? null,
    rules_cited: doc.ruleBag ?? [],
    statutes_cited: doc.statuteBag ?? [],
  }));

  return {
    query: query || null,
    application_number: appNum,
    total: data.count ?? results.length,
    returned: results.length,
    offset,
    results,
    source: 'USPTO Open Data Portal, Final Petition Decisions dataset',
  };
}

// ── callTool router ──────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_office_actions':
      return searchOfficeActions(args);
    case 'get_office_action_text':
      return getOfficeActionText(args);
    case 'get_office_action_rejections':
      return getOfficeActionRejections(args);
    case 'get_office_action_citations':
      return getOfficeActionCitations(args);
    case 'search_petition_decisions':
      return searchPetitionDecisions(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 3 } } satisfies McpToolExport;
