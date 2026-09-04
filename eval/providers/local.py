"""本機生成 provider：diffusers + Apple MPS。

為什麼走本機而不是託管 API（決策記錄）：
  1. **零 API 未知。** fal.ai 的端點路徑、多 ControlNet 參數結構、回應格式、
     webhook schema、計費單位五項都沒查證過，本專案的規則是不猜。
     本機生成讓這五項全部消失。
  2. **完全可重現。** 固定 seed、固定權重、固定版本。託管 API 的模型版本
     被對方換掉時你不會知道，而評估報告最需要的就是可重現。
  3. **可以自由重跑。** 找 C1 vs C2 哪個深度表示較好需要反覆試，
     每次都算錢會讓人不敢試。

代價：雲端那條路不會被這個流程跑過。那是刻意的取捨 ——
評估報告是交付物，雲端層有自己的 215 個測試。
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Optional

import numpy as np

from .base import GenerationRequest, GenerationResult, Provider


class LocalProvider(Provider):
    name = "local"

    # 模型 id 集中在這裡，換模型只改這幾行。
    BASE_MODEL = "stable-diffusion-v1-5/stable-diffusion-v1-5"
    CONTROLNETS = {
        "edge":  "lllyasviel/control_v11p_sd15_canny",
        "depth": "lllyasviel/control_v11f1p_sd15_depth",
    }

    def __init__(self, device: Optional[str] = None, dtype: str = "float32"):
        self.device = device or self._pick_device()
        # MPS 上 float16 有已知的數值問題（黑圖、NaN）。
        # float32 慢一些但穩定，48 張圖的批次量級下不值得為速度冒險。
        self.dtype = dtype
        # pipeline 之間共用同一組底模元件，所以快取多個 pipeline 是廉價的 ——
        # 記憶體都在 _components 與 _nets 裡，各只有一份。
        self._pipes: dict[tuple, object] = {}
        self._components = None
        self._nets: dict[str, object] = {}
        self._base_pipe = None

    @staticmethod
    def _pick_device() -> str:
        import torch
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"

    def _torch_dtype(self):
        import torch
        return {"float32": torch.float32, "float16": torch.float16}[self.dtype]

    def _base_components(self):
        """載入一次底模，之後所有 pipeline 共用這組元件。

        這是記憶體的關鍵。第一版依控制組合各建一個完整 pipeline 並快取，
        結果跑到第三個組合時 MPS 就 OOM（17.75 GiB / 上限 27.2 GiB）——
        因為記憶體裡同時躺著三份 SD1.5。跑批有 A/B/C1/C2 四個條件，
        會變成四份，必爆。

        但 UNet / VAE / text_encoder 在這四個 pipeline 之間**是同一份權重**，
        真正不同的只有 ControlNet（各 1.4 GB）。共用之後記憶體從
        「N × 完整模型」降到「1 × 底模 + N × ControlNet」。
        """
        if self._components is not None:
            return self._components

        from diffusers import StableDiffusionImg2ImgPipeline

        base = StableDiffusionImg2ImgPipeline.from_pretrained(
            self.BASE_MODEL,
            dtype=self._torch_dtype(),
            safety_checker=None,          # 建築圖不需要，載了只是佔記憶體
            requires_safety_checker=False,
        )
        self._components = {
            "vae": base.vae,
            "text_encoder": base.text_encoder,
            "tokenizer": base.tokenizer,
            "unet": base.unet,
            "scheduler": base.scheduler,
            "safety_checker": None,
            "feature_extractor": None,
            "requires_safety_checker": False,
        }
        self._base_pipe = base
        return self._components

    def _controlnet(self, name: str):
        """ControlNet 個別快取。兩個各 1.4 GB，重複載入沒有意義。"""
        if name not in self._nets:
            from diffusers import ControlNetModel
            self._nets[name] = ControlNetModel.from_pretrained(
                self.CONTROLNETS[name], dtype=self._torch_dtype()
            ).to(self.device)
        return self._nets[name]

    def _pipeline(self, control_names: tuple[str, ...]):
        if control_names in self._pipes:
            return self._pipes[control_names]

        from diffusers import (
            StableDiffusionControlNetImg2ImgPipeline,
            StableDiffusionImg2ImgPipeline,
            UniPCMultistepScheduler,
        )

        comps = self._base_components()

        if control_names:
            nets = [self._controlnet(n) for n in control_names]
            pipe = StableDiffusionControlNetImg2ImgPipeline(
                **comps, controlnet=nets if len(nets) > 1 else nets[0]
            )
        else:
            pipe = StableDiffusionImg2ImgPipeline(**comps)

        pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config)
        pipe = pipe.to(self.device)
        pipe.set_progress_bar_config(disable=True)

        # attention 的中間張量在 768x768 很大，切片後每張慢一點，
        # 但「慢一點」和「機器重開」不是同一個量級的代價。
        if hasattr(pipe, "enable_attention_slicing"):
            pipe.enable_attention_slicing("max")
        if hasattr(pipe, "enable_vae_slicing"):
            pipe.enable_vae_slicing()

        self._pipes[control_names] = pipe
        return pipe

    def generate(self, req: GenerationRequest, out_path: Path) -> GenerationResult:
        import torch
        from PIL import Image

        t0 = time.time()

        # controls 的順序必須固定，否則權重會對錯 controlnet。
        # 用排序而不是 dict 的插入順序 —— 後者依賴呼叫端的寫法，太脆弱。
        names = tuple(sorted(req.controls.keys()))

        init = Image.open(req.init_image).convert("RGB").resize(
            (req.width, req.height), Image.LANCZOS
        )
        control_images = [
            Image.open(req.controls[n]).convert("RGB").resize(
                (req.width, req.height), Image.LANCZOS
            )
            for n in names
        ]
        scales = [float(req.weights.get(n, 1.0)) for n in names]

        pipe = self._pipeline(names)
        generator = torch.Generator(device="cpu").manual_seed(req.seed)

        kwargs = dict(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt,
            image=init,
            strength=req.denoise,
            num_inference_steps=req.steps,
            guidance_scale=req.cfg,
            generator=generator,
        )
        if names:
            kwargs["control_image"] = control_images if len(control_images) > 1 else control_images[0]
            kwargs["controlnet_conditioning_scale"] = scales if len(scales) > 1 else scales[0]

        result = pipe(**kwargs)
        image = result.images[0]

        out_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(out_path)

        # MPS 的暫存配置不會自己還，跑批時會一路累積直到 OOM。
        if self.device == "mps" and hasattr(torch, "mps"):
            torch.mps.empty_cache()

        return GenerationResult(
            output_path=out_path,
            latency_ms=int((time.time() - t0) * 1000),
            cost_usd=0.0,
            provider=self.name,
            raw={
                "device": self.device,
                "dtype": self.dtype,
                "base_model": self.BASE_MODEL,
                "controls": list(names),
                "scales": scales,
            },
        )

    def estimate_cost_usd(self, req: GenerationRequest) -> float:
        return 0.0
