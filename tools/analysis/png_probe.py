#!/usr/bin/env python3
"""最小 PNG 解碼器 + 取樣工具。純標準庫 + numpy，不需要 PIL。"""
import sys, zlib, struct
import numpy as np

def read_png(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n', f"not a png: {path}"
    pos, idat, pal, trns = 8, b'', None, None
    w = h = bitd = ctype = None
    while pos < len(d):
        ln, typ = struct.unpack('>I4s', d[pos:pos+8]); pos += 8
        data = d[pos:pos+ln]; pos += ln + 4
        if typ == b'IHDR':
            w, h, bitd, ctype, comp, filt, inter = struct.unpack('>IIBBBBB', data)
            assert inter == 0, "interlaced PNG 不支援"
        elif typ == b'PLTE': pal = np.frombuffer(data, np.uint8).reshape(-1, 3)
        elif typ == b'IDAT': idat += data
        elif typ == b'IEND': break
    assert bitd == 8, f"bit depth {bitd} 不支援"
    nch = {0:1, 2:3, 3:1, 4:2, 6:4}[ctype]
    raw = zlib.decompress(idat)
    stride = w * nch
    out = np.zeros((h, stride), np.uint8)
    prev = np.zeros(stride, np.uint8)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = np.frombuffer(raw[p:p+stride], np.uint8).astype(np.int32).copy(); p += stride
        if f == 1:
            for i in range(nch, stride): line[i] = (line[i] + line[i-nch]) & 255
        elif f == 2:
            line = (line + prev) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i-nch] if i >= nch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = int(line[i-nch]) if i >= nch else 0
                b = int(prev[i]); c = int(prev[i-nch]) if i >= nch else 0
                pp = a + b - c
                pa, pb, pc = abs(pp-a), abs(pp-b), abs(pp-c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        line = line.astype(np.uint8)
        out[y] = line; prev = line
    img = out.reshape(h, w, nch)
    if ctype == 3: img = pal[img[:, :, 0]]
    elif ctype == 0: img = np.repeat(img, 3, axis=2)
    elif ctype == 4: img = np.repeat(img[:, :, :1], 3, axis=2)
    elif ctype == 6: img = img[:, :, :3]
    return img

def luma(img):
    return (0.299*img[:,:,0] + 0.587*img[:,:,1] + 0.114*img[:,:,2])

def describe(path, patch=9):
    img = read_png(path); L = luma(img); h, w = L.shape
    c = patch // 2
    cy, cx = h//2, w//2
    center = L[cy-c:cy+c+1, cx-c:cx+c+1].mean()
    corners = [L[0:patch, 0:patch].mean(), L[0:patch, -patch:].mean(),
               L[-patch:, 0:patch].mean(), L[-patch:, -patch:].mean()]
    vals, counts = np.unique(L.round().astype(np.uint8), return_counts=True)
    top = sorted(zip(counts, vals), reverse=True)[:3]
    return dict(size=(w,h), center=round(float(center),1),
                corners=[round(float(x),1) for x in corners],
                mean=round(float(L.mean()),1), std=round(float(L.std()),1),
                top=[(int(v), int(c_)) for c_, v in top])

if __name__ == '__main__':
    import glob, os
    for p in sorted(sys.argv[1:]):
        try:
            d = describe(p)
            print(f"{os.path.basename(p):24s} {d['size'][0]}x{d['size'][1]:<5} "
                  f"center={d['center']:6.1f} mean={d['mean']:6.1f} std={d['std']:5.1f} "
                  f"corners={d['corners']} top={d['top']}")
        except Exception as e:
            print(f"{os.path.basename(p):24s} ERROR {type(e).__name__}: {e}")
