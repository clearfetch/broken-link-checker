import tls from 'node:tls';
import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { classify, daysUntil, describeChain, detectSoftError, isTransientError, linksFromPage } from './check.js';

const EVENT_URL = 'url-checked';
const EVENT_PAGE = 'page-crawled';
/**
 * Distinguishes "the host never answered" from "the request failed for another reason". Declared up here, not
 * beside `request()`, because anything below the first top-level `await` is still in its temporal dead zone
 * when the work starts. See the note in the repo's CLAUDE.md; this is the fourth Actor to hit it.
 */
const TIMED_OUT = Symbol('timed out');

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const urls = normalizeUrls(input);
const crawlPages = normalizeUrls(input, ['crawlPages', 'pages', 'checkLinksOn']);
if (!urls.length && !crawlPages.length) {
    await Actor.fail('Nothing to check. Pass "urls" (the links to check), or "crawlPages" (pages whose links should be checked), or "url" for a single one.');
}
const includeExternal = input.includeExternal !== false;
const detectSoftErrors = input.detectSoftErrors !== false;
const checkCertificates = input.checkCertificates === true;
const maxRedirects = clamp(Number(input.maxRedirects ?? 10), 0, 20);
const maxConcurrency = clamp(Number(input.maxConcurrency ?? 10), 1, 50);
const timeoutMs = clamp(Number(input.timeoutSecs ?? 20), 5, 120) * 1000;
const onlyProblems = input.onlyProblems === true;
const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);

const targets = new Map();
for (const url of urls) targets.set(url, { url, foundOn: null, anchor: null, external: null });

// Crawl mode: take the links off a page and check those, which is how a broken-link audit actually starts.
for (const page of crawlPages) {
    try {
        const res = await fetchPage(page);
        const links = linksFromPage(res.body ?? '', res.url || page, { includeExternal });
        for (const link of links) {
            if (!targets.has(link.url)) targets.set(link.url, { url: link.url, foundOn: page, anchor: link.anchor, external: link.external });
        }
        await Actor.charge({ eventName: EVENT_PAGE });
        log.info(`${page}: found ${links.length} link(s) to check`);
    } catch (err) {
        log.warning(`Could not read ${page}: ${err.message}`);
        await Actor.pushData({ url: page, ok: false, role: 'crawled-page', error: err.message, checkedAt: new Date().toISOString() });
    }
}

const list = [...targets.values()];
log.info(`Checking ${list.length} URL(s), concurrency ${maxConcurrency}${onlyProblems ? ', reporting problems only' : ''}`);

let done = 0;
let charged = 0;
// A redirect is reportable without being broken, which is exactly what an SEO audit wants, so the two are
// counted apart: `flagged` is everything that is not a plain 200, `brokenCount` is what someone has to fix.
let flagged = 0;
let brokenCount = 0;
let stop = false;

await runPool(list, maxConcurrency, async (target) => {
    if (stop) return;
    const item = await checkUrl(target);
    done += 1;
    if (item.status !== 'ok') flagged += 1;
    if (item.broken) brokenCount += 1;
    // Every checked URL is charged, including broken ones: finding the broken link is the product.
    if (!onlyProblems || item.status !== 'ok') {
        const result = await Actor.pushData(item, EVENT_URL);
        charged += 1;
        if (result?.eventChargeLimitReached) {
            stop = true;
            log.warning('The maximum cost set for this run has been reached, stopping.');
        }
    } else {
        // The check happened and is charged even though the row is filtered out: the work is per URL, not per
        // problem found. The summary row written at the end of the run makes that visible in the dataset.
        await Actor.charge({ eventName: EVENT_URL });
        charged += 1;
    }
    if (done % 25 === 0 || done === list.length) {
        await Actor.setStatusMessage(`${done}/${list.length} checked, ${brokenCount} broken, ${flagged} flagged`);
    }
});

if (onlyProblems) {
    await Actor.pushData({
        role: 'summary',
        checked: done,
        broken: brokenCount,
        flagged,
        note: `"onlyProblems" was on, so healthy links were not written. ${done} URL(s) were checked, ${done - flagged} answered 200 with no redirect.`,
        checkedAt: new Date().toISOString(),
    });
}

log.info(`Finished: ${done} URL(s) checked, ${brokenCount} broken, ${flagged} flagged, ${charged} charged`);
await Actor.exit();

// ---------------------------------------------------------------------------------------------------------

