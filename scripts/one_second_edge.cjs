// Independent offline arithmetic research. No account, broker, order or credential API.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SIGNALS = Object.freeze([
  "close_return", "body", "close_location", "momentum_4", "momentum_8",
  "ewma_return", "taker_imbalance", "candle_flow",
]);
const PROTOCOL = Object.freeze({
  version: 1,
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  windows: {
    train: ["2026-10-15T10:00:00Z", "2026-10-15T16:00:00Z"],
    validation: ["2026-10-21T10:00:00Z", "2026-10-21T16:00:00Z"],
    test: ["2026-10-22T10:00:00Z", "2026-10-22T16:00:00Z"],
  },
  candidates: SIGNALS,
  common_warmup: 8,
  flat_on_zero: false,
  base_units: 1,
  full_spread_bps: 1,
  slippage_bps_of_first_open_per_side: 0.1,
  slippage_range_fraction: 0.02,
  fee_bps_per_side: [0, 1, 10],
  extra_delay_bars: [0, 1],
  selection: "Rank eight fixed candidates by equally weighted symbol mean net bps/trade "
    + "on TRAIN at 10bps/side, no extra delay. Validate the single train winner against "
    + "close_return at both delays; if either delta <= 0, retain baseline. Freeze before "
    + "TEST download. Never select on test; report every candidate for transparency. "
    + "Promote only if paired test delta is positive at both delays with 95% block CI lower > 0.",
  cost_basis: "Each common eligible second: one base unit at next open, exit same candle close. "
    + "Two market fills even for unchanged direction; no netting, maker fills, leverage changes, "
    + "selective entry, funding or borrow costs. Fees on executed entry+exit notionals. "
    + "PnL/trade in bps uses that trade's mid open notional. One extra second is a delay stress, "
    + "not calibrated subsecond latency. Trade-price OHLC are not executable bid/ask quotes.",
  uncertainty: "Paired 60-second blocks, 2000 seeded replicates, equal symbol weighting; "
    + "descriptive intervals, not multiple-comparison-adjusted or proof of durable profitability.",
});

function validateRows(rows, start, end) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("empty or malformed klines");
  let expected = start;
  for (const r of rows) {
    if (!Array.isArray(r) || r.length !== 12 || +r[0] !== expected || +r[6] !== expected + 999)
      throw new Error(`missing, duplicate or incomplete S1 candle at ${expected}`);
    const [o, h, l, c, v] = r.slice(1, 6).map(Number), buy = +r[9];
    if (![o, h, l, c, v, buy].every(Number.isFinite)
      || Math.min(o, h, l, c) <= 0 || h < Math.max(o, c, l) || l > Math.min(o, c, h)
      || v < 0 || buy < 0 || buy > v + 1e-9 * Math.max(1, v))
      throw new Error(`invalid OHLC or taker volume at ${expected}`);
    expected += 1000;
  }
  if (expected !== end) throw new Error(`incomplete requested window: ${expected} != ${end}`);
  return rows.map(r => ({ time: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4],
                         volume: +r[5], buy: +r[9] }));
}

function forecasts(bars, signal) {
  if (!SIGNALS.includes(signal)) throw new Error(`unknown signal ${signal}`);
  let last = 1, ewma = 0;
  return bars.map((b, i) => {
    const change = i ? Math.log(b.c / bars[i - 1].c) : 0;
    ewma = i ? 0.5 * change + 0.5 * ewma : 0;
    const close = Math.sign(change), body = Math.sign(b.c - b.o);
    const flow = Math.sign(2 * b.buy - b.volume);
    let raw;
    switch (signal) {
      case "close_return": raw = change; break;
      case "body": raw = b.c - b.o; break;
      case "close_location": raw = 2 * b.c - b.h - b.l; break;
      case "momentum_4": raw = i >= 4 ? b.c - bars[i - 4].c : 0; break;
      case "momentum_8": raw = i >= 8 ? b.c - bars[i - 8].c : 0; break;
      case "ewma_return": raw = ewma; break;
      case "taker_imbalance": raw = flow; break;
      case "candle_flow": raw = close + body + flow; break;
    }
    const direction = Math.sign(raw);
    if (direction) last = direction;
    return i < PROTOCOL.common_warmup ? 0 : last;
  });
}

