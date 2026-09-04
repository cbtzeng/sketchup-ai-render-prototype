"""配對 bootstrap 測試。

關鍵是「配對」：a 與 b 必須用同一組重抽樣索引。
零變異的配對差值會讓 CI 塌成一個點 —— 這正好是驗證配對性的封閉解。
"""
import numpy as np
import pytest

from eval.stats import median_per_shot, paired_bootstrap


def test_constant_paired_difference_gives_degenerate_ci():
    """每個 shot 的差值都是 0.5 → 不論怎麼重抽，平均差都是 0.5。

    如果實作誤把 a、b 各自獨立重抽（沒有配對），CI 會被撐開，這個測試就會失敗。
    """
    a = np.array([0.10, 0.42, 0.31, 0.88, 0.55, 0.07])
    b = a - 0.5

    r = paired_bootstrap(a, b, n=2000, seed=1)
    assert r.mean_diff == pytest.approx(0.5)
    assert r.ci_low == pytest.approx(0.5)
    assert r.ci_high == pytest.approx(0.5)
    assert r.ci_excludes_zero is True


def test_identical_inputs_give_zero_diff_and_ci_including_zero():
    a = np.array([0.2, 0.9, 0.4, 0.4, 0.7])
    r = paired_bootstrap(a, a.copy(), n=2000, seed=2)
    assert r.mean_diff == 0.0
    assert (r.ci_low, r.ci_high) == (0.0, 0.0)
    assert r.ci_excludes_zero is False


def test_direction_is_a_minus_b():
    """介面約定：diff = a − b。回報 C−A 時要傳 (C, A)。"""
    r = paired_bootstrap(np.array([1.0, 1.0]), np.array([0.0, 0.0]),
                         n=200, seed=3)
    assert r.mean_diff == pytest.approx(1.0)


def test_same_seed_is_reproducible():
    rng = np.random.default_rng(7)
    a, b = rng.normal(size=12), rng.normal(size=12)
    r1 = paired_bootstrap(a, b, n=1000, seed=42)
    r2 = paired_bootstrap(a, b, n=1000, seed=42)
    assert (r1.ci_low, r1.ci_high) == (r2.ci_low, r2.ci_high)


def test_different_seed_changes_ci():
    rng = np.random.default_rng(8)
    a, b = rng.normal(size=12), rng.normal(size=12)
    r1 = paired_bootstrap(a, b, n=1000, seed=1)
    r2 = paired_bootstrap(a, b, n=1000, seed=2)
    assert (r1.ci_low, r1.ci_high) != (r2.ci_low, r2.ci_high)
    assert r1.mean_diff == pytest.approx(r2.mean_diff)  # 點估計與 seed 無關


def test_ci_brackets_the_point_estimate():
    rng = np.random.default_rng(9)
    a = rng.normal(loc=0.6, scale=0.1, size=12)
    b = rng.normal(loc=0.5, scale=0.1, size=12)
    r = paired_bootstrap(a, b, n=10000, seed=11)
    assert r.ci_low <= r.mean_diff <= r.ci_high


def test_clear_signal_gives_ci_excluding_zero():
    """效果量 0.3、雜訊 0.01 → CI 必然遠離 0。

    注意這裡**不**斷言 CI 涵蓋真值 0.3：CI 是繞著樣本平均建的，
    n=12 時樣本平均本來就會偏離真值，「必然涵蓋」是錯的統計直覺。
    涵蓋率由下面的 coverage 測試處理。
    """
    rng = np.random.default_rng(10)
    a = rng.normal(loc=0.8, scale=0.01, size=12)
    b = a - 0.3 + rng.normal(scale=0.01, size=12)
    r = paired_bootstrap(a, b, n=10000, seed=5)
    assert r.ci_low > 0.25
    assert r.ci_excludes_zero is True


def test_ci_has_approximately_nominal_coverage():
    """百分位 bootstrap 的實證涵蓋率應接近名目 95%。

    這是這支統計工具唯一真正重要的性質。用 n=12（就是本評估的樣本數）
    模擬 300 次，檢查涵蓋率落在合理範圍。
    ⚠ 百分位法在小樣本會略低於名目值，所以下界放寬到 0.85。
    """
    true_effect = 0.2
    trials, covered = 300, 0
    rng = np.random.default_rng(2026)
    for i in range(trials):
        diff = rng.normal(loc=true_effect, scale=0.1, size=12)
        r = paired_bootstrap(diff, np.zeros(12), n=1000, seed=i)
        covered += int(r.ci_low <= true_effect <= r.ci_high)
    coverage = covered / trials
    assert 0.85 <= coverage <= 0.99, f"涵蓋率 {coverage:.3f} 偏離名目 0.95"


def test_result_records_run_parameters():
    """報告要能重現，n 與 seed 必須被帶出來。"""
    r = paired_bootstrap(np.arange(5.0), np.arange(5.0) - 1, n=777, seed=123)
    assert r.n_resamples == 777
    assert r.seed == 123
    assert r.n_shots == 5


def test_meets_hypothesis_applies_both_gates():
    """H1 要求：配對差值 ≥ 門檻 **且** CI 不含 0。"""
    a = np.array([0.5, 0.5, 0.5, 0.5])
    r = paired_bootstrap(a, a - 0.15, n=500, seed=4)
    assert r.meets_hypothesis(0.10) is True
    assert r.meets_hypothesis(0.20) is False

    flat = paired_bootstrap(a, a.copy(), n=500, seed=4)
    assert flat.meets_hypothesis(0.0) is False  # CI 含 0


def test_length_mismatch_raises():
    with pytest.raises(ValueError):
        paired_bootstrap(np.arange(5.0), np.arange(6.0))


def test_empty_input_raises():
    with pytest.raises(ValueError):
        paired_bootstrap(np.array([]), np.array([]))


def test_non_positive_n_raises():
    with pytest.raises(ValueError):
        paired_bootstrap(np.arange(3.0), np.arange(3.0), n=0)


def test_nan_input_raises():
    """指標算不出來就該停下來，不要讓 nan 悄悄污染 CI。"""
    with pytest.raises(ValueError):
        paired_bootstrap(np.array([1.0, np.nan]), np.array([0.0, 0.0]))


def test_default_n_is_ten_thousand():
    r = paired_bootstrap(np.arange(4.0), np.arange(4.0) - 1)
    assert r.n_resamples == 10000


# --- 多 seed 的 shot 內收斂 -------------------------------------------------

def test_median_per_shot_collapses_seeds():
    """多 seed 時先在 shot 內取中位數，避免用 seed 灌大樣本數。"""
    m = np.array([[0.1, 0.5, 0.3],
                  [0.9, 0.7, 0.8]])
    np.testing.assert_allclose(median_per_shot(m), [0.3, 0.8])


def test_median_per_shot_accepts_single_seed_column():
    m = np.array([[0.4], [0.6]])
    np.testing.assert_allclose(median_per_shot(m), [0.4, 0.6])


def test_median_per_shot_rejects_1d():
    with pytest.raises(ValueError):
        median_per_shot(np.array([0.1, 0.2]))