async function checkUrl(target) {
    const started = Date.now();
    // One unresponsive URL must not stall the run. Each request already has its own timeout, but a chain of
    // redirects, each with a HEAD and a GET and a retry, multiplies them: eleven hops at 20 seconds is minutes
    // on a single link. This is the ceiling for the whole URL.
    const deadline = started + timeoutMs * 2;
    const hops = [];
    const visited = new Set([target.url]);
    let current = target.url;
    let response = null;
    let error = null;
    let timedOutChain = false;

    try {
        for (let i = 0; i <= maxRedirects; i += 1) {
            if (Date.now() > deadline) {
                timedOutChain = true;
                break;
            }
            // HEAD is an optimisation, not a verdict. Plenty of hosts, especially behind bot protection, accept
            // a HEAD and never answer while serving GET perfectly well: console.apify.com does exactly this.
            // So HEAD gets a short leash, and anything other than a clean answer falls through to GET.
            let res = await request(current, 'HEAD', Math.min(Math.round(timeoutMs / 2), 8000));
            if (res === TIMED_OUT || !res || res.statusCode === 405 || res.statusCode === 501 || res.statusCode === 0) {
                res = await request(current, 'GET', timeoutMs);
                if (res === TIMED_OUT) {
                    error = `timed out after ${Math.round(timeoutMs / 1000)}s`;
                    break;
                }
            }
            if (!res) throw new Error('no response');
            const location = res.headers?.location;
            if (res.statusCode >= 300 && res.statusCode < 400 && location) {
                let next;
                try {
                    next = new URL(location, current).href;
                } catch {
                    response = res;
                    break;
                }
                hops.push({ url: current, status: res.statusCode, to: next });
                // A loop is a destination we have already been to. Comparing against the hop just pushed would
                // always match, which ended every chain after one hop and left the final status unknown.
                if (visited.has(next)) break;
                visited.add(next);
                current = next;
                if (i === maxRedirects) {
                    response = res;
                    break;
                }
                continue;
            }
            response = res;
            break;
        }
    } catch (err) {
        error = err.message;
    }

    if (timedOutChain && !error) error = `gave up after ${Math.round((timeoutMs * 2) / 1000)}s of redirects`;

    let soft = null;
    if (!error && detectSoftErrors && response && response.statusCode < 400 && Date.now() < deadline) {
        // The soft-404 check needs a body, and HEAD does not have one. This sits outside the main try, so it
        // needs its own guard: a failure here means we cannot judge the page, not that the URL is broken.
        try {
            const fallback = await request(current, 'GET');
            const body = response.body && response.body.length ? response.body : (fallback === TIMED_OUT ? null : fallback?.body);
            if (body) soft = detectSoftError(body, { statusCode: response.statusCode });
        } catch {
            /* leave soft as null: the status code we already have stands */
        }
    }

    const chain = describeChain(hops);
    // Inspected before classifying, because a certificate a browser rejects makes the link dead whatever the
    // HTTP status said.
    let certificate;
    if (checkCertificates && !error && current.startsWith('https:') && Date.now() < deadline) certificate = await inspectCertificate(current);
    const status = classify({ statusCode: response?.statusCode, error, redirects: hops, softError: soft?.softError, certificate });

    return {
        url: target.url,
        finalUrl: current !== target.url ? current : undefined,
        // `ok` answers "does this link work", so a 403 is not ok even though the request itself succeeded, and a
        // redirect that lands on a 200 is. `broken` is narrower: only the statuses that need someone to fix them.
        ok: ['ok', 'redirected'].includes(status),
        status,
        statusCode: response?.statusCode ?? null,
        // "blocked" is deliberately not counted as broken: the link works for people, the checker was turned away.
        broken: ['broken', 'server-error', 'unreachable', 'soft-error', 'insecure'].includes(status),
        error,
        redirects: hops.length ? hops : undefined,
        redirectChain: hops.length ? chain : undefined,
        softError: soft ? { reason: soft.reason, evidence: soft.evidence } : undefined,
        certificate,
        contentType: response?.headers?.['content-type'] ?? null,
        foundOn: target.foundOn ?? undefined,
        anchor: target.anchor ?? undefined,
        external: target.external ?? undefined,
        elapsedMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
    };
}

