#!/usr/bin/env python3
"""讀跑批結果，算指標與配對統計，產出 eval/report.md。

用法
    python3 -m eval.analyze

指標
    Edge F-score  對生成圖跑 Canny → 與 GT 邊圖（hidden-line pass）做 2px 容差配對
    Depth ρ       對生成圖做單目深度估計 → 與 GT 深度（fog pass 換算的公制 z）比對

⚠️ Depth 指標需要單目深度估計器（MiDaS / Depth-Anything 之類），本機沒有安裝。
   沒有估計器時**不會**用亮度之類的東西湊一個假的數字 ——
   那會產生看起來合理但完全沒有意義的相關係數，比沒有數字更糟。
   會明確標為未計算，並在報告中說明。

統計
    對 shot 做配對 bootstrap，回報 C−A 與 C−B 的**配對差值**與 95% CI。
    不是三組各自的平均值相減 —— 那會失去配對帶來的變異抵銷。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .metrics.canny import CannyParams, run_canny
from .metrics.edge_f import match_edges
from .metrics.io import downsample_max, read_edge_map, read_grayscale
from .stats import paired_bootstrap

ROOT = Path(__file__).resolve().parent


def try_depth_estimator():
    """回傳可用的單目深度估計器，沒有就回 None。不做任何替代品。"""
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except ImportError:
        return None
    return None  # 🔴 尚未接上具體模型；有了再實作，現在誠實回 None


def edge_f_for(generated: Path, gt_edge: Path, params: CannyParams) -> float:
    gen_grey = read_grayscale(str(generated))
    pred = run_canny(gen_grey, params).edges
    # GT 邊圖是白底黑線（SketchUp 的 hidden-line pass），所以黑色像素才是邊
    gt = read_edge_map(str(gt_edge), threshold=128.0, dark_is_edge=True)

    # 擷取是 1024²、生成受記憶體限制跑 640²，尺寸不同。
    # 把 GT **降**到預測圖的尺寸，而不是把預測圖放大 ——
    # 放大不增加資訊，只會讓邊線變粗而虛報 recall。
    # 二值邊圖用區塊取最大，平均會讓細線淡到低於門檻而整條消失。
    if gt.shape != pred.shape:
        gt = downsample_max(gt.astype(np.uint8), pred.shape).astype(bool)

    counts = match_edges(pred, gt, tolerance=2)
    return counts.f1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "out"))
    ap.add_argument("--captures", default=str(ROOT / "captures"))
    ap.add_argument("--report", default=str(ROOT / "report.md"))
    args = ap.parse_args(argv)

    out_root = Path(args.out)
    manifest_path = out_root / "manifest.json"
    if not manifest_path.exists():
        print(f"找不到 {manifest_path}，請先跑 python3 -m eval.run")
        return 1

    with manifest_path.open(encoding="utf-8") as fh:
        manifest = json.load(fh)

    cfg = manifest["config"]
    cp = CannyParams(sigma=1.4, low=0.1, high=0.2, threshold_mode="relative")
    depth_estimator = try_depth_estimator()

    # shot → condition → 指標
    table: dict[str, dict[str, dict]] = {}
    synthetic = False
    for run in manifest["runs"]:
        shot, cond = run["shot"], run["condition"]
        synthetic = synthetic or run.get("capture_meta", {}).get("synthetic", False)
        gt_edge = Path(args.captures) / shot / "edge.png"
        gen = out_root / run["output"]
        table.setdefault(shot, {})[cond] = {
            "edge_f": edge_f_for(gen, gt_edge, cp),
            "depth_rho": None,  # 需要單目深度估計器
            "latency_ms": run["latency_ms"],
            "cost_usd": run["cost_usd"],
        }

    conditions = sorted({c for v in table.values() for c in v})
    shots = sorted(table)

    def series(cond, key):
        return np.array([table[s][cond][key] for s in shots if cond in table[s]], dtype=float)

    lines = []
    w = lines.append
    w("# 評估報告")
    w("")
    if synthetic:
        w("> ⚠️ **本次使用合成擷取資料，不是評估結果。**")
        w("> 這一輪的目的是驗證分析管線本身（跑批 → 指標 → 統計 → 報告）能不能跑通、")
        w("> 指標有沒有分辨力。真正的結論必須用 SketchUp 產出的控制圖重跑。")
        w("")
    if manifest["provider"] == "dryrun":
        w("> ⚠️ **provider 為 dryrun**，輸出是確定性的佔位圖，不是模型生成的結果。")
        w("")

    w("## 受控變因")
    w("")
    w("| 項目 | 值 |")
    w("|---|---|")
    w(f"| 底模 | {cfg['model']['base']} |")
    w(f"| seed | {cfg['sampling']['seed']} |")
    w(f"| steps / cfg / sampler | {cfg['sampling']['steps']} / {cfg['sampling']['cfg']} / {cfg['sampling']['sampler']} |")
    w(f"| denoise | {cfg['sampling']['denoise']} |")
    w(f"| 輸出尺寸 | {cfg['output']['width']}×{cfg['output']['height']} |")
    w(f"| shots | {len(shots)} |")
    w(f"| provider | {manifest['provider']} |")
    w(f"| 總成本 | US${manifest.get('total_cost_usd', 0):.4f} |")
    w("")

    w("## 各條件表現")
    w("")
    w("| 條件 | 說明 | Edge F1（平均） | Depth ρ | 延遲中位數 |")
    w("|---|---|---|---|---|")
    for c in conditions:
        ef = series(c, "edge_f")
        lat = series(c, "latency_ms")
        label = cfg["conditions"].get(c, {}).get("label", c)
        w(f"| **{c}** | {label} | {ef.mean():.4f} | 未計算 | {np.median(lat):.0f} ms |")
    w("")

    if depth_estimator is None:
        w("> **Depth ρ 未計算。** 需要單目深度估計器（MiDaS / Depth-Anything 之類），")
        w("> 本機未安裝。刻意不用亮度之類的東西湊一個替代品 —— 那會產生看起來合理")
        w("> 但沒有意義的相關係數，比沒有數字更糟。GT 深度本身是完備的")
        w("> （fog pass 為精確線性，可無損換算回公尺，見 journal 003），")
        w("> 缺的只有「從生成圖估深度」這一端。")
        w("")

    w("## 配對差值與 95% CI")
    w("")
    w("對 shot 做 10,000 次配對 bootstrap。**回報配對差值，不是各組平均相減** ——")
    w("配對能抵銷 shot 之間的難度差異，這是本設計的重點。")
    w("")
    w("| 比較 | Edge F1 差值 | 95% CI | CI 是否排除 0 |")
    w("|---|---|---|---|")
    baseline_pairs = [(c, b) for c in conditions if c.startswith("C") for b in ("A", "B") if b in conditions]
    for treat, base in baseline_pairs:
        a, b = series(treat, "edge_f"), series(base, "edge_f")
        if len(a) != len(b) or len(a) == 0:
            continue
        r = paired_bootstrap(a, b, n=10000, seed=0)
        excl = "是" if (r.ci_low > 0 or r.ci_high < 0) else "**否**"
        w(f"| {treat} − {base} | {r.mean_diff:+.4f} | [{r.ci_low:+.4f}, {r.ci_high:+.4f}] | {excl} |")
    w("")

    w("### 為什麼 C − B 比 C − A 重要")
    w("")
    w("B 組（對 beauty 截圖跑 Canny）是**外部工具用一張截圖就做得到**的事。")
    w("C 打贏 A 只證明「有控制圖比沒有好」；C 要打贏 B，才證明")
    w("「必須跑在 SketchUp 內部」。若 C − B 的 CI 含 0，結論必須改寫成")
    w("「護城河在語意遮罩與相機真值，不在 edge/depth」—— 這是 open-questions Q8 已經決定的立場。")
    w("")

    w("## 逐 shot 明細")
    w("")
    w("| shot | " + " | ".join(conditions) + " |")
    w("|---|" + "---|" * len(conditions))
    for s in shots:
        cells = [f"{table[s][c]['edge_f']:.4f}" if c in table[s] else "—" for c in conditions]
        w(f"| {s} | " + " | ".join(cells) + " |")
    w("")

    w("## 尚未完成")
    w("")
    w("- [ ] Depth ρ（需要單目深度估計器）")
    w("- [ ] 消失點角度誤差（加分項）")
    w("- [ ] 開口幻覺率（加分項）")
    w("- [ ] 人類偏好 A/B（spec 的 H2 守門指標）—— **沒有這一項，「結構變準」的結論不完整**")
    w("- [ ] 失敗案例分析：挑 2–3 個 C 表現最差的 shot 說明原因")
    w("")

    Path(args.report).write_text("\n".join(lines), encoding="utf-8")
    print(f"報告已寫入 {args.report}")
    for c in conditions:
        print(f"  {c}: Edge F1 平均 {series(c, 'edge_f').mean():.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
