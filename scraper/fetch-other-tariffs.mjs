#!/usr/bin/env node
// Refreshes data/other-tariffs.json with non-Octopus tariff rates.
//
// Honest caveat: there is no public API for the whole UK tariff market, and
// supplier quote pages are postcode-gated and change layout without notice.
// This script therefore works adapter-by-adapter: each adapter either parses
// a page that has proven stable enough, or fails loudly so the previous
// figure for that supplier is kept (with its original sourcedAt date).
//
// Usage:  node scraper/fetch-other-tariffs.mjs
// Cron:   run weekly; commit/sync the updated JSON wherever the PWA is hosted.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'other-tariffs.json');
const UA = { 'User-Agent': 'Mozilla/5.0 (tariff-compare personal use)' };

async function fetchText(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Adapter: Ofgem unit-rates page. Most suppliers' standard variable tariffs
// sit at (or a hair under) the cap, so the cap is a good proxy for "any SVT".
// The page lists current and next cap periods side by side as:
//   "Electricity  24.67 pence per kWh 57.21 pence daily standing charge
//                 26.11 pence per kWh 57.19 pence daily standing charge"
// ---------------------------------------------------------------------------
const OFGEM_URL = 'https://www.ofgem.gov.uk/information-consumers/energy-advice-households/energy-price-cap-unit-rates-and-standing-charges';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// "1 April to 30 June 2026" -> period end as a Date, or null if unparseable.
function periodEnd(period) {
  const m = /to (\d{1,2}) (\w+) (\d{4})/i.exec(period || '');
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  return month < 0 ? null : new Date(Date.UTC(+m[3], month, +m[1], 23, 59, 59));
}

async function ofgemPriceCap() {
  const html = await fetchText(OFGEM_URL);
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#1?60;/g, ' ') // entities survive tag-stripping
    .replace(/\s+/g, ' ');
  const periods = [...text.matchAll(
    /price cap per unit and standing charge (\d{1,2} \w+ to \d{1,2} \w+ \d{4})/gi
  )].map(m => m[1]);
  const pair = /(\d{1,2}\.\d{1,2})\s*pence per kWh\s*(\d{1,2}\.\d{1,2})\s*pence daily standing charge/g;
  const elec = /Electricity[\s ]*((?:\d{1,2}\.\d{1,2}\s*pence per kWh\s*\d{1,2}\.\d{1,2}\s*pence daily standing charge\s*){1,2})/i.exec(text);
  if (!elec) throw new Error('Ofgem page layout changed — update the regexes');
  const pairs = [...elec[1].matchAll(pair)];
  if (!pairs.length) throw new Error('Ofgem page layout changed — no rate pairs parsed');
  // The page keeps the outgoing period visible after a cap change, so drop
  // any period that has already ended — otherwise the "current" entry can be
  // last quarter's rates (seen 2026-07: Apr–Jun still listed first, four days
  // into the Jul–Sep cap).
  const now = new Date();
  const live = pairs
    .map(([, unit, standing], i) => ({ unit: +unit, standing: +standing, period: periods[i] || '' }))
    .filter(({ period }) => {
      const end = periodEnd(period);
      return !end || end >= now;
    });
  if (!live.length) throw new Error('Ofgem page parsed but every cap period looks expired — check the period regex');
  return live.map(({ unit, standing, period }, i) => ({
    id: i === 0 ? 'svt-price-cap' : 'svt-price-cap-next',
    supplier: 'Any supplier (SVT at price cap)',
    name: `Standard Variable @ Ofgem cap${period ? ` (${period})` : i ? ' (next period)' : ''}`,
    unitRate: unit,
    standingCharge: standing,
    offPeakRate: null, offPeakStart: null, offPeakEnd: null,
    notes: 'National-average cap level; regional rates vary a few percent',
    source: OFGEM_URL,
  }));
}

// ---------------------------------------------------------------------------
// Adapters for individual suppliers go here. Pattern: fetch a rates/PDF/JSON
// endpoint, parse defensively, throw on any ambiguity. Quote-gated suppliers
// (postcode + usage forms behind POST flows) are better maintained by hand in
// data/other-tariffs.json — see scraper/README.md for where to look rates up.
// ---------------------------------------------------------------------------
// Each adapter owns a fixed id family: on success its stale entries are
// retired (e.g. svt-price-cap-next lingering after the next period starts),
// on failure the previous figures are kept untouched.
const ADAPTERS = [{ fn: ofgemPriceCap, owns: ['svt-price-cap', 'svt-price-cap-next'] }];

const existing = JSON.parse(await readFile(OUT, 'utf8').catch(() => '{"tariffs":[]}'));
const byId = new Map(existing.tariffs.map(t => [t.id, t]));
let updated = 0, failed = 0;

for (const { fn, owns } of ADAPTERS) {
  try {
    const fresh = await fn();
    for (const id of owns) byId.delete(id);
    for (const t of fresh) {
      byId.set(t.id, { ...t, sourcedAt: new Date().toISOString().slice(0, 10) });
      updated++;
      console.log(`✓ ${t.supplier} — ${t.name}: ${t.unitRate}p/kWh + ${t.standingCharge}p/day`);
    }
  } catch (err) {
    failed++;
    console.error(`✗ ${fn.name}: ${err.message} (keeping previous figures)`);
  }
}

const tariffs = [...byId.values()];
// An id both tombstoned and live again (an adapter re-emitting a retired id,
// e.g. svt-price-cap-next once the next cap period is announced) comes off
// the tombstone list — the live entry wins.
const emitted = new Set(tariffs.map(t => t.id));
const removed = (existing.removed || []).filter(id => !emitted.has(id));

await writeFile(OUT, JSON.stringify({
  ...existing, // keep top-level fields like "note", "schema", "closedToNew"
  updated: new Date().toISOString().slice(0, 10),
  tariffs,
  removed,
}, null, 2) + '\n');
console.log(`\nWrote ${tariffs.length} tariffs to ${OUT} (${updated} refreshed, ${failed} adapter failures)`);
