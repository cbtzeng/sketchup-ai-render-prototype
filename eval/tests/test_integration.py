"""端到端測試：模擬 GT-depth 的實際流程。

    fog depth PNG → io.read_grayscale → fog_valid_mask
                  → grey_to_metric_depth → depth_correlation

這條路徑是 journal 003「精確、線性、公制、可逆」這個主張的程式碼體現，
所以這裡把 8-bit 量化誤差一起納入驗證。
"""
import numpy as np
import pytest

from eval.metrics import io as eio
from eval.metrics.depth_corr import (
    depth_correlation,
    fog_valid_mask,
    grey_to_metric_depth,
    metric_depth_to_disparity,
    metric_depth_to_grey,
    minmax_normalize,
)
from png_fixtures import write_png_gray

FOG_START_M = 0.0
FOG_END_M = 60.0


def _fog_png(tmp_path, true_depth_m):
    """把已知的公制深度場編碼成 8-bit fog PNG（含量化）。"""
    grey = metric_depth_to_grey(true_depth_m, FOG_START_M, FOG_END_M)
    grey_u8 = np.clip(np.round(grey), 0, 255).astype(np.uint8)
    p = tmp_path / "fog.png"
    write_png_gray(p, grey_u8)
    return p


def test_fog_png_round_trips_to_metric_depth_within_quantisation_error(tmp_path):
    """整條路徑跑完，誤差必須只剩 8-bit 量化那一點（≤ 0.5 灰階）。"""
    true_depth = np.linspace(5.0, 50.0, 64 * 64).reshape(64, 64)
    p = _fog_png(tmp_path, true_depth)

    grey = eio.read_grayscale(p)
    mask = fog_valid_mask(grey)
    assert mask.all(), "5–50 m 全都在 0–60 m 的 fog 範圍內，不該有飽和像素"

    recovered = grey_to_metric_depth(grey, FOG_START_M, FOG_END_M)
    # ±0.5 灰階換算成距離：0.5/255 × 60 m ≈ 0.1176 m。
    # 加 1e-12 是因為恰好落在 .5 的像素會撞到浮點邊界（實測差 3e-15）。
    max_err = 0.5 / 255.0 * (FOG_END_M - FOG_START_M) + 1e-12
    assert np.abs(recovered - true_depth).max() <= max_err

    r = depth_correlation(recovered, true_depth)
    # 量化會讓相鄰深度落進同一個灰階（產生並列），所以 ρ 極接近但不完全等於 1。
    assert r.spearman_rho == pytest.approx(1.0, abs=1e-3)
    assert r.scale == pytest.approx(1.0, abs=1e-3)
    assert r.rmse_aligned < max_err


def test_background_is_masked_out(tmp_path):
    """背景（無幾何處）是純黑霧色，會被 clamp 成 0，必須排除。"""
    true_depth = np.full((16, 16), 20.0)
    grey = metric_depth_to_grey(true_depth, FOG_START_M, FOG_END_M)
    grey_u8 = np.clip(np.round(grey), 0, 255).astype(np.uint8)
    grey_u8[:4] = 0        # 天空 / 背景
    p = tmp_path / "bg.png"
    write_png_gray(p, grey_u8)

    mask = fog_valid_mask(eio.read_grayscale(p))
    assert mask.sum() == 16 * 12
    assert not mask[:4].any()


def test_disparity_domain_flips_the_sign_of_correlation_with_linear_z(tmp_path):
    """視差與線性 z 是反向的 —— 這正是 journal 003「未解」那一點的具體後果。

    把 GT 轉成視差後再與 MiDaS 類預測比較，才會得到正的 scale。
    """
    true_depth = np.linspace(2.0, 40.0, 400)
    p = _fog_png(tmp_path, true_depth.reshape(20, 20))
    z = grey_to_metric_depth(eio.read_grayscale(p), FOG_START_M, FOG_END_M)

    # 模擬 MiDaS：輸出正規化過的視差（近處值大），帶未知 scale/shift
    fake_midas = 3.7 * minmax_normalize(1.0 / true_depth.reshape(20, 20)) + 1.2

    wrong = depth_correlation(fake_midas, z)
    assert wrong.scale < 0
    assert wrong.domain_mismatch is True, "domain 沒對齊時必須舉紅旗"

    right = depth_correlation(fake_midas, metric_depth_to_disparity(z))
    assert right.scale > 0
    assert right.domain_mismatch is False
    # 8-bit 量化在 z 上造成並列，ρ 到不了整數 1.0（實測 0.99998）。
    assert right.spearman_rho == pytest.approx(1.0, abs=1e-3)
    assert right.spearman_rho > abs(wrong.spearman_rho) - 1e-9
