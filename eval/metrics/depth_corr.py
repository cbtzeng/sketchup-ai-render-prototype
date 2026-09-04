"""深度相關性指標，以及 fog 灰階 ↔ 公制深度 ↔ 視差的換算。

## 兩個座標系，不要搞混

| 來源 | 語意 | 值越大代表 |
|---|---|---|
| SketchUp fog depth pass | 線性公制距離 z（公尺） | **越近**（近處霧少 → 灰階高）|
| `grey_to_metric_depth` 的輸出 | 線性公制距離 z（公尺） | 越遠 |
| MiDaS 類單目估計 | scale/shift invariant 的**視差**（≈1/z） | 越近 |

所以「fog GT」與「MiDaS 預測」**不同域**。直接算相關性會得到負的 ρ。
正確做法是先把 GT 用 `metric_depth_to_disparity` 轉到視差域再比。
本模組**不自動翻正負號** —— 負的 scale 是 domain 沒對齊的訊號，必須被看見，
偷偷取絕對值會把 bug 藏起來。

## 標定來源

`grey = 255 × (1 − (d − start)/(end − start))`，clamp 到 [0, 255]。
實測 12 點誤差 ≤ ±0.5 灰階（即 8-bit 量化誤差本身），見
`docs/journal/main/003-fog-標定結果.md`。start / end 的單位在本模組一律是**公尺**；
SketchUp API 讀寫的是英吋，換算請在呼叫端處理（journal 003 D 節）。

## ControlNet 餵法（未解，實驗變因）

journal 003「未解」一節：ControlNet depth adapter 多以 MiDaS 類視差 + per-image
正規化訓練。哪一種正規化最好是**實驗問題**，列為受測變因 C1（線性 z 正規化）
vs C2（轉視差後正規化）。本模組只提供轉換工具，不替評估做選擇。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

GREY_MAX = 255.0
MIN_VALID_PIXELS = 2  # 解 scale/shift 至少需要 2 個點


# --- fog 灰階 ↔ 公制深度 ----------------------------------------------------

def _check_fog_range(start_m: float, end_m: float) -> None:
    if not np.isfinite(start_m) or not np.isfinite(end_m):
        raise ValueError(f"start/end 必須是有限值，得到 {start_m}, {end_m}")
    if end_m <= start_m:
        raise ValueError(f"需要 end_m > start_m，得到 start={start_m}, end={end_m}")


def grey_to_metric_depth(grey: np.ndarray, start_m: float,
                         end_m: float) -> np.ndarray:
    """fog 灰階 → 線性公制距離（公尺）。

    反解 `grey = 255 × (1 − (d − start)/(end − start))`：
        d = start + (1 − grey/255) × (end − start)

    ⚠ grey 為 0 或 255 的像素是 clamp 後的**飽和值**，距離資訊已遺失
    （0 只代表「≥ end」而非恰好等於 end）。請先用 `fog_valid_mask` 濾掉。
    """
    _check_fog_range(start_m, end_m)
    g = np.asarray(grey, dtype=np.float64)
    return start_m + (1.0 - g / GREY_MAX) * (end_m - start_m)


def metric_depth_to_grey(depth_m: np.ndarray, start_m: float,
                         end_m: float) -> np.ndarray:
    """線性公制距離 → fog 灰階（正向模型，未 clamp，方便檢查超界）。"""
    _check_fog_range(start_m, end_m)
    d = np.asarray(depth_m, dtype=np.float64)
    return GREY_MAX * (1.0 - (d - start_m) / (end_m - start_m))


def fog_valid_mask(grey: np.ndarray) -> np.ndarray:
    """回傳未飽和（0 < grey < 255）的像素遮罩。

    journal 003 的 (End=30 m, d=50 m) 那一點就讀到 0：真實距離是 50 m，
    但灰階只能告訴你「≥ 30 m」。這種像素進入相關性計算會製造假的誤差。
    另外背景（無幾何處）也是純黑，同樣會被這個遮罩擋掉。
    """
    g = np.asarray(grey, dtype=np.float64)
    return (g > 0.0) & (g < GREY_MAX)


# --- 視差域 -----------------------------------------------------------------

def metric_depth_to_disparity(depth_m: np.ndarray) -> np.ndarray:
    """公制距離 → 視差（1/z）。

    ControlNet 的 depth adapter 期待的是視差域而非線性 z（journal 003 未解一節）。
    d ≤ 0 沒有物理意義，直接報錯而不是偷偷 clamp。
    """
    d = np.asarray(depth_m, dtype=np.float64)
    if np.any(d <= 0.0):
        raise ValueError("深度必須為正，才能轉成視差（1/z）")
    return 1.0 / d


def minmax_normalize(x: np.ndarray) -> np.ndarray:
    """min-max 正規化到 [0, 1]。常數輸入約定回傳全 0（無法定義相對關係）。"""
    a = np.asarray(x, dtype=np.float64)
    lo, hi = float(a.min()), float(a.max())
    if hi == lo:
        return np.zeros_like(a)
    return (a - lo) / (hi - lo)


# --- scale-shift 對齊 -------------------------------------------------------

def align_scale_shift(pred: np.ndarray, gt: np.ndarray) -> tuple[float, float]:
    """最小平方解 `min_{s,t} ‖ s·pred + t − gt ‖²`，回傳 (scale, shift)。

    單目深度是 scale/shift invariant，不先對齊就比 RMSE 沒有意義。
    常數 pred 沒有斜率可解，約定回傳 (0.0, mean(gt))。
    """
    p = np.asarray(pred, dtype=np.float64).reshape(-1)
    g = np.asarray(gt, dtype=np.float64).reshape(-1)
    if p.shape != g.shape:
        raise ValueError(f"形狀不符：pred={p.shape}, gt={g.shape}")
    if p.size == 0:
        raise ValueError("空陣列無法對齊")

    pm, gm = p.mean(), g.mean()
    var = float(((p - pm) ** 2).sum())
    if var == 0.0:
        return 0.0, float(gm)
    scale = float(((p - pm) * (g - gm)).sum() / var)
    return scale, float(gm - scale * pm)


# --- Spearman ---------------------------------------------------------------

def rankdata(x: np.ndarray) -> np.ndarray:
    """平均排名（等同 scipy.stats.rankdata 的 method='average'）。

    自行實作是因為環境沒有 scipy，而 Spearman 只需要 rank + Pearson。
    """
    a = np.asarray(x, dtype=np.float64).reshape(-1)
    order = np.argsort(a, kind="mergesort")   # 穩定排序，讓並列處理可重現
    ranks = np.empty(a.size, dtype=np.float64)
    ranks[order] = np.arange(1, a.size + 1, dtype=np.float64)

    sorted_a = a[order]
    i = 0
    while i < a.size:
        j = i
        while j + 1 < a.size and sorted_a[j + 1] == sorted_a[i]:
            j += 1
        if j > i:
            ranks[order[i:j + 1]] = (i + j + 2) / 2.0   # 1-based 平均排名
        i = j + 1
    return ranks


def pearson(x: np.ndarray, y: np.ndarray) -> float:
    a = np.asarray(x, dtype=np.float64).reshape(-1)
    b = np.asarray(y, dtype=np.float64).reshape(-1)
    if a.shape != b.shape:
        raise ValueError(f"形狀不符：{a.shape} vs {b.shape}")
    if a.size < 2:
        raise ValueError("至少需要 2 個點")
    da, db = a - a.mean(), b - b.mean()
    denom = np.sqrt(float((da ** 2).sum()) * float((db ** 2).sum()))
    if denom == 0.0:
        return float("nan")   # 零變異：無定義，回 nan 而非 0
    return float((da * db).sum() / denom)


def spearman(x: np.ndarray, y: np.ndarray) -> float:
    """Spearman 秩相關 ρ。零變異回 nan。"""
    a = np.asarray(x, dtype=np.float64).reshape(-1)
    b = np.asarray(y, dtype=np.float64).reshape(-1)
    if a.shape != b.shape:
        raise ValueError(f"形狀不符：{a.shape} vs {b.shape}")
    return pearson(rankdata(a), rankdata(b))


# --- 整合 -------------------------------------------------------------------

@dataclass(frozen=True)
class DepthCorrelation:
    """單一 shot 的深度比對結果。

    spearman_rho : 排序一致性。對正 scale 的仿射變換不變，所以對齊前後相同。
    rmse_aligned : scale-shift 對齊後的 RMSE，單位＝GT 的單位。
    scale, shift : 對齊參數。**scale 為負代表 pred 與 gt 不同域**（例如把視差
                   直接拿去比線性 z），這是設定錯誤而不是「表現差」，要當成
                   紅旗處理。
    """

    spearman_rho: float
    rmse_aligned: float
    scale: float
    shift: float
    n_valid: int

    @property
    def domain_mismatch(self) -> bool:
        return self.scale < 0.0

    def as_dict(self) -> dict:
        return {"spearman_rho": self.spearman_rho,
                "rmse_aligned": self.rmse_aligned,
                "scale": self.scale, "shift": self.shift,
                "n_valid": self.n_valid,
                "domain_mismatch": self.domain_mismatch}


def depth_correlation(pred: np.ndarray, gt: np.ndarray,
                      mask: np.ndarray | None = None) -> DepthCorrelation:
    """比對預測深度與 GT 深度（spec 4.3 指標 2）。

    步驟：套用遮罩 → 最小平方 scale-shift 對齊 → Spearman ρ 與對齊後 RMSE。

    mask : 要納入計算的像素（例如 `fog_valid_mask(grey)`）。None 表示全部納入。
    """
    p = np.asarray(pred, dtype=np.float64)
    g = np.asarray(gt, dtype=np.float64)
    if p.shape != g.shape:
        raise ValueError(f"形狀不符：pred={p.shape}, gt={g.shape}")

    if mask is not None:
        m = np.asarray(mask, dtype=bool)
        if m.shape != p.shape:
            raise ValueError(f"mask 形狀不符：{m.shape} vs {p.shape}")
        pv, gv = p[m], g[m]
    else:
        pv, gv = p.reshape(-1), g.reshape(-1)

    if pv.size < MIN_VALID_PIXELS:
        raise ValueError(
            f"有效像素只有 {pv.size} 個，至少需要 {MIN_VALID_PIXELS} 個才能對齊")
    if not (np.all(np.isfinite(pv)) and np.all(np.isfinite(gv))):
        raise ValueError("深度圖含 nan / inf，先處理掉再進指標")

    scale, shift = align_scale_shift(pv, gv)
    residual = (scale * pv + shift) - gv
    rmse = float(np.sqrt(np.mean(residual ** 2)))
    return DepthCorrelation(spearman_rho=spearman(pv, gv), rmse_aligned=rmse,
                            scale=scale, shift=shift, n_valid=int(pv.size))
