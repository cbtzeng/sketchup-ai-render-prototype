"""不連網的 provider：產出確定性的佔位圖。

用途不是「假裝有結果」，而是**在花錢之前驗證整條分析管線**：
跑批的檔案佈局、metadata 是否齊全、指標讀不讀得到、統計跑不跑得出 CI、
報告產不產得出來。這些全部都能在沒有 GPU 的情況下驗完。

佔位圖刻意做成「beauty 疊上一層依 seed 決定的形變」，
這樣 Edge F 與 depth 相關性會落在一個非平凡但可預期的區間 ——
如果分析管線有 bug（例如把所有條件都算成 1.0），用這個就看得出來。
"""
from __future__ import annotations

import hashlib
import time
from pathlib import Path

import numpy as np

from ..metrics.io import read_png_rgb
from ..metrics.io import write_png_rgb
from .base import GenerationRequest, GenerationResult, Provider


class DryRunProvider(Provider):
    name = "dryrun"

    def generate(self, req: GenerationRequest, out_path: Path) -> GenerationResult:
        t0 = time.time()
        img = read_png_rgb(str(req.init_image)).astype(np.float64)

        # 依 (shot, condition, seed) 決定的形變量。
        # 控制圖越多，形變越小 —— 模擬「多重控制讓結構更貼近原始幾何」。
        # 這只是為了讓管線產出非平凡的數字，**不是對真實效果的預測**。
        rng = np.random.default_rng(
            int(hashlib.sha256(f"{req.shot_id}|{req.condition}|{req.seed}".encode()).hexdigest()[:8], 16)
        )
        drift = {"A": 6.0, "B": 3.0, "C1": 1.5, "C2": 1.2}.get(req.condition, 4.0)

        h, w, _ = img.shape
        dy, dx = rng.normal(0, drift, 2)
        shifted = np.roll(np.roll(img, int(round(dy)), axis=0), int(round(dx)), axis=1)
        noise = rng.normal(0, drift * 1.5, shifted.shape)
        out = np.clip(shifted + noise, 0, 255).astype(np.uint8)

        out_path.parent.mkdir(parents=True, exist_ok=True)
        write_png_rgb(str(out_path), out)

        return GenerationResult(
            output_path=out_path,
            latency_ms=int((time.time() - t0) * 1000),
            cost_usd=0.0,
            provider=self.name,
            raw={"drift_px": drift, "note": "dry run，非真實生成"},
        )

    def estimate_cost_usd(self, req: GenerationRequest) -> float:
        return 0.0
