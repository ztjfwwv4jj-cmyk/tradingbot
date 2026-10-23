"""S1 signal timing, public-data validation, round-trip costs and paper-only safety."""

from __future__ import annotations

from unittest.mock import MagicMock

import numpy as np
import pandas as pd
import pytest
import requests

from aurum.backtest.engine import run_backtest
from aurum.cli import main
from aurum.core.config import ConfigError, load_config
from aurum.core.instrument import Instrument
from aurum.core.timeframes import get_timeframe
from aurum.core.types import MarketData
from aurum.data.binance import load_binance_klines
from aurum.data.resample import resample_bars
from aurum.data.schema import make_bars
from aurum.execution.costs import CostModel, FinancingModel
from aurum.strategies.base import get_strategy


def bars_from_close(values, *, timeframe="S1"):
    close = np.asarray(values, dtype=float)
    opens = np.r_[close[0], close[:-1]]
    idx = pd.date_range("2026-10-20", periods=len(close), freq=get_timeframe(timeframe).freq, tz="UTC")
    return make_bars(pd.DataFrame({"open": opens, "high": np.maximum(opens, close),
                                   "low": np.minimum(opens, close), "close": close,
                                   "spread": 0.02}, index=idx), timeframe)


class UnitSizer:
    def target_lots(self, forecast, vol_ann, equity, price, instrument, **kwargs):
        return instrument.round_lots(forecast)


def run_bars(bars, **kwargs):
    forecast = get_strategy("one_second").generate(MarketData(bars))
    return run_backtest(bars, forecast, sizer=UnitSizer(),
                        instrument=Instrument(contract_size=1), vol=0.2, **kwargs)


def test_forecast_has_exactly_one_execution_lag():
    bars = bars_from_close([100, 101, 100, 100, 102, 101])
    f = get_strategy("one_second").generate(MarketData(bars))
    assert f.tolist() == [0, 1, -1, 0, 1, -1]
    res = run_bars(bars, costs=CostModel.zero(), exit_at_close=True)
    assert res.positions.tolist() == [0, 0, 1, -1, 0, 1]
    assert res.position_close.eq(0).all()
    assert res.trades["bars_held"].eq(1).all()


@pytest.mark.parametrize("mode", ["momentum", "reversion"])
@pytest.mark.parametrize("flat", [True, False])
def test_signal_is_causal_and_zero_policy_explicit(mode, flat):
    bars = bars_from_close([100, 100, 101, 101, 100, 102])
    strategy = get_strategy("one_second", mode=mode, flat_on_zero=flat)
    expected = [0, 0, 1, 0, -1, 1] if flat else [0, 1, 1, 1, -1, 1]
    direction = 1 if mode == "momentum" else -1
    f = strategy.generate(MarketData(bars))
    assert f.tolist() == [x * direction for x in expected]
    for cut in range(1, len(bars)):
        prefix = strategy.generate(MarketData(bars.iloc[:cut].copy()))
        pd.testing.assert_series_equal(f.iloc[:cut], prefix)


def test_timeframe_and_gaps_are_not_silently_reinterpreted():
    from aurum.live.paper import ReplayFeed

    bars = bars_from_close([100, 101, 102, 103])
    assert get_timeframe("S1").delta == pd.Timedelta(seconds=1)
    no_attrs = bars.copy()
    no_attrs.attrs.clear()
    assert ReplayFeed(no_attrs).timeframe == "S1"
    with pytest.raises(ValueError, match="contiguous"):
        get_strategy("one_second").generate(MarketData(bars.drop(bars.index[2])))
    minute = bars_from_close([100, 101, 102], timeframe="M1")
    with pytest.raises(ValueError, match="requires S1"):
        get_strategy("one_second").generate(MarketData(minute))
    with pytest.raises(ValueError, match="finer"):
        resample_bars(minute, "S1")
    minute = resample_bars(bars_from_close(np.arange(120) + 100), "M1")
    assert len(minute) == 2
    assert (minute["available_at"] - minute.index).eq(pd.Timedelta(minutes=1)).all()