function simulate(bars, fc, feeBps, delay = 0) {
  if (!Number.isFinite(feeBps) || feeBps < 0 || ![0, 1].includes(delay) || fc.length !== bars.length)
    throw new Error("invalid simulation inputs");
  const pnlBps = [], blocks = [];
  let gross = 0, spread = 0, slippage = 0, commission = 0, traded = 0;
  for (let i = PROTOCOL.common_warmup + 1 + delay; i < bars.length; i++) {
    const direction = fc[i - 1 - delay], b = bars[i];
    if (direction !== 1 && direction !== -1) throw new Error("every-candle exposure violated");
    const half = b.o * PROTOCOL.full_spread_bps / 20000;
    const slip = bars[0].o * PROTOCOL.slippage_bps_of_first_open_per_side / 10000
      + PROTOCOL.slippage_range_fraction * (b.h - b.l);
    const entry = b.o + direction * (half + slip), exit = b.c - direction * (half + slip);
    if (entry <= 0 || exit <= 0) throw new Error("costs imply nonpositive fill");
    const pricePnl = direction * (b.c - b.o), fees = (entry + exit) * feeBps / 10000;
    const net = pricePnl - 2 * half - 2 * slip - fees;
    const bps = net / b.o * 10000;
    pnlBps.push(bps);
    const k = Math.floor(i / 60);
    if (!blocks[k]) blocks[k] = { sum: 0, n: 0 };
    blocks[k].sum += bps; blocks[k].n++;
    gross += pricePnl; spread += 2 * half; slippage += 2 * slip; commission += fees;
    traded += entry + exit;
  }
  if (!pnlBps.length) throw new Error("need completed candles after the common warmup and delay");
  const net = gross - spread - slippage - commission;
  return {
    n_trades: pnlBps.length, gross_pnl: gross, net_pnl: net, spread, slippage, commission,
    traded_notional: traded, break_even_round_trip_bps: 20000 * gross / traded,
    actual_round_trip_cost_bps: 20000 * (spread + slippage + commission) / traded,
    net_bps_per_trade: pnlBps.reduce((s, x) => s + x, 0) / pnlBps.length,
    pnlBps, blocks: blocks.filter(Boolean),
  };
}

function mean(values) { return values.reduce((s, x) => s + x, 0) / values.length; }
function pairedInterval(pairs) {
  let seed = 20261022;
  const rnd = () => ((seed = (Math.imul(1664525, seed) + 1013904223) >>> 0) / 4294967296);
  const differences = pairs.map(([candidate, baseline]) => {
    if (candidate.pnlBps.length !== baseline.pnlBps.length) throw new Error("unpaired trade paths");
    if (candidate.blocks.length !== baseline.blocks.length) throw new Error("unpaired blocks");
    return candidate.blocks.map((b, i) => {
      if (b.n !== baseline.blocks[i].n) throw new Error("unpaired block sizes");
      return { sum: b.sum - baseline.blocks[i].sum, n: b.n };
    });
  });
  const samples = [];
  for (let rep = 0; rep < 2000; rep++) {
    samples.push(mean(differences.map(blocks => {
      let sum = 0, n = 0;
      for (let k = 0; k < blocks.length; k++) {
        const b = blocks[Math.floor(rnd() * blocks.length)];
        sum += b.sum; n += b.n;
      }
      return sum / n;
    })));
  }
  samples.sort((a, b) => a - b);
  return [samples[50], samples[1949]];
}

function evaluate(datasets) {
  const rows = [];
  const detail = new Map();
  for (const [symbol, bars] of datasets) {
    for (const signal of SIGNALS) {
      const fc = forecasts(bars, signal);
      for (const delay of PROTOCOL.extra_delay_bars) {
        for (const fee of PROTOCOL.fee_bps_per_side) {
          const result = simulate(bars, fc, fee, delay);
          detail.set(`${symbol}:${signal}:${delay}:${fee}`, result);
          const { pnlBps, blocks, ...summary } = result;
          rows.push({ symbol, signal, extra_delay_bars: delay, fee_bps_per_side: fee, ...summary });
        }
      }
    }
  }
  return { rows, detail };
}

function score(evaluation, signal, delay = 0) {
  return mean(evaluation.rows.filter(r => r.signal === signal && r.extra_delay_bars === delay
    && r.fee_bps_per_side === 10).map(r => r.net_bps_per_trade));
}

function select(train, validation) {
  const ranked = SIGNALS.map(signal => ({ signal, train_net_bps: score(train, signal) }))
    .sort((a, b) => b.train_net_bps - a.train_net_bps || SIGNALS.indexOf(a.signal) - SIGNALS.indexOf(b.signal));
  const winner = ranked[0].signal;
  const deltas = [0, 1].map(delay => score(validation, winner, delay) - score(validation, "close_return", delay));
  return { train_ranking: ranked, train_winner: winner, validation_deltas_bps: deltas,
           frozen_candidate: deltas.every(d => d > 0) ? winner : "close_return",
           reason: deltas.every(d => d > 0) ? "train winner improved validation at both delays"
             : "validation gate failed; keep baseline without trying the runner-up" };
}

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`public data HTTP ${response.status}: ${url}`);
  return response.json();
}

