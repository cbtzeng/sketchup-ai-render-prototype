"""PNG 讀取層。

**刻意不自己寫 PNG 解碼器。** 專案已經有一個純標準庫 + numpy 的解碼器
`tools/analysis/png_probe.py`，而且已在 fog 標定（journal 003）中實際跑過 12 張圖，
是被驗證過的程式碼。這裡用檔案路徑動態載入它，理由：

- `tools/` 不是 Python 套件（沒有 `__init__.py`），不能直接 `import`。
- 複製一份解碼器會產生兩個會分岔的真相來源。
- 引入 PIL / opencv 只為了讀 PNG，不值得（環境也沒裝）。

限制沿用上游：只支援 8-bit、非交錯 PNG。SketchUp 的 `write_image` 輸出符合這個條件
（journal 003 的標定影像即由同一條路徑讀取），但**若日後改用 16-bit 輸出，
這裡會直接 assert 失敗，屬預期行為**。
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys
from typing import Union

import numpy as np

PathLike = Union[str, pathlib.Path]

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_PNG_PROBE_PATH = _REPO_ROOT / "tools" / "analysis" / "png_probe.py"


def _load_png_probe():
    """以檔案路徑載入 tools/analysis/png_probe.py（唯讀重用，不修改上游）。"""
    if not _PNG_PROBE_PATH.is_file():
        raise FileNotFoundError(
            f"找不到既有的 PNG 解碼器：{_PNG_PROBE_PATH}。"
            "eval 刻意重用它而非另寫一份，請勿以複製程式碼繞過。")
    spec = importlib.util.spec_from_file_location(
        "eval._vendored_png_probe", _PNG_PROBE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


_png_probe = _load_png_probe()


def read_png_rgb(path: PathLike) -> np.ndarray:
    """讀 PNG，回傳 (H, W, 3) uint8。

    帶 alpha 的來源會被上游丟掉 alpha 通道（不做合成），
    因為控制圖與 GT 都是不透明的。
    """
    p = pathlib.Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"PNG 不存在：{p}")
    img = _png_probe.read_png(str(p))
    return np.ascontiguousarray(img, dtype=np.uint8)


def rec601_luma(rgb: np.ndarray) -> np.ndarray:
    """Rec.601 luma，以整數權重計算後再除，避免浮點誤差。

    這是本檔唯一沒有沿用 `png_probe.luma` 的地方，理由是精度而非風格：
    `0.299*g + 0.587*g + 0.114*g` 對 g=128 會得到 127.99999999999999，
    在「灰階 < 門檻」這種邊界判斷上會翻面。
    改用 `(299R + 587G + 114B) / 1000` 的整數分子後，純灰像素恆等還原
    （fog depth pass 正是純灰圖，這個性質是深度換算的前提）。
    """
    r = rgb[:, :, 0].astype(np.int64)
    g = rgb[:, :, 1].astype(np.int64)
    b = rgb[:, :, 2].astype(np.int64)
    return (299 * r + 587 * g + 114 * b) / 1000.0


def read_grayscale(path: PathLike) -> np.ndarray:
    """讀 PNG 並轉成 Rec.601 luma，回傳 (H, W) float64，值域 [0, 255]。

    fog depth pass 是三通道相同的灰階圖，luma 對它是恆等轉換
    （299 + 587 + 114 = 1000），所以灰階值可直接餵給
    `depth_corr.grey_to_metric_depth`。
    """
    return rec601_luma(read_png_rgb(path))


def read_edge_map(path: PathLike, threshold: float = 128.0,
                  dark_is_edge: bool = True) -> np.ndarray:
    """讀二值化的邊圖，回傳 (H, W) bool。

    參數
    ----
    threshold : luma 門檻。`dark_is_edge=True` 時 `luma < threshold` 為邊（嚴格小於）。
    dark_is_edge : SketchUp 的 hidden-line pass 是白底黑線，故預設 True。
                   若素材是黑底白線（例如某些 Canny 輸出）請設 False。

    門檻本身是評估參數，必須連同 Canny 參數一起記錄進 eval/config.json。
    """
    grey = read_grayscale(path)
    return (grey < threshold) if dark_is_edge else (grey > threshold)
