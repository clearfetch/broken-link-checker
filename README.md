# Broken Link Checker - Bulk URL Status, Redirect Chains & Soft 404s

Paste a list of URLs, or give it a page and let it check every link on that page. You get the status code, the
full redirect chain hop by hop, and the three failures that ordinary link checkers miss: soft 404s, expired
certificates, and bot protection misreported as a dead link.
**$0.50 per 1,000 URLs checked, plus $0.002 per page crawled for links.**

## Why this one

Most link checkers hand you a list of status codes and leave the judgement to you. The judgement is the hard part:

- **Soft 404s.** A page that answers `200 OK` while actually saying "page not found" passes every status check
  ever written, and quietly rots your search presence. This flags them, and does it without flagging an article
  *about* 404 pages: the page has to be short as well as say so.
- **Bot protection is not a broken link.** Capterra, G2, LinkedIn and most review sites answer `403` to any
  datacenter IP. A checker that files those under "broken" produces a report nobody can act on, so 401, 403 and
  429 get their own `blocked` status and are explicitly **not** counted as broken.
- **Certificates a browser rejects.** HTTP clients do not verify certificates the way browsers do, so an expired
  certificate returns a cheerful `200` to a scraper while every real visitor hits a full-page warning. Turn on
  certificate checking and those come back as `insecure`, with the issuer, the dates and the reason.
- **A HEAD request is an optimisation, not a verdict.** Plenty of hosts accept a `HEAD` and never answer it while
  serving `GET` perfectly. HEAD gets a short leash here and anything less than a clean answer falls through to a
  real GET, which is why this does not invent unreachable hosts.
- **Every hop, not just the destination.** Redirect chains are reported hop by hop with flags for loops,
  `https -> http` downgrades, and chains that end up on a different host, which is how expired links turn into
  parked-domain spam.

## What data you get

Per URL: `status` (`ok`, `redirected`, `blocked`, `broken`, `server-error`, `soft-error`, `insecure`,
`unreachable`), the HTTP `statusCode`, a single `broken` boolean for filtering, `finalUrl`, every redirect hop
with its own status, a chain summary (`length`, `loop`, `mixedProtocol`, `leavesHost`), the soft-404 verdict with
the evidence for it, certificate issuer and days to expiry, `contentType`, and `elapsedMs`.

In crawl mode each link also carries **`foundOn`** (the page it was on) and **`anchor`** (the clickable text), so
a report can name the link a person actually has to go and fix.

## How to use

1. Paste your links into **URLs to check**, one per line. Or put a page into **pages whose links to check** and
   every link on it is pulled out and checked.
2. Optionally turn on **Check TLS certificates**, or **Report problems only** for a short report.
3. Run it. One row per URL, exportable as JSON, CSV or Excel.

## Input

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `urls` | array | — | The links to check, one per line. Also accepts `url` and `startUrls`. |
| `crawlPages` | array | — | Pages to read first; every link on them is then checked. Combinable with `urls`. |
| `includeExternal` | boolean | `true` | In crawl mode, also check links pointing off the site. These rot first. |
| `detectSoftErrors` | boolean | `true` | Flag pages that answer 200 while being error pages. |
| `checkCertificates` | boolean | `false` | Report issuer and days to expiry; a rejected certificate marks the link `insecure`. |
| `onlyProblems` | boolean | `false` | Write only what is wrong, plus a summary row of how many were checked. |
| `maxRedirects` | integer | `10` | Hops to follow before giving up. Every hop is reported. |
| `maxConcurrency` | integer | `10` | URLs checked in parallel. |
| `timeoutSecs` | integer | `20` | Per-request timeout. One URL gets at most twice this in total. |
| `proxyConfiguration` | object | off | Optional. Not needed for most sites. |

## Output example

Real output. Crawling `https://apify.com/` found 90 links; with four test URLs added, all 94 were checked in 14
seconds: 76 healthy, 11 redirected, 4 blocked by bot protection, one 404, one 500, one dead host.

A healthy link, with the page it was found on:

```json
{
  "url": "https://apify.com/store",
  "ok": true,
  "status": "ok",
  "statusCode": 200,
  "broken": false,
  "error": null,
  "certificate": {
    "issuer": "Amazon",
    "subject": "*.apify.com",
    "validFrom": "Jul  3 00:00:00 2026 GMT",
    "validTo": "Jan 16 23:59:59 2027 GMT",
    "expiresInDays": 132,
    "expired": false,
    "authorized": true,
    "authorizationError": null
  },
  "contentType": "text/html; charset=utf-8",
  "foundOn": "https://apify.com/",
  "anchor": "Start here!Ready-to-run tools for your AI agents and apps.",
  "external": false,
  "elapsedMs": 106,
  "checkedAt": "2026-09-06T14:02:21.076Z"
}
```

A three-hop redirect chain, every hop reported:

