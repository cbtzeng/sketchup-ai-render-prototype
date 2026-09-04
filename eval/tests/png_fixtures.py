"""測試素材用的 PNG 寫出。

實作已搬到 eval/metrics/io.py（因為 providers/dryrun.py 也要用，
而 production 程式碼不該 import 測試模組 —— 相依方向只能是
測試依賴 production，不能反過來）。這裡保留同名再匯出，
既有測試的 import 路徑不用改。

測試會以頂層模組（`import png_fixtures`）而非套件成員被載入，
所以這裡不能用相對匯入。
"""
from eval.metrics.io import _chunk, write_png_gray, write_png_rgb  # noqa: F401

__all__ = ["write_png_rgb", "write_png_gray", "_chunk"]
