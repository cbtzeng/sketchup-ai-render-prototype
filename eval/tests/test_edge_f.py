"""Edge F-score（BSDS 式 2 px 容差邊界配對）測試。

每個案例的 precision / recall / F1 都是手算得出的封閉解。
"""
import numpy as np
import pytest

from eval.metrics.canny import CannyParams
from eval.metrics.edge_f import (
    MatchCounts,
    match_edges,
    maximum_matching,
    ods,
    ods_sweep,
)


def _line(h=40, w=40, col=10):
    m = np.zeros((h, w), dtype=bool)
    m[:, col] = True
    return m


# --- 基本配對 ---------------------------------------------------------------

def test_identical_edge_maps_score_one():
    """同一張邊圖對自己，F1 必須恰好是 1.0。"""
    gt = _line()
    c = match_edges(gt, gt, tolerance=2)
    assert c.precision == 1.0
    assert c.recall == 1.0
    assert c.f1 == 1.0


def test_shift_within_tolerance_still_matches():
    """位移 2 px，在 2 px 容差下應全部配上。"""
    gt = _line(col=10)
    pred = _line(col=12)
    c = match_edges(pred, gt, tolerance=2)
    assert c.f1 == 1.0


def test_shift_beyond_tolerance_scores_zero():
    """位移 3 px 超出容差，一個都不該配上。"""
    c = match_edges(_line(col=13), _line(col=10), tolerance=2)
    assert c.matched_pred == 0
    assert c.f1 == 0.0


def test_tolerance_zero_requires_exact_overlap():
    assert match_edges(_line(col=11), _line(col=10), tolerance=0).f1 == 0.0
    assert match_edges(_line(col=10), _line(col=10), tolerance=0).f1 == 1.0


def test_tolerance_is_euclidean_not_chebyshev():
    """對角 (2, 2) 的距離是 2.83 > 2，不該算配上。"""
    gt = np.zeros((9, 9), dtype=bool)
    gt[4, 4] = True
    pred = np.zeros((9, 9), dtype=bool)
    pred[6, 6] = True
    assert match_edges(pred, gt, tolerance=2).matched_pred == 0


# --- 一對一約束 -------------------------------------------------------------

def test_matching_is_one_to_one():
    """兩個 pred 落在同一個 gt 附近，只能配上一個。

    n_pred=2, n_gt=1, matched=1 → P=0.5, R=1.0, F1=2/3。
    """
    gt = np.zeros((11, 11), dtype=bool)
    gt[5, 5] = True
    pred = np.zeros((11, 11), dtype=bool)
    pred[5, 4] = True
    pred[5, 6] = True

    c = match_edges(pred, gt, tolerance=2)
    assert (c.matched_pred, c.matched_gt, c.n_pred, c.n_gt) == (1, 1, 2, 1)
    assert c.precision == 0.5
    assert c.recall == 1.0
    assert c.f1 == pytest.approx(2 / 3)


def test_maximum_matching_augments_past_a_bad_greedy_start():
    """直接測匹配核心：貪婪初始化必定卡在 1 對，增廣後必須是 2 對。

    左 0 可配右 {0, 1}；左 1 只能配右 {0}。
    貪婪由左 0 先拿走右 0 → 左 1 落空。必須靠增廣路徑把左 0 挪到右 1。
    """
    assert maximum_matching([[0, 1], [0]], n_left=2, n_right=2) == 2


def test_maximum_matching_handles_isolated_nodes():
    assert maximum_matching([[], [0], [0]], n_left=3, n_right=1) == 1


def test_matching_is_maximum_cardinality_not_greedy():
    """貪婪（先到先配最近者）在這組資料上只會配到 1 對，最佳解是 2 對。

    GT  : g1=(0,0), g2=(0,2)
    Pred: p1=(0,0) 兩個都構得到（到 g1 距離 0、到 g2 距離 2）
          p2=(2,0) 只構得到 g1（到 g2 距離 2.83 > 2）
    先到先配會讓 p1 吃掉 g1，p2 落空。最大匹配必須是 p1→g2、p2→g1。
    """
    gt = np.zeros((5, 5), dtype=bool)
    gt[0, 0] = True
    gt[0, 2] = True
    pred = np.zeros((5, 5), dtype=bool)
    pred[0, 0] = True
    pred[2, 0] = True

    c = match_edges(pred, gt, tolerance=2)
    assert c.matched_pred == 2, "配對必須是最大匹配，不能是貪婪"
    assert c.f1 == 1.0