```json
{
  "url": "https://httpbin.org/redirect/3",
  "finalUrl": "https://httpbin.org/get",
  "ok": true,
  "status": "redirected",
  "statusCode": 200,
  "broken": false,
  "redirects": [
    { "url": "https://httpbin.org/redirect/3", "status": 302, "to": "https://httpbin.org/relative-redirect/2" },
    { "url": "https://httpbin.org/relative-redirect/2", "status": 302, "to": "https://httpbin.org/relative-redirect/1" },
    { "url": "https://httpbin.org/relative-redirect/1", "status": 302, "to": "https://httpbin.org/get" }
  ],
  "redirectChain": { "length": 3, "loop": false, "mixedProtocol": false, "leavesHost": false },
  "contentType": "application/json",
  "elapsedMs": 1404,
  "checkedAt": "2026-09-06T14:02:22.373Z"
}
```

A dead link, and a `403` that is *not* one:

```json
{
  "url": "https://httpbin.org/status/404",
  "ok": false,
  "status": "broken",
  "statusCode": 404,
  "broken": true,
  "elapsedMs": 1221,
  "checkedAt": "2026-09-06T14:02:22.189Z"
}
```

```json
{
  "url": "https://www.capterra.com/p/150854/Apify/",
  "ok": false,
  "status": "blocked",
  "statusCode": 403,
  "broken": false,
  "foundOn": "https://apify.com/",
  "external": true,
  "elapsedMs": 7541,
  "checkedAt": "2026-09-06T13:56:41.343Z"
}
```

An expired certificate, which answers `200` to a scraper and is blocked by every browser:

```json
{
  "url": "https://expired.badssl.com/",
  "ok": false,
  "status": "insecure",
  "statusCode": 200,
  "broken": true,
  "certificate": {
    "issuer": "COMODO CA Limited",
    "subject": "*.badssl.com",
    "validTo": "Apr 12 23:59:59 2015 GMT",
    "expiresInDays": -4165,
    "expired": true,
    "authorized": false,
    "authorizationError": "CERT_HAS_EXPIRED"
  },
  "checkedAt": "2026-09-06T14:00:11.482Z"
}
```

A host that does not resolve:

```json
{
  "url": "https://this-domain-does-not-exist-12345.com/",
  "ok": false,
  "status": "unreachable",
  "statusCode": null,
  "broken": true,
  "error": "getaddrinfo ENOTFOUND this-domain-does-not-exist-12345.com",
  "checkedAt": "2026-09-06T14:02:33.918Z"
}
```

## Pricing

- **$0.0005 per URL checked** — $0.50 per 1,000. A 2,000-link site audit costs a dollar.
- **$0.002 per page crawled** for links, when you use crawl mode.
- Every URL checked is charged once, healthy or broken, including when `onlyProblems` hides the healthy rows:
  confirming a link works is the same request as finding it dead. URLs that are skipped as invalid are free.

## Use cases

- **SEO audits**: 404s, redirect chains that waste crawl budget, `https` downgrades, soft 404s.
- **Site migrations**: check the old URL list against the new site before and after the switch.
- **Documentation and link rot**: run it on a docs page or a link roundup on a schedule and get told when an
  external link dies.
- **Certificate monitoring**: catch a certificate about to expire on a host you link to, before visitors do.
- **Affiliate and directory links**: find the ones that now point at parked domains, using the `leavesHost` flag.
- **AI agents**: a tool that answers "is this link still alive, and where does it end up".

## Integrations

```bash
curl -X POST "https://api.apify.com/v2/acts/clearfetch~broken-link-checker/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"crawlPages": ["https://example.com/"], "onlyProblems": true}'
```

```python
from apify_client import ApifyClient

client = ApifyClient("YOUR_TOKEN")
run = client.actor("clearfetch/broken-link-checker").call(
    run_input={"crawlPages": ["https://example.com/"], "checkCertificates": True}
)

for link in client.dataset(run["defaultDatasetId"]).iterate_items():
    if link.get("broken"):
        print(link["status"], link["statusCode"], link["url"], "on", link.get("foundOn"))
```

Works with the Apify integrations for n8n, Make, Zapier, Google Sheets, Slack and webhooks, with scheduled runs,
and with AI agents through the Apify MCP server.

## FAQ

**Do I need a proxy?** No. A proxy input exists if you want to check links that block datacenter traffic, which
is what turns a `blocked` row into a real verdict.

**Why is a 403 not counted as broken?** Because it usually is not. Review sites, social networks and anything
behind a WAF answer 403 to automated traffic while working fine for people. They are reported as `blocked` so you
can see them without them drowning the real failures.

**How do you tell a soft 404 from a page about 404s?** Length. An error page is short; an article titled "How to
design a good 404 page" is not. The rule needs both the wording and a body under about 1,200 characters, and the
output tells you which evidence triggered it.

**What about a redirect loop?** Reported, with `loop: true` on the chain summary, and the hops that formed it.

**How fast is it?** 94 links off a real homepage in 14 seconds at the default concurrency of 10, certificate
checks included.

**Does it check images and scripts too?** No, `<a href>` links only. Asset checking is a different job.

**Is this legal?** It sends the same HTTP requests a browser sends when someone clicks the link, one per URL.

**Do you have the URL list already?** If you need one, `clearfetch/website-sitemap-extractor` pulls every URL a
site publishes, and its output feeds straight into this.

## Changelog

- **1.0.0** (2026-09) — first release: bulk checking and page crawling, hop-by-hop redirect chains with loop,
  downgrade and off-host flags, soft-404 detection, `blocked` as a class of its own, and certificate validity.
