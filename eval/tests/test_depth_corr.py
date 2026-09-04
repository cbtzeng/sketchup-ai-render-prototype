"""深度相關性測試。

fog 換算的測資直接取自 docs/journal/main/003-fog-標定結果.md 的實測表，
所以這組測試同時是「標定結論沒有被程式碼寫壞」的迴歸測試。
"""
import numpy as np
import pytest

from eval.metrics.depth_corr import (
    align_scale_shift,
    depth_correlation,
    fog_valid_mask,
    grey_to_metric_depth,
    metric_depth_to_disparity,
    metric_depth_to_grey,
    minmax_normalize,
    spearman,
)

# (FogEndDist(m), 真實距離 d(m), 實測灰階) —— journal 003 的 E 節。
# FogStartDist = 0 m：由 (60, 20, 170) 反解 255*(1-20/60)=170 得證。
FOG_CALIBRATION = [
    (60, 1, 251), (60, 2, 246), (60, 5, 234),
    (60, 10, 212), (60, 20, 170), (60, 50, 42),
    (30, 1, 246), (30, 2, 238), (30, 5, 212),
    (30, 10, 170), (30, 20, 85),
    # (30, 50, 0) 被 clamp 到 0，屬飽和點，另行測試
]


# --- fog 灰階 ↔ 公制深度 ----------------------------------------------------

def test_grey_to_metric_depth_matches_journal_calibration():
    """11 個實測點都必須還原到 ±0.5 灰階對應的距離誤差內。"""
    for end_m, d_true, grey in FOG_CALIBRATION:
        d = grey_to_metric_depth(np.array([grey], dtype=float), 0.0, end_m)[0]
        atol = 0.51 / 255.0 * end_m  # ±0.5 灰階的 8-bit 量化誤差
        assert d == pytest.approx(d_true, abs=atol), (end_m, d_true, grey, d)


def test_metric_depth_to_grey_matches_journal_model():
    """正向模型 grey = 255 × (1 − (d − start)/(end − start))。"""
    got = metric_depth_to_grey(np.array([1.0, 20.0, 50.0]), 0.0, 60.0)
    np.testing.assert_allclose(got, [250.75, 170.0, 42.5])


def test_grey_metric_round_trip():
    grey = np.arange(0, 256, 17, dtype=float)
    d = grey_to_metric_depth(grey, 2.0, 40.0)
    np.testing.assert_allclose(metric_depth_to_grey(d, 2.0, 40.0), grey, atol=1e-9)


def test_grey_to_metric_depth_endpoints():
    """grey=255 → start；grey=0 → end。"""
    d = grey_to_metric_depth(np.array([255.0, 0.0]), 3.0, 60.0)
    np.testing.assert_allclose(d, [3.0, 60.0])


def test_fog_valid_mask_excludes_saturated_pixels():
    """0 與 255 是 clamp 後的飽和值，距離資訊已遺失，必須排除。

    journal 表中的 (End=30, d=50) 就讀到 0 —— 真實距離是 50 m 而非 30 m。
    """
    grey = np.array([0.0, 1.0, 128.0, 254.0, 255.0])
    np.testing.assert_array_equal(
        fog_valid_mask(grey), [False, True, True, True, False])


def test_grey_to_metric_depth_rejects_bad_range():
    with pytest.raises(ValueError):
        grey_to_metric_depth(np.array([10.0]), 60.0, 60.0)
    with pytest.raises(ValueError):
        grey_to_metric_depth(np.array([10.0]), 70.0, 60.0)


# --- 視差域轉換 -------------------------------------------------------------

def test_metric_depth_to_disparity_is_reciprocal():
    np.testing.assert_allclose(
        metric_depth_to_disparity(np.array([1.0, 2.0, 4.0])), [1.0, 0.5, 0.25])


def test_metric_depth_to_disparity_is_monotone_decreasing():
    d = np.linspace(1.0, 50.0, 20)
    disp = metric_depth_to_disparity(d)
    assert np.all(np.diff(disp) < 0)


def test_metric_depth_to_disparity_rejects_non_positive():
    """d ≤ 0 沒有物理意義，寧可炸掉也不要偷偷 clamp。"""
    with pytest.raises(ValueError):
        metric_depth_to_disparity(np.array([1.0, 0.0]))
    with pytest.raises(ValueError):
        metric_depth_to_disparity(np.array([-1.0]))


def test_minmax_normalize_maps_to_unit_range():
    out = minmax_normalize(np.array([2.0, 4.0, 6.0]))
    np.testing.assert_allclose(out, [0.0, 0.5, 1.0])


def test_minmax_normalize_constant_input_is_zeros():
    np.testing.assert_allclose(minmax_normalize(np.full(5, 3.0)), np.zeros(5))


# --- scale-shift 對齊 -------------------------------------------------------

def test_align_scale_shift_recovers_known_affine():
    """gt = 3 × pred + 7 → 應解出 scale=3、shift=7。"""
    pred = np.linspace(0.0, 1.0, 50)
    gt = 3.0 * pred + 7.0
    scale, shift = align_scale_shift(pred, gt)
    assert scale == pytest.approx(3.0)
    assert shift == pytest.approx(7.0)


