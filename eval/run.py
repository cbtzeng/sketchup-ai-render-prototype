#!/usr/bin/env python3
"""評估跑批：把擷取到的控制圖送去生成，落地結果與 metadata。

用法
    python3 -m eval.run --provider dryrun                 # 不連網，驗證管線
    python3 -m eval.run --provider fal --confirm-spend    # 真的花錢

輸入佈局（由 SketchUp 端的 Capture::Session 產出後複製過來）
    eval/captures/<shot_id>/beauty.png
    eval/captures/<shot_id>/edge.png
    eval/captures/<shot_id>/depth.png
    eval/captures/<shot_id>/capture.json   ← 必須含 depth pass 的 fog_start_m / fog_end_m

輸出
    eval/out/<condition>/<shot_id>.png
    eval/out/manifest.json

為什麼預設是 dryrun：先把整條管線（跑批 → 指標 → 統計 → 報告）跑通，
再去接真的 provider。反過來的話，管線的 bug 會混在生成品質裡，分不清是誰的問題，
而且每次除錯都在燒錢。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

from .metrics.canny import CannyParams, run_canny
from .metrics.io import read_grayscale, write_png_gray
from .providers import get as get_provider
from .providers.base import GenerationRequest

ROOT = Path(__file__).resolve().parent
CAPTURES = ROOT / "captures"
OUT = ROOT / "out"


def load_config(path: Path) -> dict:
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def discover_shots(captures_dir: Path) -> list[dict]:
    """找出所有可用的 shot。缺檔的直接跳過並明講，不要靜默略過。"""
    shots = []
    if not captures_dir.is_dir():
        return shots
    for d in sorted(p for p in captures_dir.iterdir() if p.is_dir()):
        required = {n: d / f"{n}.png" for n in ("beauty", "edge", "depth")}
        missing = [n for n, p in required.items() if not p.exists()]
        meta_path = d / "capture.json"
        if missing:
            print(f"  跳過 {d.name}：缺少 {', '.join(missing)}", file=sys.stderr)
            continue
        if not meta_path.exists():
            print(f"  跳過 {d.name}：缺少 capture.json（沒有它就無法把灰階換算回公尺）",
                  file=sys.stderr)
            continue
        with meta_path.open(encoding="utf-8") as fh:
            meta = json.load(fh)
        shots.append({"id": d.name, "dir": d, "paths": required, "meta": meta})
    return shots


def build_canny_control(beauty: Path, dest: Path, params: dict) -> Path:
    """B 組的控制圖：對 beauty 截圖跑 Canny。

    這一組存在的意義是「外部工具用一張截圖就做得到的事」。
    所以刻意只吃 beauty，不碰 SketchUp 給的任何額外資訊。
    """
    grey = read_grayscale(str(beauty))
    cp = CannyParams(
        sigma=params.get("sigma", 1.4),
        low=params.get("low", 0.1),
        high=params.get("high", 0.2),
        threshold_mode=params.get("threshold_mode", "relative"),
    )
    edges = run_canny(grey, cp).edges
    dest.parent.mkdir(parents=True, exist_ok=True)
    write_png_gray(str(dest), (edges * 255).astype(np.uint8))
    return dest


def controls_for(condition: str, cfg: dict, shot: dict, work: Path) -> dict:
    spec = cfg["conditions"][condition]
    names = spec.get("controls", [])
    out = {}
    for name in names:
        if name == "canny_from_beauty":
            out["edge"] = build_canny_control(
                shot["paths"]["beauty"], work / f"{shot['id']}_canny.png", spec.get("canny", {})
            )
        elif name == "edge_hidden_line":
            out["edge"] = shot["paths"]["edge"]
        elif name in ("depth_linear_z", "depth_disparity"):
            # C1 送線性 z（就是 fog pass 原圖），C2 送轉成視差後的圖。
            # 哪一種對 ControlNet 較好是實驗問題，不是推導問題 —— 見 journal 003。
            if name == "depth_linear_z":
                out["depth"] = shot["paths"]["depth"]
            else:
                out["depth"] = build_disparity(shot, work / f"{shot['id']}_disparity.png")
        else:
            raise ValueError(f"未知的 control：{name}")
    return out


def build_disparity(shot: dict, dest: Path) -> Path:
    """把 fog 的線性 z 轉成視差域並正規化。

    ControlNet 的 depth adapter 多以 MiDaS 類的視差（≈1/z）訓練，
    直接餵線性 z 會讓近景被壓扁、遠景被拉伸。
    """
    from .metrics.depth_corr import (grey_to_metric_depth, metric_depth_to_disparity,
                                     minmax_normalize)

    m = shot["meta"]["passes"]["depth"]
    grey = read_grayscale(str(shot["paths"]["depth"]))
    z = grey_to_metric_depth(grey, m["fog_start_m"], m["fog_end_m"])
    disp = metric_depth_to_disparity(z)
    norm = minmax_normalize(disp)
    dest.parent.mkdir(parents=True, exist_ok=True)
    write_png_gray(str(dest), (norm * 255).astype(np.uint8))
    return dest


def prompt_for(shot: dict, cfg: dict) -> str:
    kind = "interior" if "interior" in shot["id"] else "exterior"
    return cfg["prompt"][kind]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="評估跑批")
    ap.add_argument("--provider", default="dryrun", help="dryrun（預設）或 fal")
    ap.add_argument("--config", default=str(ROOT / "config.json"))
    ap.add_argument("--captures", default=str(CAPTURES))
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--conditions", default=None, help="逗號分隔，預設跑 config 裡全部")
    ap.add_argument("--confirm-spend", action="store_true",
                    help="使用會計費的 provider 時必須明確加上，避免手滑")
    args = ap.parse_args(argv)

    cfg = load_config(Path(args.config))
    provider = get_provider(args.provider)

    if provider.name != "dryrun" and not args.confirm_spend:
        print("這個 provider 會計費。確認要跑的話請加 --confirm-spend。", file=sys.stderr)
        return 2

    shots = discover_shots(Path(args.captures))
    if not shots:
        print(f"在 {args.captures} 找不到任何完整的 shot。\n"
              f"請先在 SketchUp 端用 Capture::Session 產出控制圖，"
              f"或跑 python3 -m eval.make_synthetic_captures 產生合成資料驗證管線。",
              file=sys.stderr)
        return 1

    conditions = (args.conditions.split(",") if args.conditions
                  else list(cfg["conditions"].keys()))
    out_root = Path(args.out)
    work = out_root / "_work"
    budget = cfg["budget"]["max_usd_total"]

    manifest = {"config": cfg, "provider": provider.name, "runs": [],
                "started_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    spent = 0.0

    print(f"provider={provider.name}  shots={len(shots)}  conditions={conditions}")
    for shot in shots:
        for cond in conditions:
            spec = cfg["conditions"][cond]
            req = GenerationRequest(
                shot_id=shot["id"],
                condition=cond,
                prompt=prompt_for(shot, cfg),
                negative_prompt=cfg["prompt"]["negative"],
                seed=cfg["sampling"]["seed"],
                steps=cfg["sampling"]["steps"],
                cfg=cfg["sampling"]["cfg"],
                sampler=cfg["sampling"]["sampler"],
                denoise=cfg["sampling"]["denoise"],
                width=cfg["output"]["width"],
                height=cfg["output"]["height"],
                init_image=shot["paths"]["beauty"],
                controls=controls_for(cond, cfg, shot, work),
                weights=spec.get("weights", {}),
            )

            est = provider.estimate_cost_usd(req) or 0.0
            if spent + est > budget:
                print(f"！已達預算上限 US${budget}，在 {shot['id']}/{cond} 中止", file=sys.stderr)
                manifest["aborted"] = {"reason": "budget", "at": f"{shot['id']}/{cond}"}
                break

            dest = out_root / cond / f"{shot['id']}.png"
            res = provider.generate(req, dest)
            spent += res.cost_usd or 0.0

            manifest["runs"].append({
                "shot": shot["id"], "condition": cond,
                "output": str(dest.relative_to(out_root)),
                "controls": {k: str(v) for k, v in req.controls.items()},
                "weights": req.weights,
                "seed": req.seed,
                "latency_ms": res.latency_ms,
                "cost_usd": res.cost_usd,
                "capture_meta": shot["meta"],
            })
            print(f"  {shot['id']:34s} {cond:3s} {res.latency_ms:5d} ms  "
                  f"${res.cost_usd or 0:.4f}")

    manifest["total_cost_usd"] = round(spent, 4)
    out_root.mkdir(parents=True, exist_ok=True)
    with (out_root / "manifest.json").open("w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    print(f"\n共 {len(manifest['runs'])} 次生成，總成本 US${spent:.4f}")
    print(f"manifest：{out_root / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
