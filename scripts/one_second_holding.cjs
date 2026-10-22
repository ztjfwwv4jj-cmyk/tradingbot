// Offline holding-cost experiment: enter every second, size cohorts so gross exposure <= 1 unit.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { forecasts, validateRows } = require("./one_second_edge.cjs");

const HOLDINGS = Object.freeze([1, 5, 15, 60]);
const PROTOCOL = Object.freeze({
  version: 1,
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  windows: {
    train: ["2026-10-15T10:00:00Z", "2026-10-15T16:00:00Z"],
    validation: ["2026-10-21T10:00:00Z", "2026-10-21T16:00:00Z"],
    test: ["2026-10-22T16:00:00Z", "2026-10-22T17:00:00Z"],
  },
  signal: "close_return", flat_on_zero: false, common_warmup: 8,
  holdings: HOLDINGS, max_gross_base_units: 1,
  fees_bps_per_side: [0, 1, 10], extra_delay_bars: [0, 1],
  full_spread_bps: 1, slippage_bps_first_open_per_side: 0.1, slippage_range_fraction: 0.02,
  sizing: "Every second enters 1/H base units and holds H seconds. Up to H live cohorts; "
    + "gross exposure is at most one base unit at all times, including opposing directions. "
    + "Both fills charged independently, never netted. All variants use the same entry "
    + "timestamps, excluding the first 8 warmup bars and the last 59 entries for terminal exits. "
    + "Unit sizes are continuous in this independent study; instrument lot rounding not modeled.",
  selection: "Train ranks fixed H=1,5,15,60 by equal-symbol net bps per unit of gross "
    + "notional-time (not bps per small order). Only train winner compared with H=1 on validation "
    + "at both delays. Freeze before opening untouched 16:00-17:00 test; no test tuning. "
    + "Require positive paired test improvement at both delays with block95 lower>0. "
    + "This is a loss-reduction gate, NOT a profitability gate.",
  uncertainty: "Paired non-overlapping 300-second entry blocks, 2000 seeded resamples; "
    + "descriptive intervals only; overlapping returns remain dependent across boundaries.",
  cost_basis: "Independent market entry at open and exit at the close H seconds later. "
    + "Full assumed spread 1bp of each fill's bar open; per-side slippage 0.1bp of window "
    + "first open plus 2% of that fill bar's range; fee on executed notional. No maker "
    + "rebates or free internal netting. One extra bar delay is a sensitivity proxy only.",
  limitation: "Different holding time and smaller per-entry units, not a new directional "
    + "edge. Mark-to-market of overlapping cohorts, borrow, financing, risk halts, margin "
    + "and gaps are not simulated. Not the Aurum Python execution engine.",
});