# --- 邊界情況（皆為明示約定，非推導結果）-----------------------------------

def test_empty_prediction_scores_zero():
    c = match_edges(np.zeros((8, 8), dtype=bool), _line(8, 8, 3), tolerance=2)
    assert c.precision == 0.0 and c.recall == 0.0 and c.f1 == 0.0


def test_both_empty_scores_one_by_convention():
    empty = np.zeros((8, 8), dtype=bool)
    c = match_edges(empty, empty, tolerance=2)
    assert c.f1 == 1.0


def test_shape_mismatch_raises():
    with pytest.raises(ValueError):
        match_edges(np.zeros((4, 4), dtype=bool), np.zeros((4, 5), dtype=bool))


def test_negative_tolerance_raises():
    with pytest.raises(ValueError):
        match_edges(_line(), _line(), tolerance=-1)


# --- ODS --------------------------------------------------------------------

def test_ods_aggregates_counts_across_dataset_not_mean_of_f1():
    """ODS 是「全資料集匯總計數後算一次 F1」，不是逐圖 F1 取平均。

    門檻 0.1：逐圖 F1 = 0.1818 與 1.0，平均 0.591；匯總 F1 = 0.1964
    門檻 0.5：逐圖 F1 = 0.8    與 0.0，平均 0.400；匯總 F1 = 0.5161
    取平均會選 0.1，正確的 ODS 必須選 0.5。
    """
    counts = {
        0.1: [MatchCounts(10, 100, 10, 10), MatchCounts(1, 1, 1, 1)],
        0.5: [MatchCounts(8, 10, 8, 10), MatchCounts(0, 10, 0, 1)],
    }
    r = ods(counts)
    assert r.threshold == 0.5
    assert r.precision == pytest.approx(8 / 20)
    assert r.recall == pytest.approx(8 / 11)
    assert r.f1 == pytest.approx(2 * 0.4 * (8 / 11) / (0.4 + 8 / 11))


def test_ods_picks_lowest_threshold_on_tie():
    """並列時取較低門檻，讓結果可重現（明示約定）。"""
    counts = {
        0.3: [MatchCounts(5, 10, 5, 10)],
        0.7: [MatchCounts(5, 10, 5, 10)],
    }
    assert ods(counts).threshold == 0.3


def test_ods_rejects_empty_input():
    with pytest.raises(ValueError):
        ods({})


def test_ods_rejects_ragged_dataset():
    """每個門檻底下的影像數必須一致，否則就是漏跑。"""
    with pytest.raises(ValueError):
        ods({0.1: [MatchCounts(1, 1, 1, 1)], 0.2: []})


# --- 端到端 -----------------------------------------------------------------

def test_ods_sweep_recovers_perfect_score_on_analytic_step():
    """生成圖是對稱步階、GT 邊圖是解析上的第 30 欄 → 某個門檻下 F1 應為 1.0。"""
    h, w, boundary = 30, 61, 30
    img = np.zeros((h, w), dtype=np.float64)
    img[:, boundary] = 128.0
    img[:, boundary + 1:] = 255.0

    gt = np.zeros((h, w), dtype=bool)
    gt[:, boundary] = True

    result, counts = ods_sweep(
        [(img, gt)],
        high_thresholds=[0.2, 0.4, 0.6],
        low_ratio=0.5,
        params=CannyParams(sigma=1.0),
        tolerance=2,
    )
    assert result.f1 == pytest.approx(1.0)
    assert set(counts) == {0.2, 0.4, 0.6}
    assert result.params_used["sigma"] == 1.0
    assert result.params_used["tolerance"] == 2