async function downloadPhase(phase, out, nowMs) {
  const [a, b] = PROTOCOL.windows[phase], start = Date.parse(a), end = Date.parse(b);
  if (end > Math.floor(nowMs / 1000) * 1000) throw new Error("requested in-progress window");
  const datasets = new Map(), provenance = [];
  const cache = path.join(out, "data");
  fs.mkdirSync(cache, { recursive: true });
  for (const symbol of PROTOCOL.symbols) {
    const file = path.join(cache, `${phase}_${symbol}.json`);
    let rows;
    if (fs.existsSync(file)) rows = JSON.parse(fs.readFileSync(file, "utf8"));
    else {
      rows = [];
      for (let cursor = start; cursor < end;) {
        const stop = Math.min(end, cursor + 1000000);
        const page = await get(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}`
          + `&interval=1s&startTime=${cursor}&endTime=${stop - 1}&limit=1000`);
        validateRows(page, cursor, stop);
        rows.push(...page); cursor = stop;
      }
      fs.writeFileSync(file, JSON.stringify(rows), { flag: "wx" });
    }
    const bars = validateRows(rows, start, end);
    const raw = fs.readFileSync(file);
    provenance.push({ phase, symbol, start: a, end: b, candles: bars.length,
                      sha256: crypto.createHash("sha256").update(raw).digest("hex") });
    datasets.set(symbol, bars);
    console.log(`loaded ${phase} ${symbol}: ${bars.length} completed S1 candles`);
  }
  return { datasets, provenance };
}

async function main(out) {
  fs.mkdirSync(out, { recursive: true });
  const protocolFile = path.join(out, "protocol.json"), encoded = JSON.stringify(PROTOCOL, null, 2);
  if (fs.existsSync(protocolFile) && fs.readFileSync(protocolFile, "utf8") !== encoded)
    throw new Error("protocol changed; do not reuse data as an untouched test");
  if (fs.existsSync(path.join(out, "report.json")) || fs.existsSync(path.join(out, "selection.json"))
    || PROTOCOL.symbols.some(s => fs.existsSync(path.join(out, "data", `test_${s}.json`))))
    throw new Error("selection/test already opened; no retuning or silent holdout reuse");
  fs.writeFileSync(protocolFile, encoded);
  const clock = await get("https://data-api.binance.vision/api/v3/time");
  const trainData = await downloadPhase("train", out, clock.serverTime);
  const train = evaluate(trainData.datasets);
  const validationData = await downloadPhase("validation", out, clock.serverTime);
  const validation = evaluate(validationData.datasets);
  const frozen = select(train, validation);
  fs.writeFileSync(path.join(out, "selection.json"), JSON.stringify({
    ...frozen, frozen_at: new Date().toISOString(),
    protocol_sha256: crypto.createHash("sha256").update(encoded).digest("hex"),
  }, null, 2), { flag: "wx" });
  console.log("FROZEN BEFORE TEST", JSON.stringify(frozen));
  const testData = await downloadPhase("test", out, clock.serverTime);
  const test = evaluate(testData.datasets);
  const comparison = [0, 1].map(delay => {
    const pairs = PROTOCOL.symbols.map(symbol => [
      test.detail.get(`${symbol}:${frozen.frozen_candidate}:${delay}:10`),
      test.detail.get(`${symbol}:close_return:${delay}:10`),
    ]);
    return { extra_delay_bars: delay, baseline_net_bps: score(test, "close_return", delay),
             candidate_net_bps: score(test, frozen.frozen_candidate, delay),
             delta_bps: score(test, frozen.frozen_candidate, delay) - score(test, "close_return", delay),
             paired_delta_block95: pairedInterval(pairs) };
  });
  const report = {
    generated_at: new Date().toISOString(), protocol: PROTOCOL, selection: frozen,
    provenance: [...trainData.provenance, ...validationData.provenance, ...testData.provenance],
    rows: { train: train.rows, validation: validation.rows, test: test.rows },
    held_out_comparison: comparison,
    promotion_gate_passed: frozen.frozen_candidate !== "close_return"
      && comparison.every(r => r.delta_bps > 0 && r.paired_delta_block95[0] > 0),
    caveat: "Independent Node arithmetic, not a run of Aurum's Python engine. All candidates "
      + "remain visible; do not choose a different candidate from test results.",
  };
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log("HELD OUT", JSON.stringify(comparison));
  console.log("PROMOTION GATE", report.promotion_gate_passed);
}

module.exports = { PROTOCOL, SIGNALS, validateRows, forecasts, simulate, pairedInterval, evaluate, score, select };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: node scripts\\one_second_edge.cjs --out <new-artifact-directory>");
    process.exitCode = 2;
  } else main(path.resolve(args[1])).catch(error => { console.error(error); process.exitCode = 1; });
}
