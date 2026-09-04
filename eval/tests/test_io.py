"""io 讀圖層的測試：可解析驗證 —— 寫進去什麼就該讀回什麼。"""
import numpy as np
import pytest

from eval.metrics import io as eio
from png_fixtures import write_png_gray, write_png_rgb


def test_read_png_rgb_round_trip(tmp_path):
    """寫入的像素值必須原封不動讀回。"""
    rng = np.random.default_rng(0)
    src = rng.integers(0, 256, size=(7, 11, 3), dtype=np.uint8)
    p = tmp_path / "rgb.png"
    write_png_rgb(p, src)

    got = eio.read_png_rgb(p)
    assert got.dtype == np.uint8
    assert got.shape == (7, 11, 3)
    np.testing.assert_array_equal(got, src)


def test_read_png_rgb_handles_up_filter(tmp_path):
    """PNG filter type 2（Up）也必須正確還原，證明沒有繞過解碼器。"""
    rng = np.random.default_rng(1)
    src = rng.integers(0, 256, size=(9, 5, 3), dtype=np.uint8)
    p = tmp_path / "up.png"
    write_png_rgb(p, src, filter_type=2)

    np.testing.assert_array_equal(eio.read_png_rgb(p), src)


def test_read_grayscale_is_rec601_luma(tmp_path):
    """灰階＝Rec.601 luma，純色塊有封閉解。"""
    src = np.zeros((4, 4, 3), dtype=np.uint8)
    src[:, :, 0] = 100
    src[:, :, 1] = 150
    src[:, :, 2] = 200
    p = tmp_path / "luma.png"
    write_png_rgb(p, src)

    expected = 0.299 * 100 + 0.587 * 150 + 0.114 * 200
    got = eio.read_grayscale(p)
    assert got.shape == (4, 4)
    assert got.dtype == np.float64
    np.testing.assert_allclose(got, expected)


def test_read_grayscale_of_gray_png_is_identity(tmp_path):
    """三通道相同時 luma 應等於原值（fog depth pass 就是這種圖）。"""
    src = np.arange(256, dtype=np.uint8).reshape(16, 16)
    p = tmp_path / "gray.png"
    write_png_gray(p, src)

    np.testing.assert_allclose(eio.read_grayscale(p), src.astype(np.float64))


def test_read_edge_map_dark_lines_are_edges(tmp_path):
    """hidden-line pass 是白底黑線 → 暗像素為邊。"""
    img = np.full((10, 10), 255, dtype=np.uint8)
    img[:, 4] = 0  # 一條垂直線
    p = tmp_path / "edge.png"
    write_png_gray(p, img)

    edge = eio.read_edge_map(p, threshold=128)
    assert edge.dtype == np.bool_
    assert edge[:, 4].all()
    assert not edge[:, [0, 1, 2, 3, 5, 6, 7, 8, 9]].any()


def test_read_edge_map_can_invert(tmp_path):
    """若素材是黑底白線，dark_is_edge=False 必須反過來。"""
    img = np.zeros((6, 6), dtype=np.uint8)
    img[2, :] = 255
    p = tmp_path / "inv.png"
    write_png_gray(p, img)

    edge = eio.read_edge_map(p, threshold=128, dark_is_edge=False)
    assert edge[2].all()
    assert edge.sum() == 6


def test_read_edge_map_threshold_is_strict_below(tmp_path):
    """門檻語意必須明確：dark_is_edge 時 luma < threshold 才算邊。"""
    img = np.array([[127, 128, 129]], dtype=np.uint8)
    p = tmp_path / "thr.png"
    write_png_gray(p, img)

    edge = eio.read_edge_map(p, threshold=128)
    np.testing.assert_array_equal(edge, np.array([[True, False, False]]))


def test_read_png_rgb_rejects_missing_file(tmp_path):
    with pytest.raises(FileNotFoundError):
        eio.read_png_rgb(tmp_path / "nope.png")
