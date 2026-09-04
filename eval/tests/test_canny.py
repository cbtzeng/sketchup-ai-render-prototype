"""Canny 偵測器測試。

素材刻意做成對稱步階，讓梯度峰值的位置有封閉解，
避免「兩欄同分、看實作偏好」造成的脆弱測試。
"""
import numpy as np
import pytest

from eval.metrics.canny import CannyParams, canny


def _symmetric_step(h=40, w=61, boundary=30):
    """左黑右白、正中央那一欄是 128 的步階。

    灰階剖面對 boundary 這一欄嚴格對稱（f(b-k) + f(b+k) = 255），
    所以任何對稱平滑核＋中央差分梯度的極大值都落在 boundary，唯一。
    """
    img = np.zeros((h, w), dtype=np.float64)
    img[:, boundary] = 128.0
    img[:, boundary + 1:] = 255.0
    return img, boundary


def test_canny_finds_single_pixel_ridge_at_the_boundary():
    img, boundary = _symmetric_step()
    edges = canny(img, CannyParams(sigma=1.0, low=0.2, high=0.4))

    interior = edges[5:-5]  # 避開上下邊界的 padding 效應
    per_row = interior.sum(axis=1)
    assert (per_row == 1).all(), f"每列應恰好一個邊素，實得 {np.unique(per_row)}"
    cols = np.argmax(interior, axis=1)
    assert (cols == boundary).all(), f"邊應落在第 {boundary} 欄，實得 {np.unique(cols)}"


def test_canny_on_flat_image_returns_nothing():
    flat = np.full((20, 20), 173.0)
    assert not canny(flat, CannyParams()).any()


def test_absolute_threshold_is_in_grey_levels_per_pixel():
    """absolute 模式的門檻是「每像素灰階變化量」，低對比邊會被濾掉。"""
    low_contrast = np.zeros((30, 41), dtype=np.float64)
    low_contrast[:, 20] = 2.0
    low_contrast[:, 21:] = 4.0  # 僅 4 灰階的對比

    high_contrast, _ = _symmetric_step(h=30, w=41, boundary=20)

    absolute = CannyParams(sigma=1.0, low=10.0, high=25.0,
                           threshold_mode="absolute")
    assert not canny(low_contrast, absolute).any()
    assert canny(high_contrast, absolute).any()


def test_relative_threshold_normalises_per_image():
    """relative 模式對每張圖的最大梯度正規化，所以低對比邊仍抓得到。

    ODS 掃門檻掃的就是這個相對門檻（等同 BSDS 對正規化後邊機率圖掃門檻）。
    """
    low_contrast = np.zeros((30, 41), dtype=np.float64)
    low_contrast[:, 20] = 2.0
    low_contrast[:, 21:] = 4.0

    relative = CannyParams(sigma=1.0, low=0.2, high=0.4,
                           threshold_mode="relative")
    assert canny(low_contrast, relative).any()


def test_canny_hysteresis_keeps_weak_pixels_connected_to_strong():
    """遲滯：弱邊只有在與強邊連通時才保留。"""
    from eval.metrics.canny import hysteresis

    strong = np.zeros((5, 5), dtype=bool)
    weak = np.zeros((5, 5), dtype=bool)
    strong[0, 0] = True
    weak[1, 1] = True   # 與 strong 8-連通 → 保留
    weak[4, 4] = True   # 孤立 → 丟棄

    kept = hysteresis(strong, weak)
    assert kept[0, 0] and kept[1, 1]
    assert not kept[4, 4]


def test_canny_params_are_recorded():
    """參數必須可設且能被記錄進報告（可重現性硬要求）。"""
    p = CannyParams(sigma=1.4, low=0.15, high=0.35, threshold_mode="relative")
    d = p.as_dict()
    assert d == {"sigma": 1.4, "low": 0.15, "high": 0.35,
                 "threshold_mode": "relative"}


def test_canny_rejects_low_above_high():
    with pytest.raises(ValueError):
        CannyParams(low=0.5, high=0.2).validate()


def test_canny_rejects_bad_threshold_mode():
    with pytest.raises(ValueError):
        canny(np.zeros((5, 5)), CannyParams(threshold_mode="magic"))
