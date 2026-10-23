"""One-second momentum/reversion hypothesis, not evidence of a tradeable edge."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from aurum.core.types import MarketData
from aurum.data.schema import validate_bars
from aurum.strategies.base import Strategy, register_strategy


@register_strategy
class OneSecondMomentum(Strategy):
    name = "one_second"
    description = "S1 previous-return sign; momentum or reversion, research/paper only"

    def __init__(self, **params: Any) -> None:
        super().__init__(**params)
        if self.params["mode"] not in ("momentum", "reversion"):
            raise ValueError("one_second mode must be momentum or reversion")
        if not isinstance(self.params["flat_on_zero"], bool):
            raise ValueError("one_second flat_on_zero must be a bool")

    @classmethod
    def default_params(cls) -> dict[str, Any]:
        return {"mode": "momentum", "flat_on_zero": True}

    @property
    def warmup_bars(self) -> int:
        return 1

    def generate(self, md: MarketData, features: pd.DataFrame | None = None) -> pd.Series:
        bars = md.bars
        validate_bars(bars)
        second = pd.Timedelta(seconds=1)
        if ((pd.DatetimeIndex(bars["available_at"]) - bars.index) != second).any():
            raise ValueError("one_second requires S1 bars, not upsampled minute candles")
        if len(bars) > 1 and ((bars.index[1:] - bars.index[:-1]) != second).any():
            raise ValueError("one_second requires contiguous S1 data; split at data gaps")
        # forecast[t] uses the just-completed return; execution already lags it to t+1.
        signal = np.sign(bars["close"].astype(float).diff())
        if not self.params["flat_on_zero"]:
            # Carry the last nonzero direction; use long until the first nonzero return.
            signal = signal.replace(0.0, np.nan).ffill().fillna(1.0)
        if self.params["mode"] == "reversion":
            signal = -signal
        return self._finalize(signal, bars.index)
