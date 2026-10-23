"""Public Binance spot S1 klines; trade prices are a mid-price proxy, not executable quotes."""

from __future__ import annotations

import math
import re

import pandas as pd
import requests

from aurum.data.schema import make_bars

KLINES_URL = "https://data-api.binance.vision/api/v3/klines"


def _utc(value: str | pd.Timestamp) -> pd.Timestamp:
    t = pd.Timestamp(value)
    if pd.isna(t):
        raise ValueError("Binance time bounds must not be NaT")
    t = t.tz_localize("UTC") if t.tz is None else t.tz_convert("UTC")
    if t != t.floor("s"):
        raise ValueError("Binance time bounds must be aligned to whole seconds")
    return t


def load_binance_klines(
    symbol: str,
    start: str | pd.Timestamp,
    end: str | pd.Timestamp,
    *,
    spread_bps: float = 1.0,
    timeout: float = 30.0,
) -> pd.DataFrame:
    """Download completed 1s spot candles over UTC ``[start, end)`` without API keys.

    Paginate at 1,000 bars/request. The in-progress candle is excluded using a fixed
    download-time watermark. HTTP errors (including rate limits) propagate; no synthetic
    bars, retries or missing-price substitutions. Gaps are retained and warned about.
    ``spread_bps`` is an assumed FULL spread applied to the bar's open, not a measured
    quote. Do not treat spot candles as a gold feed or as proof that shorts can be borrowed.
    """
    import logging

    symbol = symbol.upper()
    if not re.fullmatch(r"[A-Z0-9]{2,30}", symbol):
        raise ValueError("Binance symbol must contain 2-30 alphanumeric characters")
    if not math.isfinite(spread_bps) or spread_bps < 0:
        raise ValueError("spread_bps must be finite and >= 0")
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("timeout must be finite and > 0")
    first, requested_end = _utc(start), _utc(end)
    if first >= requested_end:
        raise ValueError("Binance start must precede end")
    stop = min(requested_end, pd.Timestamp.now(tz="UTC").floor("s"))
    cursor = first.value // 1_000_000
    stop_ms = stop.value // 1_000_000
    rows: list[list] = []
    with requests.Session() as session:
        while cursor < stop_ms:
            response = session.get(
                KLINES_URL,
                params={"symbol": symbol, "interval": "1s", "startTime": cursor,
                        "endTime": stop_ms - 1, "limit": 1000},
                timeout=timeout,
            )
            response.raise_for_status()
            page = response.json()
            if not isinstance(page, list):
                raise ValueError(f"unexpected Binance klines response: {page!r}")
            if not page:
                break
            if any(not isinstance(row, list) or len(row) != 12 for row in page):
                raise ValueError("malformed Binance kline (expected 12 fields)")
            times = [int(row[0]) for row in page]
            if times[0] < cursor or any(b <= a for a, b in zip(times, times[1:], strict=False)):
                raise ValueError("Binance klines are duplicate, unordered or did not advance")
            if any(t % 1000 or t >= stop_ms for t in times):
                raise ValueError("Binance kline open time outside the requested S1 window")
            if any(int(row[6]) != int(row[0]) + 999 for row in page):
                raise ValueError("Binance kline is not a complete 1s interval")
            rows.extend(page)
            cursor = times[-1] + 1000
    if not rows:
        raise ValueError(f"no completed Binance S1 klines for {symbol} in [{first}, {stop})")
    idx = pd.to_datetime([r[0] for r in rows], unit="ms", utc=True)
    frame = pd.DataFrame([r[1:6] for r in rows], index=idx,
                         columns=["open", "high", "low", "close", "volume"], dtype=float)
    if not frame.notna().all().all() or not all(
        math.isfinite(v) for v in frame.to_numpy().ravel()
    ):
        raise ValueError("Binance returned non-finite prices or volume")
    frame["spread"] = frame["open"] * spread_bps / 10_000
    bars = make_bars(frame, "S1")
    bars.attrs.update({"source": "binance:spot:klines", "symbol": symbol,
                       "price_basis": "trade_price_mid_proxy", "assumed_spread_bps": spread_bps})
    expected = int((stop - first).total_seconds())
    if len(bars) != expected:
        logging.getLogger(__name__).warning(
            "Binance S1 coverage incomplete: requested %d seconds, received %d bars; gaps not filled",
            expected, len(bars),
        )
    return bars