function simulateHolding(bars, fc, holding, feeBps, delay = 0) {
  if (!HOLDINGS.includes(holding) || ![0, 1].includes(delay) || !Number.isFinite(feeBps)
    || feeBps < 0 || fc.length !== bars.length) throw new Error("invalid holding inputs");
  const q = 1 / holding, tradeBps = [], blocks = [];
  let gross = 0, spread = 0, slippage = 0, commission = 0, traded = 0, notionalTime = 0;
  const grossPath = Array(bars.length).fill(0);
  // A common fully liquidated entry set across every holding length.
  const first = PROTOCOL.common_warmup + 1 + delay, last = bars.length - Math.max(...HOLDINGS);
  const firstPrice = bars[0].o;
  for (let i = first; i <= last; i++) {
    const d = fc[i - 1 - delay], a = bars[i], exitBar = bars[i + holding - 1];
    if (![1, -1].includes(d)) throw new Error("missing every-candle entry");
    const entryHalf = a.o * PROTOCOL.full_spread_bps / 20000;
    const exitHalf = exitBar.o * PROTOCOL.full_spread_bps / 20000;
    const slip = b => firstPrice * PROTOCOL.slippage_bps_first_open_per_side / 10000
      + PROTOCOL.slippage_range_fraction * (b.h - b.l);
    const entry = a.o + d * (entryHalf + slip(a));
    const exit = exitBar.c - d * (exitHalf + slip(exitBar));
    if (entry <= 0 || exit <= 0) throw new Error("nonpositive fill");
    const g = q * d * (exitBar.c - a.o), s = q * (entryHalf + exitHalf);
    const l = q * (slip(a) + slip(exitBar)), f = q * (entry + exit) * feeBps / 10000;
    gross += g; spread += s; slippage += l; commission += f; traded += q * (entry + exit);
    // Reference notional-time per entry is q*H*entry-mid = one unit-second.
    notionalTime += q * holding * a.o;
    const bps = (g - s - l - f) / (q * holding * a.o) * 10000;
    tradeBps.push(bps);
    const block = Math.floor(i / 300);
    if (!blocks[block]) blocks[block] = { sum: 0, n: 0 };
    blocks[block].sum += bps; blocks[block].n++;
    for (let t = i; t < i + holding; t++) grossPath[t] += q;
  }
  if (!tradeBps.length) throw new Error("need enough complete S1 candles for every holding");
  const maxGross = Math.max(...grossPath);
  if (maxGross > PROTOCOL.max_gross_base_units + 1e-9) throw new Error("gross exposure cap exceeded");
  return {
    holding_bars: holding, units_per_entry: q, n_trades: tradeBps.length, max_gross_units: maxGross,
    gross_pnl: gross, net_pnl: gross - spread - slippage - commission, spread, slippage, commission,
    traded_notional: traded, gross_notional_seconds: notionalTime,
    net_bps_per_gross_unit_second: tradeBps.reduce((a, b) => a + b, 0) / tradeBps.length,
    cost_bps_per_gross_unit_second: (spread + slippage + commission) / notionalTime * 10000,
    tradeBps, blocks: blocks.filter(Boolean),
  };
}

