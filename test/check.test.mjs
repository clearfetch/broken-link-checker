import assert from 'node:assert/strict';
import { classify, daysUntil, describeChain, detectSoftError, isTransientError, linksFromPage } from '../src/check.js';

// --- soft errors: a page that answers 200 while actually being an error page -------------------------------
const softByTitle = detectSoftError('<html><head><title>404 - Page not found</title></head><body><p>Sorry.</p></body></html>', { statusCode: 200 });
assert.ok(softByTitle?.softError, 'an error page announced in the title is caught');
assert.equal(softByTitle.evidence, 'title');

const softByHeading = detectSoftError('<html><head><title>Acme</title></head><body><h1>Page not found</h1><p>Try the home page.</p></body></html>', { statusCode: 200 });
assert.ok(softByHeading?.softError, 'a near-empty page whose heading says so is caught');
assert.equal(softByHeading.evidence, 'heading');

// The false positive that matters: a real article about error pages must not be flagged.
const article = `<html><head><title>How to design a good 404 page</title></head><body><h1>Designing your 404 page</h1>
  <p>${'A thoughtful error page keeps visitors on your site. '.repeat(30)}</p></body></html>`;
assert.equal(detectSoftError(article, { statusCode: 200 })?.softError, undefined,
    'a long article about 404 pages is not a soft error');

// A page that merely mentions the phrase deep in its body is not an error page either.
const mentions = `<html><head><title>Release notes</title></head><body><h1>Release notes</h1>
  <p>${'We shipped a lot this quarter. '.repeat(40)} We also fixed a page not found bug.</p></body></html>`;
assert.equal(detectSoftError(mentions, { statusCode: 200 })?.softError, undefined, 'a passing mention is not an error page');

// An honest 404 is not a soft error; it is just a 404.
assert.equal(detectSoftError('<html><title>404</title></html>', { statusCode: 404 }), null);

// --- classification ---------------------------------------------------------------------------------------
assert.equal(classify({ statusCode: 200 }), 'ok');
assert.equal(classify({ statusCode: 404 }), 'broken');
assert.equal(classify({ statusCode: 503 }), 'server-error');
// Bot protection is not a broken link: a person following it sees the page.
assert.equal(classify({ statusCode: 403 }), 'blocked');
assert.equal(classify({ statusCode: 401 }), 'blocked');
assert.equal(classify({ statusCode: 429 }), 'blocked');
assert.equal(classify({ statusCode: 410 }), 'broken', 'gone really is gone');
assert.equal(classify({ error: 'ENOTFOUND' }), 'unreachable');
// Our HTTP client does not verify certificates, so a rejected certificate has to override a healthy status:
// expired.badssl.com answers 200 here and is blocked by every browser.
assert.equal(classify({ statusCode: 200, certificate: { authorized: false } }), 'insecure');
assert.equal(classify({ statusCode: 200, certificate: { authorized: true, expiresInDays: 12 } }), 'ok',
    'a certificate that is merely expiring soon is still valid today');
assert.equal(classify({ statusCode: 200, softError: true }), 'soft-error');
assert.equal(classify({ statusCode: 200, redirects: [{ url: 'a' }] }), 'redirected');

// --- redirect chains --------------------------------------------------------------------------------------
const simple = describeChain([{ url: 'https://a.com/1', status: 301, to: 'https://a.com/2' }]);
assert.equal(simple.length, 1);
assert.equal(simple.loop, false);
assert.equal(simple.leavesHost, false);

const loop = describeChain([
    { url: 'https://a.com/1', status: 301, to: 'https://a.com/2' },
    { url: 'https://a.com/2', status: 301, to: 'https://a.com/1' },
    { url: 'https://a.com/1', status: 301, to: 'https://a.com/2' },
]);
assert.equal(loop.loop, true, 'a repeated URL is a loop');

const downgrade = describeChain([
    { url: 'https://a.com/1', status: 301, to: 'http://a.com/2' },
    { url: 'http://a.com/2', status: 301, to: 'http://a.com/3' },
]);
assert.equal(downgrade.mixedProtocol, true, 'https falling back to http is worth flagging');

const offsite = describeChain([
    { url: 'https://a.com/1', status: 301, to: 'https://b.com/x' },
    { url: 'https://b.com/x', status: 302, to: 'https://b.com/y' },
]);
assert.equal(offsite.leavesHost, true, 'a chain that ends on another host is worth flagging');
assert.equal(describeChain([]).length, 0, 'no redirects is not an error');

// --- certificate expiry -----------------------------------------------------------------------------------
const future = new Date(Date.now() + 30 * 86400000).toUTCString();
const past = new Date(Date.now() - 5 * 86400000).toUTCString();
assert.ok(Math.abs(daysUntil(future) - 30) <= 1);
assert.ok(daysUntil(past) < 0, 'an expired certificate gives a negative number');
assert.equal(daysUntil('not a date'), null);

// --- link discovery ---------------------------------------------------------------------------------------
const links = linksFromPage(`<body>
    <a href="/internal">Internal</a>
    <a href="https://other.com/page">External</a>
    <a href="mailto:x@y.com">Mail</a>
    <a href="#section">Anchor</a>
    <a href="javascript:void(0)">JS</a>
    <a href="/internal">Duplicate</a>
  </body>`, 'https://mine.com/start');
assert.equal(links.length, 2, 'mailto, in-page anchors, javascript and duplicates are dropped');
assert.deepEqual(links.map((l) => l.external), [false, true]);
assert.equal(links[0].anchor, 'Internal', 'the anchor text is kept so a report can name the link');

const internalOnly = linksFromPage('<body><a href="/a">A</a><a href="https://other.com/b">B</a></body>', 'https://mine.com/', { includeExternal: false });
assert.deepEqual(internalOnly.map((l) => l.url), ['https://mine.com/a']);

// --- transient connection errors --------------------------------------------------------------------------
// The real one, from the first platform run: two working apify.com links were called unreachable.
assert.equal(isTransientError(new Error('New streams cannot be created after receiving a GOAWAY')), true);
assert.equal(isTransientError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
assert.equal(isTransientError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), true);
// A host that does not resolve is genuinely broken and must not be retried away.
assert.equal(isTransientError(Object.assign(new Error('getaddrinfo ENOTFOUND nope.example'), { code: 'ENOTFOUND' })), false);
assert.equal(isTransientError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), false);
assert.equal(isTransientError(null), false);

console.log('ALL LINK CHECKER TESTS PASSED');
