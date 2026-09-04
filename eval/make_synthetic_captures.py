#!/usr/bin/env python3
"""產生合成的擷取資料，讓整條分析管線在沒有 SketchUp 的情況下就能驗證。

**這不是評估資料。** 真正的評估必須用 SketchUp 產出的控制圖 ——
合成資料只是用來確認「跑批 → 指標 → 統計 → 報告」這條路是通的，
而且指標算出來的數字有分辨力（不是全部都 1.0 或全部都 0）。

先驗管線再跑真資料，這個順序不能反：
真資料上的異常，你會分不清是生成品質問題還是分析程式有 bug。

用法
    python3 -m eval.make_synthetic_captures --shots 12
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .metrics.io import write_png_gray, write_png_rgb

ROOT = Path(__file__).resolve().parent


def make_shot(rng: np.random.Generator, size: int = 256):
    """造一個「有結構」的假場景：若干矩形量體，各有不同深度。

    刻意做出遮擋關係，這樣 hidden-line 與 depth 才有意義，
    Edge F 與 depth 相關性也才會落在非平凡的區間。
    """
    depth_m = np.full((size, size), 60.0)          # 背景設為遠平面
    edges = np.zeros((size, size), dtype=np.uint8)
    albedo = np.full((size, size, 3), 200, dtype=np.uint8)

    n_boxes = int(rng.integers(3, 6))
    boxes = []
    for _ in range(n_boxes):
        w = int(rng.integers(size // 6, size // 3))
        h = int(rng.integers(size // 5, size // 2))
        x = int(rng.integers(0, size - w))
        y = int(rng.integers(0, size - h))
        d = float(rng.uniform(3.0, 40.0))
        boxes.append((d, x, y, w, h))

    # 由遠到近畫，近的蓋住遠的 —— 這就是遮擋
    for d, x, y, w, h in sorted(boxes, reverse=True):
        depth_m[y:y + h, x:x + w] = d
        tone = int(np.clip(255 - d * 3, 40, 240))
        albedo[y:y + h, x:x + w] = np.array([tone, tone, min(255, tone + 20)], dtype=np.uint8)
        edges[y:y + h, x] = 255
        edges[y:y + h, min(x + w - 1, size - 1)] = 255
        edges[y, x:x + w] = 255
        edges[min(y + h - 1, size - 1), x:x + w] = 255

    return depth_m, edges, albedo


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", type=int, default=12)
    ap.add_argument("--size", type=int, default=256)
    ap.add_argument("--out", default=str(ROOT / "captures"))
    ap.add_argument("--seed", type=int, default=20260904)
    args = ap.parse_args(argv)

    out = Path(args.out)
    rng = np.random.default_rng(args.seed)
    fog_start, fog_end = 0.0, 60.0

    kinds = ["exterior/orthogonal-massing", "exterior/curved-surface", "exterior/large-glazing",
             "interior/dense-openings", "interior/slender-members", "interior/complex-furniture"]

    for i in range(args.shots):
        kind = kinds[i % len(kinds)].replace("/", "-")
        shot_id = f"{kind}-cam{i // len(kinds) + 1}"
        d = out / shot_id
        d.mkdir(parents=True, exist_ok=True)

        depth_m, edges, albedo = make_shot(rng, args.size)

        # fog 的正演公式，與 journal 003 實測一致：
        #   grey = 255 * (1 - (d - start)/(end - start))
        grey = np.clip(255.0 * (1.0 - (depth_m - fog_start) / (fog_end - fog_start)), 0, 255)

        write_png_rgb(str(d / "beauty.png"), albedo)
        # hidden-line：白底黑線（edges 是白線，所以反相）
        write_png_gray(str(d / "edge.png"), (255 - edges).astype(np.uint8))
        write_png_gray(str(d / "depth.png"), grey.astype(np.uint8))

        with (d / "capture.json").open("w", encoding="utf-8") as fh:
            json.dump({
                "synthetic": True,
                "_warning": "合成資料，僅供驗證管線。真正的評估必須用 SketchUp 產出的控制圖。",
                "plan": {"width": args.size, "height": args.size},
                "passes": {
                    "depth": {"fog_start_m": fog_start, "fog_end_m": fog_end,
                              "grey_to_distance": "d = start + (1 - grey/255) * (end - start)"}
                }
            }, fh, ensure_ascii=False, indent=2)

    print(f"已產生 {args.shots} 個合成 shot 於 {out}")
    print("⚠️ 這是合成資料，只能用來驗證管線，不能當評估結果。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
