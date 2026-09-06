import { readFileSync, readdirSync, existsSync } from 'node:fs';

const dir = 'storage/datasets/default';
const items = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(`${dir}/${f}`)))
    : [];
console.log(`items: ${items.length}`);

const byStatus = {};
for (const i of items) byStatus[i.status ?? 'crawl-error'] = (byStatus[i.status ?? 'crawl-error'] ?? 0) + 1;
console.log('by status:', byStatus);

for (const i of items.filter((x) => x.status && x.status !== 'ok').slice(0, 12)) {
    const chain = i.redirectChain
        ? ` chain=${i.redirectChain.length}${i.redirectChain.loop ? ' LOOP' : ''}${i.redirectChain.mixedProtocol ? ' DOWNGRADE' : ''}${i.redirectChain.leavesHost ? ' OFFSITE' : ''}`
        : '';
    console.log(`  ${String(i.status).padEnd(13)} ${String(i.statusCode ?? '-').padStart(3)}  ${i.url.slice(0, 58)}${chain}`);
    if (i.softError) console.log(`      soft 404: ${i.softError.reason}`);
    if (i.error) console.log(`      ${i.error}`);
}
const certs = items.filter((i) => i.certificate?.expiresInDays !== undefined && i.certificate?.expiresInDays !== null);
if (certs.length) {
    const soonest = certs.sort((a, b) => a.certificate.expiresInDays - b.certificate.expiresInDays)[0];
    console.log(`certificates checked: ${certs.length}, soonest expiry ${soonest.certificate.expiresInDays} days (${soonest.url.slice(0, 40)})`);
}

const cdir = 'storage/datasets/charging_log';
const charges = existsSync(cdir) ? readdirSync(cdir).filter((f) => f.endsWith('.json')) : [];
const byEvent = {};
for (const f of charges) {
    const { eventName } = JSON.parse(readFileSync(`${cdir}/${f}`));
    byEvent[eventName] = (byEvent[eventName] ?? 0) + 1;
}
console.log('charged   :', charges.length, byEvent);
