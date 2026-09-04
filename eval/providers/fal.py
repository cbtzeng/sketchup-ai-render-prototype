"""fal.ai provider —— **尚未實作，刻意的**。

🔴 以下每一項都沒有查證過，本專案的硬規則是不猜：
   1. 端點路徑（多 ControlNet 的 SDXL 端點叫什麼）
   2. 請求參數名（init image / controlnet 陣列 / 權重欄位怎麼命名）
   3. 回應格式與非同步佇列的取結果方式
   4. webhook 的 schema 與簽章 header 名稱、演算法
   5. 計費單位（每次？每 megapixel？每 GPU 秒？）

把「看起來合理」的端點寫上去，會在跑批時才炸，而且錯誤訊息通常是
400 加一段語焉不詳的說明，比現在直接拒絕執行更難查。

要接上時的順序：
   1. 查 fal.ai 官方文件，把上面五項填進 eval/config.json 的 model 區段
   2. 實作下面的 generate()
   3. 先用 1 個 shot 跑通，確認計費金額與預期相符
   4. 才開全量跑批（config 的 budget.max_usd_total 是最後一道保險）
"""
from __future__ import annotations

from pathlib import Path

from .base import GenerationRequest, GenerationResult, Provider


class FalProvider(Provider):
    name = "fal"

    def generate(self, req: GenerationRequest, out_path: Path) -> GenerationResult:
        raise NotImplementedError(
            "fal.ai 的端點與參數尚未查證。\n"
            "請先完成 eval/providers/fal.py 檔頭列出的五項，再實作這個方法。\n"
            "在那之前請用 --provider dryrun 驗證分析管線。"
        )