@pytest.mark.parametrize("params", [{"mode": "predict"}, {"flat_on_zero": 1}])
def test_invalid_strategy_params(params):
    with pytest.raises(ValueError):
        get_strategy("one_second", **params)


def test_every_candle_reenters_and_charges_both_sides():
    bars = bars_from_close([100, 101, 102, 103, 104, 105])
    cm = CostModel(min_spread=0, slippage_fixed=0.01, slippage_range_frac=0,
                   commission_per_lot=0.03, commission_bps=10, financing=FinancingModel.none())
    res = run_bars(bars, costs=cm, exit_at_close=True)
    assert len(res.trades) == 4
    assert len(res.fills) == 8
    assert res.trades["exit_reason"].eq("bar_close").all()
    closes = res.fills[res.fills["kind"] == "bar_close"]
    assert closes["time"].tolist() == list(bars["available_at"].iloc[2:])
    assert res.trades["exit_time"].tolist() == closes["time"].tolist()
    assert res.costs["spread"].sum() == pytest.approx(8 * 0.01)
    assert res.costs["slippage"].sum() == pytest.approx(8 * 0.01)
    notional = (res.fills["lots"] * res.fills["price"]).sum()
    assert res.costs["commission"].sum() == pytest.approx(8 * 0.03 + notional * 0.001)
    m = res.metrics
    assert m["gross_pnl"] == pytest.approx(4)
    assert m["net_pnl"] == pytest.approx(4 - m["total_costs"])
    assert m["break_even_cost_bps_per_side"] == pytest.approx(4 / notional * 10_000)
    assert m["break_even_round_trip_bps"] == pytest.approx(8 / notional * 10_000)
    assert abs(res.reconcile()["residual"]) < 1e-8
    np.testing.assert_allclose(res.equity.diff().iloc[1:], res.pnl["net"].iloc[1:], atol=1e-8)
    held = run_bars(bars, costs=cm)
    assert len(held.fills) == 1  # unchanged default semantics


def test_zero_trades_and_negative_budget():
    flat = run_bars(bars_from_close([100] * 5), costs=CostModel.zero(), exit_at_close=True)
    assert flat.metrics["gross_pnl"] == 0
    assert np.isnan(flat.metrics["break_even_cost_bps_per_side"])
    losing = run_bars(bars_from_close([100, 101, 100, 101, 100]), costs=CostModel.zero(), exit_at_close=True)
    assert losing.metrics["break_even_cost_bps_per_side"] < 0


def test_stop_exit_does_not_pay_a_second_close():
    bars = bars_from_close([100, 101, 100, 99])
    res = run_bars(bars, costs=CostModel.zero(), exit_at_close=True, stop_atr_mult=0.1)
    assert res.trades.iloc[0]["exit_reason"] == "stop"
    assert (res.fills["bar"].value_counts() <= 2).all()
    assert res.position_close.eq(0).all()


def test_fee_validation():
    with pytest.raises(ValueError, match="commission_bps"):
        CostModel(commission_bps=-1)
    with pytest.raises(ValueError, match="execution price"):
        CostModel(commission_bps=1).commission(1)
    assert CostModel.zero().commission(1) == 0


def kline(ms, price=100):
    return [ms, str(price), str(price + 1), str(price - 1), str(price), "2",
            ms + 999, "200", 2, "1", "100", "0"]


def mock_pages(monkeypatch, pages):
    session = MagicMock()
    session.__enter__.return_value = session
    responses = []
    for page in pages:
        response = MagicMock()
        response.json.return_value = page
        responses.append(response)
    session.get.side_effect = responses
    monkeypatch.setattr("aurum.data.binance.requests.Session", lambda: session)
    return session, responses


