# Working on this Actor

```bash
npm install
node test/check.test.mjs          # unit tests, no network
./scripts/run-test.sh default     # crawls a page and checks its links, charging simulated
./scripts/run-test.sh problems    # the failure paths: 404, dead host, expired and self-signed certificates
```

`src/check.js` holds the judgement rules as plain functions so they can be tested against fixed input;
`src/main.js` does the network work and the charging.

## The four judgements, and why each is written the way it is

Every one of these started out simpler and was corrected by a real run:

- **A HEAD response is an optimisation, not a verdict.** Hosts behind bot protection routinely accept a `HEAD`
  and never answer it while serving `GET` perfectly. Treating a HEAD timeout as a dead host produced ten false
  "unreachable" rows in one run, `console.apify.com` among them. HEAD now gets half the timeout, and anything
  that is not a clean answer falls through to a real GET.
- **401, 403 and 429 are `blocked`, not `broken`.** Review sites and social networks answer 403 to any datacenter
  IP while working fine for people. Filing those under broken is what makes a link report unusable.
- **A soft 404 needs length as well as wording.** "How to design a good 404 page" is an article, not an error
  page. The title rule needs a body under 1,200 characters and the weaker heading rule under 600.
- **A certificate a browser rejects overrides the HTTP status.** This client does not verify certificates, so
  `expired.badssl.com` answers a cheerful 200 to it. The TLS probe deliberately connects with
  `rejectUnauthorized: false` so that a bad certificate can still be read and reported rather than just failing.

## Two traps in the network code

- **HTTP/2 GOAWAY.** A server retiring a connection the client was about to reuse fails the request before it is
  sent, which looked exactly like an unreachable host on the first platform run. Transport-level errors get one
  retry, and that retry drops to HTTP/1.1, because retrying over h2 can land on the same retired session. Blanket
  retries stay off: they double the worst case on precisely the hosts that are already slow.
- **Timeouts need two ceilings.** `got`'s request timeout only covers time to first byte, so a server that
  dribbles a response outlasts it; `AbortSignal.timeout` is the hard limit. On top of that each URL has a whole-
  chain deadline, because a HEAD plus a GET on each of eleven redirect hops multiplies a 20-second timeout into
  minutes.

## A JavaScript trap this repo keeps hitting

Helpers and constants used by code that runs after the first top-level `await` must be `function` declarations,
not `const`. A `const` declared below that point is still in its temporal dead zone when the work starts and
throws at runtime, not at build time.