async function request(url, method, budgetMs = timeoutMs, attempt = 0) {
    try {
        const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
        return await gotScraping({
            url,
            method,
            proxyUrl,
            // HTTP/2 on the first attempt, because that is what the browser fingerprint claims. The retry drops to
            // HTTP/1.1, which cannot produce a GOAWAY: retrying over h2 can land on the same retired session, and
            // a link was still being called unreachable that way after the first fix.
            http2: attempt === 0,
            // got's request timeout covers time to first byte, not the body, so a server that dribbles a
            // response can outlast it. The abort signal is the hard ceiling for the whole exchange.
            timeout: { request: budgetMs },
            signal: AbortSignal.timeout(budgetMs),
            responseType: 'text',
            throwHttpErrors: false,
            followRedirect: false, // followed by hand so every hop can be reported
            retry: { limit: 0 }, // a retry doubles the worst case on exactly the hosts that are already slow
            headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 120 }], devices: ['desktop'] },
        });
    } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError' || err.code === 'ETIMEDOUT' || err.code === 'ABORT_ERR') return TIMED_OUT;
        // One retry, only for errors that describe our own connection. Blanket retries are off on purpose because
        // they double the worst case on the slow hosts, but a connection the server retired before our request
        // was sent tells us nothing about the link and must not be reported as a dead one.
        if (attempt === 0 && isTransientError(err)) return request(url, method, budgetMs, 1);
        if (method === 'HEAD') return null; // a rejected HEAD is common; let the GET fallback try
        throw err;
    }
}

async function fetchPage(url) {
    const res = await gotScraping({
        url,
        timeout: { request: timeoutMs },
        responseType: 'text',
        throwHttpErrors: false,
        headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 120 }], devices: ['desktop'] },
    });
    if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`);
    return res;
}

/** Certificate expiry and validity, which is the other thing that silently breaks links. */
function inspectCertificate(url) {
    return new Promise((resolve) => {
        let host;
        let port;
        try {
            const parsed = new URL(url);
            host = parsed.hostname;
            port = Number(parsed.port) || 443;
        } catch {
            return resolve(undefined);
        }
        // `rejectUnauthorized: false` on purpose: a handshake that fails tells us nothing about the certificate,
        // and the certificate is the thing we came for. The verdict is read from `authorized` instead, so an
        // expired or self-signed certificate still reports its issuer and dates.
        const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: Math.min(timeoutMs, 10000) }, () => {
            const cert = socket.getPeerCertificate();
            const expiresInDays = daysUntil(cert?.valid_to);
            const authorized = socket.authorized;
            const authorizationError = socket.authorizationError ? String(socket.authorizationError.message ?? socket.authorizationError) : null;
            socket.destroy();
            resolve({
                issuer: cert?.issuer?.O ?? cert?.issuer?.CN ?? null,
                subject: cert?.subject?.CN ?? null,
                validFrom: cert?.valid_from ?? null,
                validTo: cert?.valid_to ?? null,
                expiresInDays,
                expired: expiresInDays !== null && expiresInDays < 0,
                authorized,
                authorizationError,
            });
        });
        socket.on('error', (err) => {
            socket.destroy();
            resolve({ error: err.message });
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve({ error: 'timed out' });
        });
    });
}

function normalizeUrls(inp, keys = ['urls', 'url', 'startUrls', 'links']) {
    const raw = [];
    const push = (v) => {
        if (!v) return;
        if (Array.isArray(v)) return v.forEach(push);
        if (typeof v === 'object') return push(v.url ?? v.link ?? v.href);
        String(v)
            .split(/[\n\r,;]+/)
            .map((s) => s.trim())
            .filter(Boolean)
            .forEach((s) => raw.push(s));
    };
    for (const key of keys) push(inp[key]);
    const seen = new Set();
    const out = [];
    for (const entry of raw) {
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(entry);
        if (scheme && !/^https?$/i.test(scheme[1])) {
            log.warning(`Skipping unsupported scheme "${scheme[1]}:": ${entry}`);
            continue;
        }
        let parsed;
        try {
            parsed = new URL(scheme ? entry : `https://${entry}`);
        } catch {
            log.warning(`Skipping invalid URL: ${entry}`);
            continue;
        }
        if (!parsed.hostname?.includes('.')) {
            log.warning(`Skipping URL without a valid hostname: ${entry}`);
            continue;
        }
        if (!seen.has(parsed.href)) {
            seen.add(parsed.href);
            out.push(parsed.href);
        }
    }
    return out;
}

async function runPool(items, size, worker) {
    let index = 0;
    const next = async () => {
        while (index < items.length) await worker(items[index++]);
    };
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, next));
}

function clamp(n, lo, hi) {
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}