def test_loader_pagination_and_public_schema(monkeypatch):
    start = pd.Timestamp("2026-10-20T00:00:00Z")
    ms = start.value // 1_000_000
    page = [kline(ms + i * 1000) for i in range(1000)]
    session, _ = mock_pages(monkeypatch, [page, [kline(ms + 1_000_000)]])
    bars = load_binance_klines("btcusdt", start, start + pd.Timedelta(seconds=1001))
    assert len(bars) == 1001
    assert bars.attrs["timeframe"] == "S1"
    assert bars.attrs["price_basis"] == "trade_price_mid_proxy"
    assert bars["spread"].eq(0.01).all()
    assert (bars["available_at"] - bars.index).eq(pd.Timedelta(seconds=1)).all()
    assert session.get.call_args_list[1].kwargs["params"]["startTime"] == ms + 1_000_000
    assert session.get.call_args_list[0].kwargs["params"]["interval"] == "1s"


@pytest.mark.parametrize("page", [[], {"code": -1}, [[1]], [kline(0), kline(0)], [kline(500)]])
def test_bad_or_empty_loader_response_raises(monkeypatch, page):
    mock_pages(monkeypatch, [page])
    with pytest.raises(ValueError):
        load_binance_klines("BTCUSDT", "1970-01-01", "1970-01-01T00:00:02Z")


def test_http_failure_and_gaps_are_visible(monkeypatch, caplog):
    _, responses = mock_pages(monkeypatch, [[kline(0)]])
    responses[0].raise_for_status.side_effect = requests.HTTPError("429")
    with pytest.raises(requests.HTTPError, match="429"):
        load_binance_klines("BTCUSDT", "1970-01-01", "1970-01-01T00:00:01Z")
    mock_pages(monkeypatch, [[kline(0), kline(2000)]])
    bars = load_binance_klines("BTCUSDT", "1970-01-01", "1970-01-01T00:00:03Z")
    assert len(bars) == 2 and "coverage incomplete" in caplog.text


@pytest.mark.parametrize("start,end", [("2026-10-20T00:00:00.5Z", "2026-10-21"),
                                      ("2026-10-21", "2026-10-20")])
def test_loader_rejects_bad_bounds(start, end):
    with pytest.raises(ValueError):
        load_binance_klines("BTCUSDT", start, end)


def test_one_second_config_is_offline_only(capsys):
    cfg = load_config("configs/one_second.yaml", env={})
    assert cfg.backtest.exit_at_close
    assert cfg.data.timeframe == "S1"
    assert cfg.live.broker == "paper" and cfg.live.dry_run and not cfg.live.allow_live_real
    with pytest.raises(ConfigError, match="offline research only"):
        load_config("configs/one_second.yaml", overrides=["live.allow_live_real=true"], env={})
    assert main(["live", "run", "--config", "configs/one_second.yaml"]) == 2
    assert "offline research only" in capsys.readouterr().err


def test_cli_download_and_backtest_persist_cost_outputs(monkeypatch, tmp_path, capsys):
    from aurum.data.store import load_bars
    from aurum.research.walkforward import run_single_backtest

    bars = bars_from_close(100 + np.arange(80) * 0.0001)
    monkeypatch.setattr("aurum.data.binance.load_binance_klines", lambda *a, **kw: bars)
    output = tmp_path / "bars.parquet"
    assert main(["data", "binance", "--start", "2026-10-20", "--end", "2026-10-21",
                 "--out", str(output)]) == 0
    pd.testing.assert_frame_equal(load_bars(output), bars)
    cfg = load_config("configs/one_second.yaml", env={})
    cfg.walkforward.executor = "serial"
    cfg.walkforward.min_train_bars = 10
    cfg.output.tearsheet = False
    report = run_single_backtest(MarketData(bars), cfg, out_dir=tmp_path / "run")
    summary = report.summary()
    assert "gross_pnl" in report.stats.columns
    assert "break_even_round_trip_bps" in report.stats.columns
    assert (tmp_path / "run" / "summary.json").exists()
    assert summary["stats"]
    assert "completed" in capsys.readouterr().out
