"""Edge F-score：BSDS 式的容差邊界配對、precision / recall / F1，以及 ODS。

流程（spec 4.3 指標 1）：
    生成圖 --Canny(固定參數)--> 預測邊圖
    預測邊圖 vs GT-edge（SketchUp hidden-line pass 二值化）
    --容許 2 px 位移的一對一配對--> precision / recall / F1
    全資料集掃單一門檻取最佳 --> ODS

配對為什麼要一對一：若允許多對一，把整張圖塗滿就能拿到 recall = 1.0。
一對一是這個指標唯一有意義的形式。

與 BSDS 官方實作的差異（明列，不隱藏）：
- BSDS 用最小成本二分匹配（CSA solver）。本實作求的是**最大基數**匹配。
  兩者的匹配「數量」相同 —— 而 precision / recall 只取決於數量，
  所以 P / R / F1 完全一致；差別僅在於「哪一條線配到哪一條線」，本指標用不到。
- 容差採歐氏距離 ≤ tolerance（BSDS 的 maxDist 是對角線比例，這裡直接用像素數，
  因為 spec 寫死「2 px」）。
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Iterable, Mapping, Sequence

import numpy as np

from eval.metrics.canny import CannyParams, canny

DEFAULT_TOLERANCE_PX = 2


@dataclass(frozen=True)
class MatchCounts:
    """一張圖的配對計數。P / R 只依賴這四個數字。"""

    matched_pred: int
    n_pred: int
    matched_gt: int
    n_gt: int

    @property
    def precision(self) -> float:
        if self.n_pred == 0:
            # 約定：完全沒偵測到東西時 precision = 0.0（不給白卷分數），
            # 但若 GT 也是空的，視為完全正確 → 1.0。
            return 1.0 if self.n_gt == 0 else 0.0
        return self.matched_pred / self.n_pred

    @property
    def recall(self) -> float:
        if self.n_gt == 0:
            return 1.0 if self.n_pred == 0 else 0.0
        return self.matched_gt / self.n_gt

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 0.0 if (p + r) == 0 else 2.0 * p * r / (p + r)

    def as_dict(self) -> dict:
        return {"matched_pred": self.matched_pred, "n_pred": self.n_pred,
                "matched_gt": self.matched_gt, "n_gt": self.n_gt,
                "precision": self.precision, "recall": self.recall,
                "f1": self.f1}


# --- 二分匹配 ---------------------------------------------------------------

def _tolerance_offsets(tolerance: int) -> list[tuple[int, int]]:
    """歐氏距離 ≤ tolerance 的整數位移集合。"""
    t = int(tolerance)
    return [(dy, dx)
            for dy in range(-t, t + 1)
            for dx in range(-t, t + 1)
            if dy * dy + dx * dx <= t * t]


def _build_adjacency(pred: np.ndarray, gt: np.ndarray,
                     tolerance: int) -> tuple[list[list[int]], int, int]:
    """為每個 pred 邊素列出容差內的 gt 邊素索引。"""
    h, w = pred.shape
    pred_rc = np.argwhere(pred)
    gt_rc = np.argwhere(gt)
    n_pred, n_gt = len(pred_rc), len(gt_rc)

    gt_index = np.full((h, w), -1, dtype=np.int64)
    if n_gt:
        gt_index[gt_rc[:, 0], gt_rc[:, 1]] = np.arange(n_gt)

    adj: list[list[int]] = [[] for _ in range(n_pred)]
    if n_pred == 0 or n_gt == 0:
        return adj, n_pred, n_gt

    pr, pc = pred_rc[:, 0], pred_rc[:, 1]
    for dy, dx in _tolerance_offsets(tolerance):
        rr, cc = pr + dy, pc + dx
        ok = (rr >= 0) & (rr < h) & (cc >= 0) & (cc < w)
        if not ok.any():
            continue
        idx = np.where(ok)[0]
        found = gt_index[rr[ok], cc[ok]]
        hit = found >= 0
        for u, v in zip(idx[hit], found[hit]):
            adj[int(u)].append(int(v))
    return adj, n_pred, n_gt


def _augment(u0: int, adj: Sequence[Sequence[int]],
             match_l: list[int], match_r: list[int],
             visited_r: bytearray) -> bool:
    """從左側自由點 u0 找一條增廣路徑（迭代式 DFS，避免遞迴深度上限）。"""
    stack: list[tuple[int, object]] = [(u0, iter(adj[u0]))]
    trace: list[int] = []          # trace[i] 是 stack[i] 這個左點選中的右點

    while stack:
        u, it = stack[-1]
        advanced = False
        for v in it:
            if visited_r[v]:
                continue
            visited_r[v] = 1
            w = match_r[v]
            trace.append(v)
            if w == -1:
                for (uu, _), vv in zip(stack, trace):
                    match_l[uu] = vv
                    match_r[vv] = uu
                return True
            stack.append((w, iter(adj[w])))
            advanced = True
            break
        if not advanced:
            stack.pop()
            if trace:
                trace.pop()
    return False


def maximum_matching(adj: Sequence[Sequence[int]], n_left: int,
                     n_right: int) -> int:
    """最大基數二分匹配（貪婪初始化 + Kuhn 增廣）。

    貪婪初始化只是加速：它不改變最大基數，因為之後仍會對每個未匹配點跑增廣。
    """
    match_l = [-1] * n_left
    match_r = [-1] * n_right

    for u in range(n_left):
        for v in adj[u]:
            if match_r[v] == -1:
                match_l[u] = v
                match_r[v] = u
                break

    for u in range(n_left):
        if match_l[u] == -1:
            visited = bytearray(n_right)
            _augment(u, adj, match_l, match_r, visited)

    return sum(1 for v in match_l if v != -1)


def match_edges(pred: np.ndarray, gt: np.ndarray,
                tolerance: int = DEFAULT_TOLERANCE_PX) -> MatchCounts:
    """把預測邊圖與 GT 邊圖做容差內的一對一配對，回傳計數。

    pred / gt 皆為 (H, W) 的布林（或可轉布林）陣列。
    """
    pred = np.asarray(pred, dtype=bool)
    gt = np.asarray(gt, dtype=bool)
    if pred.shape != gt.shape:
        raise ValueError(f"形狀不符：pred={pred.shape}, gt={gt.shape}")
    if pred.ndim != 2:
        raise ValueError(f"需要 2D 邊圖，得到 ndim={pred.ndim}")
    if tolerance < 0:
        raise ValueError(f"tolerance 不可為負，得到 {tolerance}")

    adj, n_pred, n_gt = _build_adjacency(pred, gt, tolerance)
    matched = maximum_matching(adj, n_pred, n_gt)
    # 一對一匹配下，配上的 pred 數與配上的 gt 數必然相等。
    return MatchCounts(matched_pred=matched, n_pred=n_pred,
                       matched_gt=matched, n_gt=n_gt)


# --- ODS --------------------------------------------------------------------

@dataclass(frozen=True)
class ODSResult:
    """全資料集單一最佳門檻下的成績。"""

    threshold: float
    precision: float
    recall: float
    f1: float
    per_threshold_f1: dict = field(default_factory=dict)
    params_used: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {"threshold": self.threshold, "precision": self.precision,
                "recall": self.recall, "f1": self.f1,
                "per_threshold_f1": self.per_threshold_f1,
                "params_used": self.params_used}


def aggregate(counts: Iterable[MatchCounts]) -> MatchCounts:
    """把多張圖的計數相加。ODS 是在**匯總後**才算一次 P / R / F1。"""
    total = MatchCounts(0, 0, 0, 0)
    for c in counts:
        total = MatchCounts(total.matched_pred + c.matched_pred,
                            total.n_pred + c.n_pred,
                            total.matched_gt + c.matched_gt,
                            total.n_gt + c.n_gt)
    return total


def ods(counts_by_threshold: Mapping[float, Sequence[MatchCounts]],
        params_used: dict | None = None) -> ODSResult:
    """ODS：全資料集共用單一門檻，取匯總 F1 最高者。

    注意這**不是**逐圖 F1 取平均。BSDS 的 ODS 是先把整個資料集的
    命中數與總數相加，再算一次 P / R / F1；小圖與大圖的權重因此不同，
    這是規格如此，不是 bug。並列時取較低門檻（可重現）。
    """
    if not counts_by_threshold:
        raise ValueError("counts_by_threshold 是空的，沒有東西可以掃")

    sizes = {len(v) for v in counts_by_threshold.values()}
    if len(sizes) != 1:
        raise ValueError(f"每個門檻底下的影像數必須一致，得到 {sizes}")
    if sizes == {0}:
        raise ValueError("每個門檻底下都沒有影像")

    per_threshold_f1: dict[float, float] = {}
    best: tuple[float, MatchCounts] | None = None
    for t in sorted(counts_by_threshold):
        total = aggregate(counts_by_threshold[t])
        per_threshold_f1[t] = total.f1
        if best is None or total.f1 > best[1].f1:  # 嚴格大於 → 並列取低門檻
            best = (t, total)

    t, total = best
    return ODSResult(threshold=t, precision=total.precision,
                     recall=total.recall, f1=total.f1,
                     per_threshold_f1=per_threshold_f1,
                     params_used=dict(params_used or {}))


def ods_sweep(samples: Sequence[tuple[np.ndarray, np.ndarray]],
              high_thresholds: Sequence[float],
              low_ratio: float = 0.4,
              params: CannyParams | None = None,
              tolerance: int = DEFAULT_TOLERANCE_PX
              ) -> tuple[ODSResult, dict[float, list[MatchCounts]]]:
    """對整個資料集掃 Canny 高門檻，回傳 (ODSResult, 各門檻的逐圖計數)。

    參數
    ----
    samples : [(生成圖灰階, GT 邊圖 bool), ...]，每個 shot 一筆。
    high_thresholds : 要掃的 Canny 高門檻。relative 模式下是最大梯度的比例。
    low_ratio : 低門檻 = high × low_ratio（沿用 Canny 常見的 1:2～1:3 比例）。
    params : 其餘 Canny 參數（sigma、threshold_mode）；low / high 會被掃描值覆蓋。

    逐圖計數要一併存進 CSV —— 報告需要挑出 C 表現最差的 shot 做失敗案例分析。
    """
    if not samples:
        raise ValueError("samples 是空的")
    if not high_thresholds:
        raise ValueError("high_thresholds 是空的")
    if not (0.0 < low_ratio <= 1.0):
        raise ValueError(f"low_ratio 必須落在 (0, 1]，得到 {low_ratio}")

    base = params or CannyParams()
    counts_by_threshold: dict[float, list[MatchCounts]] = {}
    for t in high_thresholds:
        p = dataclasses.replace(base, low=t * low_ratio, high=t).validate()
        counts_by_threshold[t] = [
            match_edges(canny(gen, p), gt, tolerance=tolerance)
            for gen, gt in samples
        ]

    used = {"sigma": base.sigma, "threshold_mode": base.threshold_mode,
            "low_ratio": low_ratio, "tolerance": tolerance,
            "high_thresholds": list(high_thresholds)}
    return ods(counts_by_threshold, params_used=used), counts_by_threshold
