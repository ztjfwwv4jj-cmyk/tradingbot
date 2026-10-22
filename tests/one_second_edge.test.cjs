"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PROTOCOL, SIGNALS, validateRows, forecasts, simulate, evaluate, select, pairedInterval }
  = require("../scripts/one_second_edge.cjs");

function fixture(n = 180) {
  return Array.from({ length: n }, (_, i) => {
    const o = 100 + Math.floor(i / 3) * 0.01, c = o + (i % 3 - 1) * 0.01;
    return { time: i * 1000, o, h: Math.max(o, c) + 0.02, l: Math.min(o, c) - 0.02, c,
             volume: 10, buy: i % 2 ? 8 : 2 };
  });
}

test("all fixed candidates are causal and preserve every-candle exposure", () => {
  const bars = fixture();
  for (const signal of SIGNALS) {
    const full = forecasts(bars, signal);
    assert(full.slice(0, 8).every(x => x === 0));
    assert(full.slice(8).every(x => x === 1 || x === -1));
    for (const end of [9, 35, 88, 150]) {
      assert.deepEqual(forecasts(bars.slice(0, end), signal), full.slice(0, end));
      const perturbed = bars.map((b, i) => i < end ? b : { ...b, o: b.o * 2, h: b.h * 2,
        l: b.l * 2, c: b.c * 2, buy: b.volume - b.buy });
      assert.deepEqual(forecasts(perturbed, signal).slice(0, end), full.slice(0, end));
    }
    for (const delay of [0, 1])
      assert.equal(simulate(bars, full, 10, delay).n_trades, bars.length - 9 - delay);
  }
});

test("entry lag, round-trip costs and exact net accounting are explicit", () => {
  const bars = Array.from({ length: 12 }, (_, i) => ({
    time: i * 1000, o: 100, h: 101, l: 99, c: i < 10 ? 101 : 99, volume: 10, buy: 5,
  }));
  const fc = Array(12).fill(1); fc[9] = -1; fc[10] = 1;
  const r = simulate(bars, fc, 10);
  // decisions 8,9,10 -> candles 9,10,11: +1,+1,-1 gross = +1.
  assert.equal(r.gross_pnl, 1);
  assert.equal(r.n_trades, 3);
  const half = 100 / 20000, slip = 100 * 0.1 / 10000 + 0.02 * 2;
  assert(Math.abs(r.spread - 6 * half) < 1e-12);
  assert(Math.abs(r.slippage - 6 * slip) < 1e-12);
  assert(Math.abs(r.commission - (201 + 199 + 199) * 0.001) < 1e-12);
  assert(Math.abs(r.net_pnl - (r.gross_pnl - r.spread - r.slippage - r.commission)) < 1e-12);
  assert.equal(simulate(bars, fc, 10, 1).gross_pnl, 0);
  assert.throws(() => simulate(bars.slice(0, 8), fc.slice(0, 8), 10), /common warmup/);
});

test("candidate features have hand-calculated directions, including ties and EWMA state", () => {
  const bars = Array.from({ length: 12 }, (_, i) => ({
    time: i * 1000, o: 100, h: 101, l: 99, c: 100, volume: 10, buy: 5,
  }));
  bars[8] = { ...bars[8], o: 100, h: 103, l: 99, c: 102, buy: 8 };
  bars[9] = { ...bars[9], o: 103, h: 104, l: 100, c: 101, buy: 2 };
  bars[10] = { ...bars[10], o: 100, h: 104, l: 99, c: 101, buy: 5 };
  bars[11] = { ...bars[11], o: 101, h: 102, l: 97, c: 98, buy: 2 };
  const expected = {
    close_return: [1, -1, -1, -1], body: [1, -1, 1, -1],
    close_location: [1, -1, -1, -1], momentum_4: [1, 1, 1, -1], momentum_8: [1, 1, 1, -1],
    ewma_return: [1, 1, 1, -1], taker_imbalance: [1, -1, -1, -1], candle_flow: [1, -1, 1, -1],
  };
  for (const signal of SIGNALS) assert.deepEqual(forecasts(bars, signal).slice(8), expected[signal]);
});