def test_align_scale_shift_handles_negative_scale():
    """pred 若是視差、gt 是 z（方向相反），最小平方會解出負 scale。

    這裡不自動翻正負號 —— 負 scale 是「domain 沒對齊」的訊號，要被看見。
    """
    pred = np.linspace(0.0, 1.0, 20)
    gt = -2.0 * pred + 1.0
    scale, shift = align_scale_shift(pred, gt)
    assert scale == pytest.approx(-2.0)


def test_align_scale_shift_constant_prediction_degrades_gracefully():
    """常數預測沒有斜率可解，約定回傳 scale=0、shift=mean(gt)。"""
    scale, shift = align_scale_shift(np.full(10, 5.0), np.arange(10.0))
    assert scale == 0.0
    assert shift == pytest.approx(4.5)


def test_align_scale_shift_shape_mismatch_raises():
    with pytest.raises(ValueError):
        align_scale_shift(np.zeros(5), np.zeros(6))


# --- Spearman ---------------------------------------------------------------

def test_spearman_perfect_monotone_is_one():
    """單調但非線性（exp）→ ρ 必須恰好 1.0。"""
    x = np.linspace(0.1, 3.0, 40)
    assert spearman(x, np.exp(x)) == pytest.approx(1.0)


def test_spearman_perfect_anti_monotone_is_minus_one():
    x = np.linspace(1.0, 5.0, 30)
    assert spearman(x, -x ** 3) == pytest.approx(-1.0)


def test_spearman_known_value():
    """手算：n=4、Σd²=2 → ρ = 1 − 6×2/(4×15) = 0.8。"""
    assert spearman(np.array([1., 2., 3., 4.]),
                    np.array([1., 3., 2., 4.])) == pytest.approx(0.8)


def test_spearman_uses_average_ranks_for_ties():
    """並列值用平均排名；同結構的資料 ρ 應為 1.0。"""
    a = np.array([1., 2., 2., 3.])
    b = np.array([10., 20., 20., 30.])
    assert spearman(a, b) == pytest.approx(1.0)


def test_spearman_constant_input_is_nan():
    """零變異沒有定義，回 nan 而不是 0（0 會被誤讀成「無相關」）。"""
    assert np.isnan(spearman(np.full(6, 1.0), np.arange(6.0)))


# --- 整合 -------------------------------------------------------------------

def test_depth_correlation_on_exact_affine_relation():
    """pred = gt/3 − 2 → 對齊後 RMSE=0、ρ=1、scale=3、shift=6。"""
    gt = np.linspace(1.0, 40.0, 100).reshape(10, 10)
    pred = gt / 3.0 - 2.0

    r = depth_correlation(pred, gt)
    assert r.scale == pytest.approx(3.0)
    assert r.shift == pytest.approx(6.0)
    assert r.spearman_rho == pytest.approx(1.0)
    assert r.rmse_aligned == pytest.approx(0.0, abs=1e-9)
    assert r.n_valid == 100


def test_depth_correlation_respects_mask():
    """飽和像素要能被 mask 掉，且不影響對齊解。"""
    gt = np.linspace(1.0, 20.0, 20)
    pred = 2.0 * gt + 1.0
    gt = gt.copy()
    gt[:3] = 999.0  # 汙染值
    mask = np.ones(20, dtype=bool)
    mask[:3] = False

    r = depth_correlation(pred, gt, mask=mask)
    assert r.n_valid == 17
    assert r.scale == pytest.approx(0.5)
    assert r.rmse_aligned == pytest.approx(0.0, abs=1e-9)


def test_depth_correlation_rmse_has_hand_computed_value():
    """對齊後 RMSE 的單位是 GT 的單位（公尺），數值可手算。

    gt = [1..6]，pred = gt 加上交錯 ±1 的擾動 → pred = [2,1,4,3,6,5]。
    最小平方解 scale = 14.5/17.5 = 0.828571、shift = 0.6，
    殘差平方和 = 5.48571 → RMSE = sqrt(5.48571/6) = 0.956183。
    """
    gt = np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
    pred = np.array([2.0, 1.0, 4.0, 3.0, 6.0, 5.0])

    r = depth_correlation(pred, gt)
    assert r.scale == pytest.approx(14.5 / 17.5)
    assert r.shift == pytest.approx(0.6)
    assert r.rmse_aligned == pytest.approx(0.956183, abs=1e-5)


def test_depth_correlation_shape_mismatch_raises():
    with pytest.raises(ValueError):
        depth_correlation(np.zeros((4, 4)), np.zeros((4, 5)))


def test_depth_correlation_needs_enough_valid_pixels():
    mask = np.zeros(10, dtype=bool)
    mask[0] = True
    with pytest.raises(ValueError):
        depth_correlation(np.arange(10.0), np.arange(10.0), mask=mask)
