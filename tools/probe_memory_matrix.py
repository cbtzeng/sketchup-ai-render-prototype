#!/usr/bin/env python3
"""找出這台機器上「能穩定跑雙控制」的最大設定。

背景：768 雙控制在 float32 下 OOM（單次要 5.12 GiB，其他程式已佔 10.13 GiB）。
與其猜哪個組合可行，不如把 (dtype, 解析度) 的矩陣跑一遍。

每組都檢查產出的標準差 —— MPS 的 float16 有黑圖的歷史問題，
所以不能只看「沒有拋例外」就當成功。要親眼確認圖有內容。
"""
import gc, sys, time
from pathlib import Path

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from eval.providers.base import GenerationRequest   # noqa: E402
from eval.providers.local import LocalProvider      # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "eval" / "out" / "_matrix"
OUT.mkdir(parents=True, exist_ok=True)

# 由大到小。找到第一個可行的就是我們要的設定。
MATRIX = [("float16", 768), ("float16", 640), ("float32", 640), ("float16", 512), ("float32", 512)]


def inputs(size):
    a = np.full((size, size, 3), 190, np.uint8)
    a[size//4:size*3//4, size//4:size*3//4] = 120
    a[size//2:, :] = 150
    init = OUT / f"init_{size}.png"; Image.fromarray(a).save(init)
    e = np.zeros((size, size), np.uint8)
    for y in (size//4, size*3//4-1): e[y, size//4:size*3//4] = 255
    for x in (size//4, size*3//4-1): e[size//4:size*3//4, x] = 255
    edge = OUT / f"edge_{size}.png"; Image.fromarray(255-e).save(edge)
    d = np.full((size, size), 60, np.uint8)
    d[size//4:size*3//4, size//4:size*3//4] = 200
    depth = OUT / f"depth_{size}.png"; Image.fromarray(d).save(depth)
    return init, edge, depth


def main():
    print(f"{'dtype':>9} {'尺寸':>5} {'結果':>6} {'耗時':>8}  說明", flush=True)
    print("-" * 62, flush=True)
    winner = None
    for dtype, size in MATRIX:
        init, edge, depth = inputs(size)
        provider = LocalProvider(dtype=dtype)
        req = GenerationRequest(
            shot_id="matrix", condition="C",
            prompt="architectural photography of a concrete building, daylight",
            negative_prompt="blurry, distorted, text",
            seed=20260905, steps=20, cfg=6.0, sampler="unipc", denoise=0.65,
            width=size, height=size, init_image=init,
            controls={"edge": edge, "depth": depth},
            weights={"edge": 0.8, "depth": 0.5},
        )
        dest = OUT / f"{dtype}_{size}.png"
        t = time.time()
        try:
            provider.generate(req, dest)
            img = np.asarray(Image.open(dest).convert("RGB"))
            std = float(img.std())
            ms = int((time.time() - t) * 1000)
            if std < 5:
                print(f"{dtype:>9} {size:>5} {'黑圖':>6} {ms:>7}ms  標準差 {std:.1f}，MPS 的已知問題", flush=True)
            else:
                print(f"{dtype:>9} {size:>5} {'OK':>6} {ms:>7}ms  標準差 {std:.1f}，有內容", flush=True)
                if winner is None:
                    winner = (dtype, size, ms)
        except RuntimeError as e:
            msg = "OOM" if "out of memory" in str(e) else type(e).__name__
            print(f"{dtype:>9} {size:>5} {msg:>6} {'':>9}  {str(e)[:60]}", flush=True)
        finally:
            del provider
            gc.collect()
            if hasattr(torch, "mps"):
                torch.mps.empty_cache()

    print("-" * 62, flush=True)
    if winner:
        d, s, ms = winner
        print(f"可用的最大設定：dtype={d} 尺寸={s}  單張約 {ms/1000:.1f}s", flush=True)
        print(f"48 張跑批推估：約 {48 * ms / 1000 / 60:.0f} 分鐘", flush=True)
    else:
        print("沒有任何組合可行 —— 需要改用單一 ControlNet 或關掉其他程式", flush=True)
    return 0 if winner else 1


if __name__ == "__main__":
    sys.exit(main())
