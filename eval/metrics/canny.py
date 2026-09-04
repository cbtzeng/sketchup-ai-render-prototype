"""Canny 邊緣偵測（純 numpy 實作）。

環境沒有 opencv / scipy，這裡自己實作。步驟是教科書標準流程：
Gaussian 平滑 → Sobel 梯度 → 非極大值抑制 → 雙門檻遲滯。

**參數必須可設且會被記錄**（spec 4.3 的可重現性要求）：
`CannyParams.as_dict()` 的輸出要原樣寫進 `eval/config.json` 與 `eval/report.md`。

⚠ 待驗證：本實作與 OpenCV `cv2.Canny` 不保證逐像素相同
（OpenCV 用 L1 梯度近似、且 NMS 有插值變體）。因為 A/B/C 三個條件都跑同一支
偵測器，組間比較不受影響；但若日後要與外部論文的絕對 F-score 數值比較，
需先做一次對照。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

_THRESHOLD_MODES = ("relative", "absolute")


@dataclass(frozen=True)
class CannyParams:
    """Canny 參數。所有欄位都會被 `as_dict()` 帶進報告。

    sigma : Gaussian 平滑的標準差（像素）。
    low, high : 雙門檻。
        threshold_mode="relative" 時是「該張圖最大梯度」的比例，值域 (0, 1]。
        threshold_mode="absolute" 時是梯度大小的絕對值，單位為每像素灰階變化量。
    """

    sigma: float = 1.0
    low: float = 0.1
    high: float = 0.2
    threshold_mode: str = "relative"

    def validate(self) -> "CannyParams":
        if self.sigma <= 0:
            raise ValueError(f"sigma 必須為正，得到 {self.sigma}")
        if self.threshold_mode not in _THRESHOLD_MODES:
            raise ValueError(
                f"threshold_mode 必須是 {_THRESHOLD_MODES} 之一，得到 {self.threshold_mode!r}")
        if self.low > self.high:
            raise ValueError(f"low({self.low}) 不可大於 high({self.high})")
        if self.low < 0:
            raise ValueError(f"low 不可為負，得到 {self.low}")
        return self

    def as_dict(self) -> dict:
        return {"sigma": self.sigma, "low": self.low, "high": self.high,
                "threshold_mode": self.threshold_mode}


def gaussian_kernel_1d(sigma: float) -> np.ndarray:
    """回傳長度為 2*ceil(3σ)+1 的正規化 1D 高斯核。"""
    radius = int(np.ceil(3.0 * sigma))
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    k = np.exp(-(x ** 2) / (2.0 * sigma ** 2))
    return k / k.sum()


def _pad_replicate(img: np.ndarray, ry: int, rx: int) -> np.ndarray:
    return np.pad(img, ((ry, ry), (rx, rx)), mode="edge")


def _convolve_separable(img: np.ndarray, kx: np.ndarray, ky: np.ndarray) -> np.ndarray:
    """可分離捲積，邊界採複製（replicate）。"""
    rx, ry = len(kx) // 2, len(ky) // 2
    padded = _pad_replicate(img, ry, rx)

    tmp = np.zeros_like(padded)
    for i, w in enumerate(kx):
        tmp += w * np.roll(padded, rx - i, axis=1)
    tmp = tmp[:, rx:padded.shape[1] - rx] if rx else tmp

    out = np.zeros_like(tmp)
    for i, w in enumerate(ky):
        out += w * np.roll(tmp, ry - i, axis=0)
    return out[ry:tmp.shape[0] - ry] if ry else out


def gaussian_blur(img: np.ndarray, sigma: float) -> np.ndarray:
    k = gaussian_kernel_1d(sigma)
    return _convolve_separable(img, k, k)


def sobel_gradients(img: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """回傳 (gx, gy)，已除以 8 使單位為「每像素灰階變化量」。"""
    smooth = np.array([1.0, 2.0, 1.0])
    diff = np.array([-1.0, 0.0, 1.0])
    gx = _convolve_separable(img, diff, smooth) / 8.0
    gy = _convolve_separable(img, smooth, diff) / 8.0
    return gx, gy


def non_max_suppression(mag: np.ndarray, gx: np.ndarray, gy: np.ndarray) -> np.ndarray:
    """沿梯度方向做非極大值抑制，方向量化為 0/45/90/135 度。

    比較採嚴格大於：兩側同分時兩者皆抑制（避免產生 2 px 寬的脊）。
    """
    angle = np.rad2deg(np.arctan2(gy, gx)) % 180.0
    padded = _pad_replicate(mag, 1, 1)
    centre = padded[1:-1, 1:-1]

    # (dy, dx) 為梯度方向的兩個鄰居偏移
    sectors = [
        (((angle < 22.5) | (angle >= 157.5)), (0, 1)),    # 水平梯度 → 左右
        (((angle >= 22.5) & (angle < 67.5)), (-1, 1)),    # 45°
        (((angle >= 67.5) & (angle < 112.5)), (1, 0)),    # 垂直梯度 → 上下
        (((angle >= 112.5) & (angle < 157.5)), (1, 1)),   # 135°
    ]

    keep = np.zeros(mag.shape, dtype=bool)
    for sector, (dy, dx) in sectors:
        a = padded[1 + dy:padded.shape[0] - 1 + dy,
                   1 + dx:padded.shape[1] - 1 + dx]
        b = padded[1 - dy:padded.shape[0] - 1 - dy,
                   1 - dx:padded.shape[1] - 1 - dx]
        keep |= sector & (centre > a) & (centre > b)
    return keep


def _dilate8(mask: np.ndarray) -> np.ndarray:
    """8-連通的二值膨脹。"""
    p = np.pad(mask, 1, mode="constant", constant_values=False)
    out = np.zeros_like(mask)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            out |= p[1 + dy:p.shape[0] - 1 + dy, 1 + dx:p.shape[1] - 1 + dx]
    return out


def hysteresis(strong: np.ndarray, weak: np.ndarray) -> np.ndarray:
    """遲滯連接：保留所有強邊，以及與強邊 8-連通的弱邊。"""
    candidates = strong | weak
    kept = strong.copy()
    while True:
        grown = (_dilate8(kept) & candidates) | strong
        if np.array_equal(grown, kept):
            return kept
        kept = grown


def canny(gray: np.ndarray, params: CannyParams | None = None) -> np.ndarray:
    """對灰階影像（值域 [0, 255]）跑 Canny，回傳 (H, W) bool 邊圖。"""
    p = (params or CannyParams()).validate()
    img = np.asarray(gray, dtype=np.float64)
    if img.ndim != 2:
        raise ValueError(f"需要 2D 灰階影像，得到 shape={img.shape}")

    smoothed = gaussian_blur(img, p.sigma)
    gx, gy = sobel_gradients(smoothed)
    mag = np.hypot(gx, gy)

    thin = non_max_suppression(mag, gx, gy)
    thin_mag = np.where(thin, mag, 0.0)

    if p.threshold_mode == "relative":
        peak = float(mag.max())
        if peak <= 0.0:
            return np.zeros(img.shape, dtype=bool)
        low, high = p.low * peak, p.high * peak
    else:
        low, high = p.low, p.high

    strong = thin_mag >= high
    weak = (thin_mag >= low) & ~strong
    return hysteresis(strong, weak)


@dataclass(frozen=True)
class CannyRun:
    """一次 Canny 執行的結果 + 當時的參數，方便直接序列化進報告。"""

    edges: np.ndarray = field(repr=False)
    params: CannyParams = field(default_factory=CannyParams)

    def as_dict(self) -> dict:
        return {**self.params.as_dict(), "n_edge_pixels": int(self.edges.sum())}


def run_canny(gray: np.ndarray, params: CannyParams | None = None) -> CannyRun:
    p = params or CannyParams()
    return CannyRun(edges=canny(gray, p), params=p)
