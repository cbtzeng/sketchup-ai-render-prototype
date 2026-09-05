#!/usr/bin/env python3
"""單張生成入口，給 SketchUp 外掛呼叫。

    python -m eval.generate_one <job.json>

為什麼要獨立一支而不是重用 eval/run.py：
run.py 是跑批工具，它掃描目錄、比較條件、寫 manifest。
外掛要的是「這一組控制圖，生一張圖給我」——
硬把跑批工具塞進互動流程，會讓兩邊的需求互相牽制。

進度回報走檔案而不是 stdout：SketchUp 的 Ruby 沒有可靠的方式讀取
子行程的即時輸出（沒有原生執行緒可用），但它可以用 UI.start_timer
定期讀一個 JSON 檔。檔案是這兩個世界之間最不會出錯的介面。

job.json:
  {
    "prompt": "...", "negative_prompt": "...",
    "controls": {"edge": "/path/edge.png", "depth": "/path/depth.png"},
    "init_image": "/path/beauty.png",
    "weights": {"edge": 0.8, "depth": 0.5},
    "width": 640, "height": 640, "seed": 12345,
    "steps": 30, "cfg": 6.0, "denoise": 0.65,
    "output": "/path/result.png",
    "status": "/path/status.json"
  }
"""
from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path


def write_status(path: Path, **fields) -> None:
    """狀態寫檔採「先寫暫存再 rename」——
    rename 在同一個檔案系統上是原子操作，
    避免 Ruby 端剛好讀到寫到一半的 JSON 而解析失敗。"""
    tmp = path.with_suffix(".tmp")
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps(fields, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def main(argv=None) -> int:
    argv = argv or sys.argv[1:]
    if not argv:
        print("用法：python -m eval.generate_one <job.json>", file=sys.stderr)
        return 2

    spec = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    status_path = Path(spec["status"])
    t0 = time.time()

    try:
        write_status(status_path, state="loading", label="載入模型", elapsed_ms=0)

        # 延後匯入：torch 載入要好幾秒，狀態檔要先寫出去，
        # 否則外掛會有一段時間看不到任何進度而以為當掉了。
        from .providers.base import GenerationRequest
        from .providers.local import LocalProvider

        provider = LocalProvider(dtype=spec.get("dtype", "float32"))
        controls = {k: Path(v) for k, v in (spec.get("controls") or {}).items()}

        write_status(status_path, state="running",
                     label=f"生成中（{len(controls)} 個控制圖）",
                     elapsed_ms=int((time.time() - t0) * 1000))

        req = GenerationRequest(
            shot_id=spec.get("shot_id", "plugin"),
            condition=spec.get("condition", "C1"),
            prompt=spec["prompt"],
            negative_prompt=spec.get("negative_prompt", ""),
            seed=int(spec.get("seed", 0)),
            steps=int(spec.get("steps", 30)),
            cfg=float(spec.get("cfg", 6.0)),
            sampler=spec.get("sampler", "unipc"),
            denoise=float(spec.get("denoise", 0.65)),
            width=int(spec.get("width", 640)),
            height=int(spec.get("height", 640)),
            init_image=Path(spec["init_image"]),
            controls=controls,
            weights=spec.get("weights", {}),
        )

        out = Path(spec["output"])
        res = provider.generate(req, out)

        write_status(
            status_path, state="succeeded", label="完成",
            result=str(out), elapsed_ms=int((time.time() - t0) * 1000),
            latency_ms=res.latency_ms, device=res.raw.get("device"),
            controls=list(controls.keys()),
        )
        return 0

    except Exception as e:  # noqa: BLE001 —— 任何失敗都要讓外掛知道，不能靜默
        write_status(
            status_path, state="failed",
            label=f"{type(e).__name__}: {e}",
            error=str(e), traceback=traceback.format_exc()[-2000:],
            elapsed_ms=int((time.time() - t0) * 1000),
        )
        print(traceback.format_exc(), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
