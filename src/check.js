/**
 * Judgement rules for URL checking, kept apart from the network so each one can be tested against fixed input.
 */
import * as cheerio from 'cheerio';

/**
 * A page that answers 200 while actually being an error page: a "soft 404".
 *
 * These are worse than real 404s, because every automated check calls them healthy and they quietly rot a site's
 * search presence. Detection is a judgement call, so it is deliberately conservative: the page has to be short,
 * and either say plainly that the thing is missing in its title, or say so in a heading with almost no other
 * content around it. A long article about 404 pages must not trip it.
 */
const MISSING_PHRASES = /\b(404|not found|page not found|page doesn'?t exist|page does not exist|no longer available|page unavailable|nothing here|seite nicht gefunden|page introuvable|página no encontrada|pagina non trovata)\b/i;

export function detectSoftError(html, { statusCode } = {}) {
    if (statusCode >= 400) return null; // already an honest error
    const $ = cheerio.load(html ?? '');
    $('script, style, noscript, svg').remove();
    const title = ($('title').first().text() || '').trim();
    const heading = ($('h1').first().text() || '').trim();
    const bodyText = ($('body').text() || '').replace(/\s+/g, ' ').trim();

    // Length is the discriminator. An error page is short; an article *about* error pages is not, and
    // "How to design a good 404 page" would otherwise be flagged by its title alone.
    if (MISSING_PHRASES.test(title) && bodyText.length < 1200) {
        return { softError: true, reason: `the page is short and its title says "${title.slice(0, 80)}"`, evidence: 'title' };
    }
    // A heading is a weaker signal than a title, so it needs an even emptier page.
    if (MISSING_PHRASES.test(heading) && bodyText.length < 600) {
        return { softError: true, reason: `the page is nearly empty and its heading says "${heading.slice(0, 80)}"`, evidence: 'heading' };
    }
    return null;
}

/**
 * Classifies a finished check into something a person can filter on.
 *
 * 401, 403 and 429 get their own class rather than being called broken. A human visitor usually sees those
 * pages perfectly well; the status means bot protection or rate limiting turned away the checker. Lumping them
 * in with 404s is what makes most link reports too noisy to act on, since review sites and social networks
 * block datacenter traffic as a matter of course.
 *
 * A failed certificate outranks the HTTP status: our client does not verify certificates, so expired.badssl.com
 * answers a cheerful 200 here while every browser blocks it with a full-page warning. For a visitor that link is
 * dead, so it is reported as such.
 */
export function classify({ statusCode, error, redirects = [], softError, certificate }) {
    if (error) return 'unreachable';
    if (certificate && certificate.authorized === false) return 'insecure';
    if (statusCode >= 500) return 'server-error';
    if ([401, 403, 429].includes(statusCode)) return 'blocked';
    if (statusCode >= 400) return 'broken';
    if (softError) return 'soft-error';
    if (redirects.length) return 'redirected';
    if (statusCode >= 200 && statusCode < 300) return 'ok';
    return 'other';
}

/**
 * Walks a redirect chain that was captured hop by hop, and reports what is wrong with it.
 *
 * A loop is a URL that repeats. A chain longer than a couple of hops wastes crawl budget and link equity, which
 * is the reason SEO audits care. A chain that ends up on a different registrable host is worth flagging too,
 * because that is how expired links end up pointing at parked-domain spam.
 */
export function describeChain(hops) {
    if (!hops.length) return { length: 0, loop: false, mixedProtocol: false, leavesHost: false };
    const seen = new Set();
    let loop = false;
    for (const hop of hops) {
        if (seen.has(hop.url)) {
            loop = true;
            break;
        }
        seen.add(hop.url);
    }
    const protocols = new Set(hops.map((h) => safeProtocol(h.url)).filter(Boolean));
    const hosts = hops.map((h) => safeHost(h.url)).filter(Boolean);
    return {
        length: hops.length,
        loop,
        // https -> http anywhere in the chain downgrades the connection, which browsers increasingly block.
        mixedProtocol: protocols.size > 1,
        leavesHost: hosts.length > 1 && hosts[0] !== hosts[hosts.length - 1],
    };
}

function safeProtocol(url) {
    try {
        return new URL(url).protocol;
    } catch {
        return null;
    }
}

function safeHost(url) {
    try {
        return new URL(url).hostname.replace(/^www\./i, '');
    } catch {
        return null;
    }
}

/** Days until a TLS certificate expires, negative when it already has. */
export function daysUntil(dateString) {
    const t = Date.parse(dateString ?? '');
    if (Number.isNaN(t)) return null;
    return Math.round((t - Date.now()) / 86400000);
}

/** Extracts the links worth checking from a page, for the crawl-a-page mode. */
export function linksFromPage(html, baseUrl, { includeExternal = true } = {}) {
    const $ = cheerio.load(html ?? '');
    const found = new Map();
    let base;
    try {
        base = new URL(baseUrl);
    } catch {
        return [];
    }
    $('a[href]').each((_, el) => {
        const href = el.attribs?.href;
        if (!href || /^(mailto:|tel:|javascript:|data:|#)/i.test(href)) return;
        let u;
        try {
            u = new URL(href, baseUrl);
        } catch {
            return;
        }
        if (!/^https?:$/.test(u.protocol)) return;
        const isExternal = safeHost(u.href) !== safeHost(base.href);
        if (isExternal && !includeExternal) return;
        const clean = `${u.origin}${u.pathname}${u.search}`;
        if (!found.has(clean)) {
            found.set(clean, { url: clean, external: isExternal, anchor: $(el).text().replace(/\s+/g, ' ').trim().slice(0, 120) || null });
        }
    });
    return [...found.values()];
}

/**
 * Whether a request error says something about our connection rather than about the link.
 *
 * The one that matters in practice is HTTP/2 GOAWAY: a server retires a connection our client was about to reuse,
 * and the request dies before it is ever sent. Reporting that as an unreachable host is a false alarm — the same
 * URL answers 200 on the next attempt, which is what happened to two apify.com links on the first platform run.
 * `ENOTFOUND` is deliberately absent: a host that does not resolve really is broken. `EAI_AGAIN` is a temporary
 * resolver failure and belongs here.
 */
const TRANSIENT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'EAI_AGAIN', 'ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_STREAM_CANCEL', 'ERR_HTTP2_INVALID_SESSION', 'ERR_SSL_BAD_RECORD_MAC_ALERT']);
const TRANSIENT_MESSAGES = /GOAWAY|socket hang up|Client network socket disconnected|stream has been aborted|read ECONNRESET/i;

export function isTransientError(err) {
    if (!err) return false;
    if (TRANSIENT_CODES.has(err.code)) return true;
    return TRANSIENT_MESSAGES.test(String(err.message ?? ''));
}
