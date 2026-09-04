#!/usr/bin/env python3
"""下載本機生成需要的模型。

選 SD1.5 而非 SDXL 的理由（時間壓力下的取捨，記錄在此以免日後困惑）：
  - 下載量約 7 GB 而非 13 GB
  - 在 MPS 上快得多
  - **多 ControlNet 疊加在 SD1.5 上是最成熟的組合** —— 這正是本專案要測的東西
  - 評估是 A/B/C 的**相對**比較，底模品質是受控變因，不是被測對象

代價：SD1.5 原生解析度是 512，我們跑 768。控制圖從 1024 下採樣。
這些都寫進 eval/config.json，報告中要說明。
之後要換 SDXL 只需改 config，程式碼不用動。
"""
import sys
from pathlib import Path

from huggingface_hub import snapshot_download

# ⚠️ allow_patterns 一定要窄。第一版寫成 ["*.safetensors","*.json","*.txt","*.bin"]
# 結果抓了 25 GB 而不是預估的 7 GB，原因是同時抓到三份重複的東西：
#   v1-5-pruned.safetensors        7.7 GB  單檔格式的完整 checkpoint，from_pretrained 用不到
#   v1-5-pruned-emaonly.safetensors 4.3 GB  同上
#   各元件的 .bin                   4.0 GB  與 .safetensors 是同一份權重的兩種格式
#   safety_checker/                 1.2 GB  我們傳 safety_checker=None，根本不載入
#
# diffusers 的 from_pretrained 只需要「元件子目錄的 .safetensors + config」。
# 所以改成正面表列要哪些子目錄，而不是負面表列排除什麼 ——
# 負面表列漏一項就會多好幾 GB，而且不會有任何警告。
SD15_ALLOW = [
    "model_index.json",
    "scheduler/*",
    "tokenizer/*",
    "text_encoder/config.json",
    "text_encoder/model.safetensors",
    "unet/config.json",
    "unet/diffusion_pytorch_model.safetensors",
    "vae/config.json",
    "vae/diffusion_pytorch_model.safetensors",
]
CONTROLNET_ALLOW = ["config.json", "diffusion_pytorch_model.safetensors"]

MODELS = [
    ("stable-diffusion-v1-5/stable-diffusion-v1-5", "底模（約 4.0 GB）", SD15_ALLOW),
    ("lllyasviel/control_v11p_sd15_canny",  "ControlNet：邊緣（約 1.3 GB）", CONTROLNET_ALLOW),
    ("lllyasviel/control_v11f1p_sd15_depth", "ControlNet：深度（約 1.3 GB）", CONTROLNET_ALLOW),
]
TOTAL_GB = 6.6

def main():
    import shutil
    free_gb = shutil.disk_usage(Path.home()).free / 1e9
    print(f"可用空間 {free_gb:.1f} GB，本次需要約 {TOTAL_GB} GB")
    if free_gb < TOTAL_GB * 2:
        print(f"！可用空間不足（建議至少 {TOTAL_GB * 2:.0f} GB，下載過程需要暫存）")
        return 2

    ok = True
    for repo, purpose, allow in MODELS:
        print(f"\n=== {purpose}：{repo} ===", flush=True)
        try:
            path = snapshot_download(repo_id=repo, allow_patterns=allow)
            size = sum(f.stat().st_size for f in Path(path).rglob("*") if f.is_file())
            print(f"OK  {size / 1e9:.2f} GB → {path}", flush=True)
        except Exception as e:
            ok = False
            print(f"失敗：{type(e).__name__}: {e}", flush=True)
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
