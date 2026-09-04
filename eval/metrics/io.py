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


# ---------------------------------------------------------------------------
# PNG 寫出
#
# 原本只存在於 eval/tests/png_fixtures.py。搬過來是因為 providers/dryrun.py
# 需要寫圖 —— production 程式碼 import 測試模組是相依方向錯誤，
# 測試可以依賴 production，反過來不行。
# png_fixtures.py 現在改為從這裡 re-export，既有測試不受影響。
# ---------------------------------------------------------------------------
import struct
import zlib


def _chunk(typ: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + typ + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))


def write_png_rgb(path, rgb: np.ndarray, filter_type: int = 0) -> None:
    """把 (H, W, 3) uint8 陣列寫成 8-bit RGB PNG。

    filter_type 只支援 0（None）與 2（Up），足夠涵蓋測試需求。
    """
    rgb = np.asarray(rgb, dtype=np.uint8)
    assert rgb.ndim == 3 and rgb.shape[2] == 3, "需要 (H, W, 3)"
    h, w = rgb.shape[:2]

    raw = bytearray()
    prev = np.zeros((w * 3,), dtype=np.uint8)
    for y in range(h):
        line = rgb[y].reshape(-1)
        if filter_type == 0:
            enc = line
        elif filter_type == 2:
            enc = (line.astype(np.int32) - prev.astype(np.int32)) & 255
            enc = enc.astype(np.uint8)
        else:  # pragma: no cover - 測試不會走到
            raise ValueError(f"未支援的 filter_type: {filter_type}")
        raw.append(filter_type)
        raw.extend(enc.tobytes())
        prev = line

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n"
           + _chunk(b"IHDR", ihdr)
           + _chunk(b"IDAT", zlib.compress(bytes(raw)))
           + _chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)


def write_png_gray(path, gray: np.ndarray, filter_type: int = 0) -> None:
    """把 (H, W) uint8 灰階陣列以 RGB PNG 形式寫出（三通道相同值）。"""
    gray = np.asarray(gray, dtype=np.uint8)
    assert gray.ndim == 2, "需要 (H, W)"
    write_png_rgb(path, np.repeat(gray[:, :, None], 3, axis=2), filter_type)
