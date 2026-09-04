"""Provider 介面。"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class GenerationRequest:
    """一次生成的完整輸入。

    這個物件會被序列化進結果的 metadata —— 報告的可重現性靠它。
    任何影響輸出的東西都必須在這裡，不能藏在呼叫端的區域變數裡。
    """
    shot_id: str
    condition: str
    prompt: str
    negative_prompt: str
    seed: int
    steps: int
    cfg: float
    sampler: str
    denoise: float
    width: int
    height: int
    init_image: Path                          # beauty pass，img2img 的底圖
    controls: dict = field(default_factory=dict)   # {"edge": Path, "depth": Path}
    weights: dict = field(default_factory=dict)    # {"edge": 0.8, "depth": 0.5}


@dataclass
class GenerationResult:
    output_path: Path
    latency_ms: int
    cost_usd: Optional[float]
    provider: str
    raw: dict = field(default_factory=dict)


class Provider:
    name = "base"

    def generate(self, req: GenerationRequest, out_path: Path) -> GenerationResult:
        raise NotImplementedError

    def estimate_cost_usd(self, req: GenerationRequest) -> Optional[float]:
        return None
