"""配對 bootstrap 統計（spec 4.3「統計」節、skill control-map-eval）。

## 為什麼一定要配對

同一個 shot 的難度差異遠大於條件差異。若各自算平均再相減，shot 難度的變異
會整包混進誤差項，CI 被撐寬到看不出效果。配對的作法是先在每個 shot 內算
`diff = C − A`，再對這串 diff 做 bootstrap —— shot 難度被消掉了。

**實作上的關鍵**：重抽樣時 a 與 b 必須用**同一組索引**。
`eval/tests/test_stats.py::test_constant_paired_difference_gives_degenerate_ci`
就是在守這一點：常數差值的 CI 必須塌成一個點。

## 重抽樣單位是 shot，不是圖

12 shots 就是 12 個樣本，CI 會偏寬。這是時間盒的代價，報告中要明講而不是隱藏
（spec 4.3 註）。多 seed 時先用 `median_per_shot` 在 shot 內收斂，
不要把 seed 當成獨立樣本灌大 n。

## CI 方法

用百分位數 bootstrap（percentile bootstrap）。
⚠ 待驗證：n=12 且分布偏斜時，BCa 會比百分位法準。這裡選百分位法是因為它
不需要 scipy、且行為直觀可解釋；若報告需要更嚴謹的區間，需另行評估 BCa。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

DEFAULT_N_RESAMPLES = 10_000
DEFAULT_CI = 95.0


@dataclass(frozen=True)
class BootstrapResult:
    """配對差值的點估計與信賴區間。欄位全部要能原樣寫進報告。"""

    mean_diff: float
    ci_low: float
    ci_high: float
    ci_level: float
    n_shots: int
    n_resamples: int
    seed: int

    @property
    def ci_excludes_zero(self) -> bool:
        """CI 是否完全落在 0 的同一側（H1 的其中一個門檻）。"""
        return (self.ci_low > 0.0) or (self.ci_high < 0.0)

    def meets_hypothesis(self, min_effect: float) -> bool:
        """H1 式判定：配對差值 ≥ min_effect **且** CI 不含 0。兩者缺一不可。"""
        return bool(self.mean_diff >= min_effect) and self.ci_excludes_zero

    def as_dict(self) -> dict:
        return {"mean_diff": self.mean_diff, "ci_low": self.ci_low,
                "ci_high": self.ci_high, "ci_level": self.ci_level,
                "n_shots": self.n_shots, "n_resamples": self.n_resamples,
                "seed": self.seed, "ci_excludes_zero": self.ci_excludes_zero}


def _as_1d(x, name: str) -> np.ndarray:
    a = np.asarray(x, dtype=np.float64).reshape(-1)
    if not np.all(np.isfinite(a)):
        raise ValueError(f"{name} 含 nan / inf。指標算不出來就要停下來查，"
                         "不要讓它悄悄污染 CI")
    return a


def paired_bootstrap(a, b, n: int = DEFAULT_N_RESAMPLES, seed: int = 0,
                     ci_level: float = DEFAULT_CI) -> BootstrapResult:
    """對 shot 做配對 bootstrap，回傳 `a − b` 的平均差值與 CI。

    參數
    ----
    a, b : 逐 shot 的指標值，長度相同且**順序對應同一個 shot**。
           回報 C−A 就傳 `paired_bootstrap(c, a)`；C−B 就傳 `(c, b)`。
    n : 重抽樣次數，spec 要求 10,000。
    seed : 固定亂數種子，讓報告數字可重現。
    ci_level : 信賴水準（百分比），預設 95。

    回傳的 `mean_diff` 是原始資料的平均差值（不是 bootstrap 分布的平均），
    所以與 seed 無關。
    """
    av = _as_1d(a, "a")
    bv = _as_1d(b, "b")
    if av.shape != bv.shape:
        raise ValueError(f"a 與 b 長度必須相同（配對）：{av.size} vs {bv.size}")
    if av.size == 0:
        raise ValueError("沒有樣本可以重抽")
    if n < 1:
        raise ValueError(f"n 必須 ≥ 1，得到 {n}")
    if not (0.0 < ci_level < 100.0):
        raise ValueError(f"ci_level 必須落在 (0, 100)，得到 {ci_level}")

    diff = av - bv                      # 先配對再統計，順序不能反
    n_shots = diff.size

    rng = np.random.default_rng(seed)
    idx = rng.integers(0, n_shots, size=(n, n_shots))
    # 同一組 idx 同時作用在 a 與 b 上 —— 這就是「配對」的具體含意。
    # （這裡直接抽 diff，等價於用同一組索引分別抽 a、b 再相減。）
    boot_means = diff[idx].mean(axis=1)

    alpha = (100.0 - ci_level) / 2.0
    lo, hi = np.percentile(boot_means, [alpha, 100.0 - alpha])
    return BootstrapResult(mean_diff=float(diff.mean()), ci_low=float(lo),
                           ci_high=float(hi), ci_level=ci_level,
                           n_shots=int(n_shots), n_resamples=int(n),
                           seed=int(seed))


def median_per_shot(values: np.ndarray) -> np.ndarray:
    """多 seed 收斂：(n_shots, n_seeds) → (n_shots,) 取中位數。

    spec 4.3：「若之後補跑多 seed，須先在 shot 內取中位數再進 bootstrap，
    避免用 seed 灌大樣本數。」重抽樣單位永遠是 shot。
    """
    m = np.asarray(values, dtype=np.float64)
    if m.ndim != 2:
        raise ValueError(f"需要 (n_shots, n_seeds) 的 2D 陣列，得到 ndim={m.ndim}")
    if m.shape[1] == 0:
        raise ValueError("每個 shot 至少要有一個 seed")
    return np.median(m, axis=1)