function mean(x) { return x.reduce((a, b) => a + b, 0) / x.length; }
function evaluate(datasets) {
  const rows = [], detail = new Map();
  for (const [symbol, bars] of datasets) {
    const fc = forecasts(bars, "close_return");
    for (const h of HOLDINGS) for (const delay of PROTOCOL.extra_delay_bars)
      for (const fee of PROTOCOL.fees_bps_per_side) {
        const r = simulateHolding(bars, fc, h, fee, delay);
        detail.set(`${symbol}:${h}:${delay}:${fee}`, r);
        const { tradeBps, blocks, ...summary } = r;
        rows.push({ symbol, extra_delay_bars: delay, fee_bps_per_side: fee, ...summary });
      }
  }
  return { rows, detail };
}
function score(e, h, delay = 0) {
  return mean(e.rows.filter(r => r.holding_bars === h && r.extra_delay_bars === delay
    && r.fee_bps_per_side === 10).map(r => r.net_bps_per_gross_unit_second));
}
function select(train, validation) {
  const ranked = HOLDINGS.map(h => ({ holding_bars: h, train_net_bps: score(train, h) }))
    .sort((a, b) => b.train_net_bps - a.train_net_bps || a.holding_bars - b.holding_bars);
  const winner = ranked[0].holding_bars;
  const deltas = [0, 1].map(d => score(validation, winner, d) - score(validation, 1, d));
  return { train_ranking: ranked, train_winner: winner, validation_delta_bps: deltas,
           frozen_holding: deltas.every(x => x > 0) ? winner : 1 };
}
function interval(pairs) {
  let seed = 20261022;
  const rnd = () => ((seed = (Math.imul(1664525, seed) + 1013904223) >>> 0) / 4294967296);
  const deltas = pairs.map(([a, b]) => {
    if (a.n_trades !== b.n_trades || a.blocks.length !== b.blocks.length) throw new Error("unpaired paths");
    return a.blocks.map((block, i) => {
      if (block.n !== b.blocks[i].n) throw new Error("unpaired block");
      return { sum: block.sum - b.blocks[i].sum, n: block.n };
    });
  });
  const samples = [];
  for (let rep = 0; rep < 2000; rep++) samples.push(mean(deltas.map(blocks => {
    let sum = 0, n = 0;
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[Math.floor(rnd() * blocks.length)]; sum += b.sum; n += b.n;
    }
    return sum / n;
  })));
  samples.sort((a, b) => a - b);
  return [samples[50], samples[1949]];
}
async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}
async function load(phase, out, signalRun, nowMs) {
  const start = Date.parse(PROTOCOL.windows[phase][0]), end = Date.parse(PROTOCOL.windows[phase][1]);
  if (end > nowMs) throw new Error("unfinished holding window");
  const dataDir = path.join(out, "data"); fs.mkdirSync(dataDir, { recursive: true });
  const datasets = new Map(), provenance = [];
  for (const symbol of PROTOCOL.symbols) {
    // Reuse only train/validation, never prior observed test data.
    const source = path.join(signalRun, "data", `${phase}_${symbol}.json`);
    let rows;
    if (phase !== "test") rows = JSON.parse(fs.readFileSync(source, "utf8"));
    else {
      rows = [];
      for (let cursor = start; cursor < end;) {
        const stop = Math.min(end, cursor + 1000000);
        const page = await get(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}`
          + `&interval=1s&startTime=${cursor}&endTime=${stop - 1}&limit=1000`);
        validateRows(page, cursor, stop);
        rows.push(...page); cursor = stop;
      }
    }
    const bars = validateRows(rows, start, end), raw = JSON.stringify(rows);
    const file = path.join(dataDir, `${phase}_${symbol}.json`);
    fs.writeFileSync(file, raw, { flag: "wx" });
    datasets.set(symbol, bars);
    provenance.push({ phase, symbol, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      candles: bars.length, sha256: crypto.createHash("sha256").update(raw).digest("hex") });
  }
  return { datasets, provenance };
}
async function main(out, signalRun) {
  fs.mkdirSync(out, { recursive: true });
  // A fresh directory is mandatory; no rerunning an opened holdout.
  if (fs.readdirSync(out).length) throw new Error("holding output must be a fresh empty directory");
  fs.writeFileSync(path.join(out, "protocol.json"), JSON.stringify(PROTOCOL, null, 2), { flag: "wx" });
  const clock = await get("https://data-api.binance.vision/api/v3/time");
  const train = await load("train", out, signalRun, clock.serverTime), tr = evaluate(train.datasets);
  const validation = await load("validation", out, signalRun, clock.serverTime), va = evaluate(validation.datasets);
  const frozen = select(tr, va);
  fs.writeFileSync(path.join(out, "selection.json"),
    JSON.stringify({ ...frozen, frozen_at: new Date().toISOString() }, null, 2), { flag: "wx" });
  console.log("HOLDING FROZEN BEFORE TEST", JSON.stringify(frozen));
  const test = await load("test", out, signalRun, clock.serverTime), te = evaluate(test.datasets);
  const compare = [0, 1].map(delay => {
    const pairs = PROTOCOL.symbols.map(s => [te.detail.get(`${s}:${frozen.frozen_holding}:${delay}:10`),
                                            te.detail.get(`${s}:1:${delay}:10`)]);
    return { extra_delay_bars: delay, baseline_net_bps: score(te, 1, delay),
      candidate_net_bps: score(te, frozen.frozen_holding, delay),
      delta_bps: score(te, frozen.frozen_holding, delay) - score(te, 1, delay),
      paired_delta_block95: interval(pairs) };
  });
  const report = { protocol: PROTOCOL, selection: frozen, generated_at: new Date().toISOString(),
    provenance: [...train.provenance, ...validation.provenance, ...test.provenance],
    rows: { train: tr.rows, validation: va.rows, test: te.rows }, held_out_comparison: compare,
    loss_reduction_gate_passed: compare.every(r => r.delta_bps > 0 && r.paired_delta_block95[0] > 0),
    profitability_gate_passed: compare.every(r => r.candidate_net_bps > 0) };
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log("HOLDING HELD OUT", JSON.stringify(compare));
  console.log("NET POSITIVE", report.profitability_gate_passed);
}
module.exports = { PROTOCOL, HOLDINGS, simulateHolding, evaluate, score, select, interval };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--out" || args[2] !== "--signal-run") {
    console.error("Usage: node scripts\\one_second_holding.cjs --out <new-directory> --signal-run <edge-output>");
    process.exitCode = 2;
  } else main(path.resolve(args[1]), path.resolve(args[3])).catch(e => { console.error(e); process.exitCode = 1; });
}
