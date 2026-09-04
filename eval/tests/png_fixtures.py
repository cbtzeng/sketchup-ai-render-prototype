"""測試用的最小 PNG 編碼器（純標準庫）。

只負責產生測試素材，不屬於評估流程本身。
刻意寫成 filter type 0（None）以外還能寫 filter type 2（Up），
用來驗證 `eval.metrics.io` 走的解碼器真的有處理 filter。
"""
import struct
import zlib

import numpy as np


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
