"""生成 provider 的介面與實作。

刻意把 provider 抽成介面而不是直接呼叫 fal.ai：
fal.ai 的端點路徑、多 ControlNet 的參數名、webhook schema 目前**都沒有查證過**，
本專案有一條硬規則是「不確定就標記為待驗證，不要猜一個看起來合理的寫上去」。

因此預設是 DryRunProvider —— 它不連網、產出確定性的佔位圖，
讓整條分析管線（跑批 → 指標 → 統計 → 報告）在花任何一毛錢之前就能跑通。
先確認管線是對的，再去接真的 provider，這個順序不能反。
"""
from .base import Provider, GenerationRequest, GenerationResult
from .dryrun import DryRunProvider

__all__ = ["Provider", "GenerationRequest", "GenerationResult", "DryRunProvider", "get"]


def get(name: str) -> Provider:
    if name == "dryrun":
        return DryRunProvider()
    if name == "local":
        from .local import LocalProvider  # 延後匯入：沒裝 torch 時不該在載入期就爆
        return LocalProvider()
    if name == "fal":
        from .fal import FalProvider  # 延後匯入：沒設 key 時不該在載入期就爆
        return FalProvider()
    raise ValueError(f"未知的 provider：{name}（可用：dryrun, local, fal）")