test("validation failure retains baseline without testing runner-up selection", () => {
  const datasets = new Map([["BTCUSDT", fixture()]]);
  const train = evaluate(datasets), validation = evaluate(datasets);
  // Force train winner body but an inferior validation score, without consulting any test.
  for (const row of train.rows) if (row.signal === "body") row.net_bps_per_trade = 100;
  for (const row of validation.rows) if (row.signal === "body") row.net_bps_per_trade = -100;
  const selected = select(train, validation);
  assert.equal(selected.train_winner, "body");
  assert.equal(selected.frozen_candidate, "close_return");
  assert(!Object.keys(selected).some(k => k.includes("test")));
  assert(Date.parse(PROTOCOL.windows.train[1]) < Date.parse(PROTOCOL.windows.validation[0]));
  assert(Date.parse(PROTOCOL.windows.validation[1]) < Date.parse(PROTOCOL.windows.test[0]));
});

test("paired block interval is deterministic and zero for identical paths", () => {
  const bars = fixture(), r = simulate(bars, forecasts(bars, "close_return"), 10);
  assert.deepEqual(pairedInterval([[r, r]]), [0, 0]);
  assert.deepEqual(pairedInterval([[r, r]]), pairedInterval([[r, r]]));
});

test("public candles reject missing seconds, invalid quotes and impossible taker volume", () => {
  const raw = i => [i * 1000, "100", "101", "99", "100", "10", i * 1000 + 999, "1", 2, "5", "1", "0"];
  assert.equal(validateRows([raw(0), raw(1)], 0, 2000).length, 2);
  assert.throws(() => validateRows([raw(0), raw(2)], 0, 3000), /missing/);
  assert.throws(() => validateRows([raw(0)], 0, 2000), /incomplete/);
  const bad = raw(0); bad[9] = "11";
  assert.throws(() => validateRows([bad], 0, 1000), /taker volume/);
  assert.throws(() => forecasts(fixture(), "unknown"), /unknown/);
});

test("holding cohorts keep identical entry counts and cap gross rather than just net exposure", () => {
  const { HOLDINGS, simulateHolding } = require("../scripts/one_second_holding.cjs");
  const bars = fixture(240), fc = forecasts(bars, "close_return");
  for (const h of HOLDINGS) {
    const r = simulateHolding(bars, fc, h, 10);
    assert.equal(r.n_trades, 240 - 8 - 60);
    assert(Math.abs(r.max_gross_units - 1) < 1e-9);
    assert.equal(r.units_per_entry, 1 / h);
    assert(Math.abs(r.net_pnl - (r.gross_pnl - r.spread - r.slippage - r.commission)) < 1e-9);
    assert.equal(simulateHolding(bars, fc, h, 10, 1).n_trades, r.n_trades - 1);
  }
});

test("flat-price overlapping cohorts charge both sides without netting and liquidate every trade", () => {
  const { HOLDINGS, simulateHolding, interval } = require("../scripts/one_second_holding.cjs");
  const bars = Array.from({ length: 240 }, (_, i) => ({
    time: i * 1000, o: 100, h: 100, l: 100, c: 100, volume: 10, buy: 5,
  }));
  const fc = bars.map((_, i) => i % 2 ? 1 : -1);
  for (const h of HOLDINGS) {
    const r = simulateHolding(bars, fc, h, 10);
    assert.equal(r.gross_pnl, 0);
    const cost = r.n_trades * (0.01 + 0.002 + 0.2) / h;
    assert(Math.abs(r.net_pnl + cost) < 1e-9);
    assert(Math.abs(r.net_bps_per_gross_unit_second + 21.2 / h) < 1e-9);
    assert.deepEqual(interval([[r, r]]), [0, 0]);
  }
});

test("holding selection requires validation improvement at both delays", () => {
  const { evaluate: evaluateHolding, select: selectHolding } = require("../scripts/one_second_holding.cjs");
  const data = new Map([["BTCUSDT", fixture(240)]]);
  const tr = evaluateHolding(data), va = evaluateHolding(data);
  for (const row of tr.rows) if (row.holding_bars === 60) row.net_bps_per_gross_unit_second = 100;
  for (const row of va.rows) if (row.holding_bars === 60)
    row.net_bps_per_gross_unit_second = row.extra_delay_bars ? -100 : 100;
  assert.equal(selectHolding(tr, va).frozen_holding, 1);
  for (const row of va.rows) if (row.holding_bars === 60) row.net_bps_per_gross_unit_second = 100;
  assert.equal(selectHolding(tr, va).frozen_holding, 60);
});
