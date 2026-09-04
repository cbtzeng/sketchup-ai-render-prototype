#!/usr/bin/env python3
"""最小生成煙霧測試：不經過 run.py，直接證明 diffusers + MPS 這條路能出圖。

先跑這支再跑 eval.run 的理由：跑批牽涉 config 載入、shot 掃描、控制圖轉換、
manifest 寫入。如果直接跑批而失敗，要花時間才能判斷是「生成不行」還是
「跑批的某一步不行」。這支只做一件事，失敗就一定是生成本身。

由小而大：512 無控制 → 512 單控制 → 768 雙控制。
哪一階段失敗，就知道是解析度問題還是 controlnet 疊加問題。
"""
import sys, time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from eval.providers.local import LocalProvider          # noqa: E402
from eval.providers.base import GenerationRequest       # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "eval" / "out" / "_smoke"
OUT.mkdir(parents=True, exist_ok=True)


def make_inputs(size):
    """造一張有結構的測試圖與對應的控制圖。"""
    a = np.full((size, size, 3), 190, np.uint8)
    a[size // 4:size * 3 // 4, size // 4:size * 3 // 4] = 120     # 一個方塊
    a[size // 2:, :] = 150                                        # 地面
    init = OUT / f"init_{size}.png"; Image.fromarray(a).save(init)

    e = np.zeros((size, size), np.uint8)
    for y in (size // 4, size * 3 // 4 - 1):
        e[y, size // 4:size * 3 // 4] = 255
    for x in (size // 4, size * 3 // 4 - 1):
        e[size // 4:size * 3 // 4, x] = 255
    edge = OUT / f"edge_{size}.png"; Image.fromarray(255 - e).save(edge)

    d = np.full((size, size), 60, np.uint8)
    d[size // 4:size * 3 // 4, size // 4:size * 3 // 4] = 200
    depth = OUT / f"depth_{size}.png"; Image.fromarray(d).save(depth)
    return init, edge, depth


STAGES = [
    ("1. 512 無控制（最單純）",      512, {},                       {}),
    ("2. 512 單控制（edge）",        512, {"edge": None},           {"edge": 0.8}),
    ("3. 768 雙控制（實際設定）",     768, {"edge": None, "depth": None}, {"edge": 0.8, "depth": 0.5}),
]


def main():
    provider = LocalProvider()
    print(f"device={provider.device}  dtype={provider.dtype}", flush=True)

    for label, size, controls, weights in STAGES:
        init, edge, depth = make_inputs(size)
        ctrl = {}
        if "edge" in controls:
            ctrl["edge"] = edge
        if "depth" in controls:
            ctrl["depth"] = depth

        print(f"\n--- {label} ---", flush=True)
        req = GenerationRequest(
            shot_id="smoke", condition=label[:1],
            prompt="architectural photography of a concrete building, daylight, sharp focus",
            negative_prompt="blurry, distorted, text, watermark",
            seed=20260905, steps=20, cfg=6.0, sampler="unipc", denoise=0.65,
            width=size, height=size, init_image=init,
            controls=ctrl, weights=weights,
        )
        dest = OUT / f"stage{label[0]}.png"
        t = time.time()
        try:
            res = provider.generate(req, dest)
        except Exception as e:
            print(f"  失敗：{type(e).__name__}: {e}", flush=True)
            return 1

        img = np.asarray(Image.open(dest).convert("RGB"))
        # MPS 的 float16 黑圖問題會產出全黑或全 NaN。用 float32 應該不會，
        # 但要親眼確認而不是假設。
        print(f"  OK {res.latency_ms} ms  "
              f"平均亮度={img.mean():.1f}  標準差={img.std():.1f}  "
              f"{'！疑似全黑或無內容' if img.std() < 5 else '有內容'}", flush=True)
    print(f"\n全部通過。圖在 {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
