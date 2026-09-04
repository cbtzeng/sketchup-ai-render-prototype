# 多重控制圖 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 2 天內做出一個能從 SketchUp 擷取三張像素對齊的控制圖、送去 fal.ai 生成、並用 12 shots 量出「多重控制 vs 純 img2img vs 外部 Canny」結構保真度差異的原型與報告。

**Architecture:** 極薄 Ruby 層（多 pass 擷取 → 上傳 → 輪詢 → HtmlDialog）＋ Vercel 雲端（job 編排、金鑰保管、成本護欄）＋ Supabase（job 狀態與歷史）＋ fal.ai（多 ControlNet 生成）。評估在本機以 Python 跑，與外掛解耦。

**Tech Stack:** Ruby 3.2.2（SketchUp 2026 內建）· Node 20 / Vercel Functions · Supabase Postgres · fal.ai · Python 3（評估：numpy / scipy / opencv / Pillow）

**時間盒：** 2 天。交付形式 (b)：repo + 文件 + 評估報告。不做 RBZ、不做 demo 影片。

---

## 這份計畫的特殊約定：Phase 0 是硬性閘門

`docs/sketchup-api-feasibility.md` 中標 🔴 的三件事 —— rendering_options 的 key 名、
fog 的衰減語意、`write_image` 在寬高比不符時的取景行為 —— 目前**未經實機驗證**。

因此本計畫**不預先寫死這三者相關的程式碼**。Phase 0 的產物會被填進 Phase 1 的
`src/architech_render/capture/options_keys.rb`，其餘程式碼一律透過該檔取用 key，
不直接寫字串常數。這是 `CLAUDE.md` 第 1、2 條規則的具體落實。

任何人若在 Phase 0 完成前寫出 `ro["DisplayFog"] = true` 這種硬編字串，就是這份計畫的執行錯誤。

---

## File Structure

### Ruby 外掛（`src/`）

| 檔案 | 責任 | 依賴 |
|---|---|---|
| `architech_render.rb` | SketchupExtension 註冊入口 | — |
| `architech_render/main.rb` | menu / toolbar 掛載 | ui, capture |
| `architech_render/config.rb` | endpoint、版本、feature flag | — |
| `architech_render/capture/options_keys.rb` | **Phase 0 產物**：實測得到的 key 名常數與 fog 標定係數 | — |
| `architech_render/capture/view_state.rb` | camera / rendering_options / shadow_info 的 snapshot & restore | options_keys |
| `architech_render/capture/session.rb` | 擷取編排，`ensure` 保證還原 | view_state, passes, alignment |
| `architech_render/capture/alignment.rb` | 決定輸出尺寸與 camera.aspect_ratio，保證三 pass 對齊 | — |
| `architech_render/capture/pass_beauty.rb` | pass A | options_keys |
| `architech_render/capture/pass_edge.rb` | pass B | options_keys |
| `architech_render/capture/pass_depth.rb` | pass C（Phase 0 若否決 fog 則不建立此檔） | options_keys |
| `architech_render/net/api_client.rb` | create_job / get_job，純資料進出 | http |
| `architech_render/net/http.rb` | Sketchup::Http 薄封裝，含 net/http fallback | — |
| `architech_render/net/uploader.rb` | 取簽名 URL → PUT bytes → 驗 sha256 | http |
| `architech_render/net/poller.rb` | UI.start_timer 退避輪詢 | api_client |
| `architech_render/ui/dialog.rb` | HtmlDialog 生命週期 | — |
| `architech_render/ui/bridge.rb` | 唯一的前端↔Ruby 路由，統一錯誤包裝 | capture, net |
| `architech_render/ui_assets/index.html` `.css` `.js` | 面板前端 | — |

邊界檢查：`capture/` 不知道網路存在（輸出是本機檔案路徑 + metadata）；
`net/` 不知道 SketchUp 存在（輸入輸出都是純資料）；`ui/bridge.rb` 是唯一的縫。

### 雲端（`cloud/`）

| 檔案 | 責任 |
|---|---|
| `api/v1/uploads.ts` | 發簽名上傳 URL |
| `api/v1/jobs/index.ts` | POST 建 job（冪等） |
| `api/v1/jobs/[id].ts` | GET 查狀態 |
| `api/v1/hooks/fal.ts` | fal webhook 接收與簽章驗證 |
| `lib/job-service.ts` | **狀態機唯一的寫入者** |
| `lib/cost-guard.ts` | 解析度／每日上限／並發／去重 |
| `lib/preset-resolver.ts` | `{preset, fidelity}` → 實際模型與 controlnet 權重，帶版本 |
| `lib/providers/fal.ts` | `submit()` / `normalize()` |
| `lib/providers/types.ts` | ProviderAdapter 介面 |
| `lib/supabase.ts` | client 與型別 |
| `supabase/migrations/001_init.sql` | jobs / job_events / assets / usage_daily + RLS |

### 評估（`eval/`）

| 檔案 | 責任 |
|---|---|
| `eval/config.json` | 鎖定的全部變因（prompt、seed、模型、sampler…） |
| `eval/scenes/` | 6 個 .skp + 具名 Scene |
| `eval/run.py` | 依 config 跑 A/B/C 三條件，落地圖檔與 metadata |
| `eval/metrics/edge_f.py` | Canny → 2px 容差邊界配對 → ODS F1 |
| `eval/metrics/depth_corr.py` | scale-shift 對齊 → Spearman ρ + RMSE |
| `eval/stats.py` | 配對 bootstrap，回報 C−A / C−B 與 95% CI |
| `eval/report.md` | 最終報告 |

---

# Phase 0 — 可行性尖刺（Day 0 上午，硬性閘門）

**這一階段不寫任何產品程式碼。** 產物是三份填好的文件與一個常數檔。

### Task 0.1: 環境與 rendering_options dump

**Files:**
- Modify: `docs/open-questions.md`（Q9、Q10 的答案欄）

- [ ] **Step 1: 在 SketchUp Ruby Console 執行 V1 與 V2**

照 `.claude/skills/sketchup-api-verify/SKILL.md` 的 V1、V2 兩節。
V2 的第一行會先列出 `rendering_options` 實際支援的方法，**不要跳過那一行**。

- [ ] **Step 2: 把完整 dump 貼回 Q10**

預期：一份 `key<TAB>value` 的清單。之後所有 key 名以此為準。

- [ ] **Step 3: 確認 dump 中確實存在 fog 相關 key**

若找不到任何與 fog／霧相關的 key，Phase 0 直接判定 fog 路線不可行，跳到 Task 0.4 的分支 B。

- [ ] **Step 4: Commit**

```bash
git add docs/open-questions.md
git commit -m "docs(spike): 回填 rendering_options 實機 dump"
```

### Task 0.2: write_image 寬高比行為

**Files:**
- Modify: `docs/open-questions.md`（Q11）
- Create: `docs/journal/main/002-write-image-對齊方案.md`

- [ ] **Step 1: 執行 skill 的 V3**

產出 `ar_default.png` 與 `ar_locked.png` 兩張，viewport 維持非 1:1。

- [ ] **Step 2: 判定行為**

三選一並記錄：裁切 / 加邊 / 重新取景。判定方法：在模型中放一個已知位置的物件，
看它在兩張圖中的相對位置是否改變。

- [ ] **Step 3: 決定對齊策略**

- 若鎖 `camera.aspect_ratio` 後行為變成可預測 → 策略 A：三 pass 前統一設定 aspect_ratio，
  輸出尺寸比例與之相符。
- 若無論如何都不可預測 → 策略 B：三 pass 一律輸出 `view.vpwidth × view.vpheight` 原生尺寸，
  放棄自訂解析度（會影響成本與品質，需記入報告）。

- [ ] **Step 4: 寫決策紀錄**

```bash
./tools/journal-new.sh "write_image 對齊方案"
```

內容必須包含兩張圖的比對結果與選定策略的理由。

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs(spike): write_image 寬高比行為與對齊策略"
```

### Task 0.3: fog 深度標定

**Files:**
- Create: `eval/scenes/_fog-calibration.skp`
- Modify: `docs/open-questions.md`（Q12）
- Create: `docs/journal/main/003-fog-標定結果.md`

- [ ] **Step 1: 建標定模型**

相機朝 +Y，在 1 / 2 / 5 / 10 / 20 / 50 m 各放一面 2×2 m 白色垂直牆，左右錯開不互相遮擋。

- [ ] **Step 2: 依 V4 的建議起始設定擷取，FogEndDist = 60**

- [ ] **Step 3: 重複一次，FogEndDist = 30**

兩組數字一起看才知道單位是什麼。只量一次看不出來。

- [ ] **Step 4: 讀出 12 個灰階值 + 2 個背景灰階值**

- [ ] **Step 5: 判定**

| 觀察 | 結論 | 後續 |
|---|---|---|
| 灰階對距離接近直線 | 線性可用 | 記錄斜率與截距，Task 0.4 分支 A |
| 很快飽和 | 指數 | 擬合成查表函數，仍走分支 A |
| 不單調 / 背景造成斷層 | 不可用 | Task 0.4 分支 B |

- [ ] **Step 6: 寫決策紀錄並 commit**

```bash
./tools/journal-new.sh "fog 標定結果"
git add docs/ eval/scenes/
git commit -m "docs(spike): fog 深度標定結果與判定"
```

### Task 0.4: 產出 options_keys.rb（閘門輸出）

**Files:**
- Create: `src/architech_render/capture/options_keys.rb`

- [ ] **Step 1: 依 Task 0.1–0.3 的實測結果建立常數檔**

結構固定如下，**值一律來自實測，不得憑印象填寫**：

```ruby
module ArchitechRender
  module Capture
    # 本檔所有常數皆來自 Phase 0 的實機驗證。
    # 來源：docs/open-questions.md Q10/Q11/Q12 與 docs/journal/main/002,003
    # 未經實測不得新增或修改本檔任何一行。
    module OptionsKeys
      # Task 0.1 的 dump 結果填入（範例格式，實際字串以 dump 為準）
      RENDER_MODE       = nil  # e.g. "RenderMode"
      TEXTURE           = nil
      DISPLAY_FOG       = nil
      FOG_COLOR         = nil
      FOG_START_DIST    = nil
      FOG_END_DIST      = nil
      FOG_USE_BK_COLOR  = nil

      # Task 0.2 的判定
      ALIGNMENT_STRATEGY = nil  # :lock_aspect_ratio | :native_viewport

      # Task 0.3 的標定
      FOG_USABLE   = nil  # true | false
      FOG_CURVE    = nil  # :linear | :exponential
      FOG_FIT      = nil  # 線性時 {slope:, intercept:}；指數時查表陣列
    end
  end
end
```

- [ ] **Step 2: 依 FOG_USABLE 決定架構分支**

- **分支 A（`FOG_USABLE == true`）**：三 pass，照原計畫進 Phase 1。
- **分支 B（`FOG_USABLE == false`）**：
  - Phase 1 不建立 `pass_depth.rb`，只做 beauty + hidden-line 兩 pass。
  - 評估的 C 組改為「beauty + hidden-line edge」雙控制。
  - GT-depth 改用 skill V5 的 raytest（64×64），**只當評估量尺，不當控制圖**。
  - `docs/spec.md` 的 H1 depth ρ 門檻刪除，只保留 Edge F-score。
  - `docs/critique.md` 第 2 點升級為「已證實的限制」。

- [ ] **Step 3: 更新可行性文件的信心標記**

把 `docs/sketchup-api-feasibility.md` 中 1.4、2.4、3.3–3.6 由 🔴 改為 🟢 或 🟡，附實測數字。

- [ ] **Step 4: Commit**

```bash
git add src/ docs/
git commit -m "feat(spike): 產出 options_keys.rb，鎖定架構分支"
```

**閘門判定：Task 0.4 未完成前，不得開始 Phase 1。**

---

# Phase 1 — 擷取流程（Day 0 下午）

> 本階段所有 rendering_options 存取一律經由 `OptionsKeys`，不得出現字串常數。

### Task 1.1: view_state 的 snapshot / restore

**Files:**
- Create: `src/architech_render/capture/view_state.rb`
- Test: `test/capture/view_state_test.rb`

- [ ] **Step 1: 寫失敗測試**

```ruby
require 'minitest/autorun'

class ViewStateTest < Minitest::Test
  def test_snapshot_then_restore_is_lossless
    model = Sketchup.active_model
    state = ArchitechRender::Capture::ViewState.snapshot(model)

    # 改動兩個已知 key
    model.rendering_options[ArchitechRender::Capture::OptionsKeys::DISPLAY_FOG] = true
    model.camera.aspect_ratio = 1.0

    ArchitechRender::Capture::ViewState.restore(model, state)

    diff = state.rendering_options.reject { |k, v| model.rendering_options[k] == v }
    assert_empty diff, "還原後不一致的 key: #{diff.keys.inspect}"
    assert_in_delta state.camera[:aspect_ratio], model.camera.aspect_ratio, 1e-9
  end

  def test_restore_runs_even_when_block_raises
    model = Sketchup.active_model
    before = {}
    model.rendering_options.each_pair { |k, v| before[k] = v }

    assert_raises(RuntimeError) do
      ArchitechRender::Capture::ViewState.with_temporary(model) do
        model.rendering_options[ArchitechRender::Capture::OptionsKeys::DISPLAY_FOG] = true
        raise "boom"
      end
    end

    diff = before.reject { |k, v| model.rendering_options[k] == v }
    assert_empty diff, "例外後未還原: #{diff.keys.inspect}"
  end
end
```

第二個測試是本專案最重要的一個測試：**擷取途中拋例外卻沒還原使用者的樣式設定，
比出圖失敗嚴重得多。**

- [ ] **Step 2: 執行測試確認失敗**

在 SketchUp Ruby Console：`load 'test/capture/view_state_test.rb'`
預期：`NameError: uninitialized constant ArchitechRender`

- [ ] **Step 3: 最小實作**

`ViewState.snapshot` 回傳一個 Struct（`rendering_options` Hash、`camera` Hash、`shadow_info` Hash）；
`restore` 逐 key 寫回；`with_temporary(model) { }` 用 `begin ... ensure restore ... end` 包住。

- [ ] **Step 4: 執行測試確認通過**

- [ ] **Step 5: Commit**

```bash
git add src/architech_render/capture/view_state.rb test/capture/view_state_test.rb
git commit -m "feat(capture): view_state snapshot/restore，含例外時保證還原"
```

### Task 1.2: alignment — 三 pass 像素對齊

**Files:**
- Create: `src/architech_render/capture/alignment.rb`
- Test: `test/capture/alignment_test.rb`

- [ ] **Step 1: 寫失敗測試**

```ruby
def test_all_passes_share_identical_geometry
  plan = ArchitechRender::Capture::Alignment.plan(Sketchup.active_model.active_view, 1024)
  assert_equal plan.width, plan.height
  assert_operator plan.width, :<=, 1536
end

def test_checkerboard_corners_align_across_passes
  # eval/scenes/_alignment-check.skp：已知位置的棋盤格
  paths = ArchitechRender::Capture::Session.new(Sketchup.active_model).run
  corners = paths.values.map { |p| detect_corners(p) }   # 8 個角點
  corners.combination(2) do |a, b|
    a.zip(b).each { |pa, pb| assert_in_delta pa[0], pb[0], 1.0; assert_in_delta pa[1], pb[1], 1.0 }
  end
end
```

第二個測試對應 `docs/spec.md` 的驗收條件 F1（角點誤差 ≤ 1 px）。
`detect_corners` 用 Python 側的 OpenCV 做，Ruby 只負責產圖 —— 這個測試以腳本形式跑，不在 Ruby 測試套件內。

- [ ] **Step 2: 執行確認失敗**
- [ ] **Step 3: 實作**

依 `OptionsKeys::ALIGNMENT_STRATEGY` 分支：`:lock_aspect_ratio` 時設定
`camera.aspect_ratio` 並回傳正方形尺寸；`:native_viewport` 時回傳 `vpwidth × vpheight`。

- [ ] **Step 4: 執行確認通過**
- [ ] **Step 5: Commit**

### Task 1.3–1.5: 三個 pass

**Files:**
- Create: `pass_beauty.rb` / `pass_edge.rb` / `pass_depth.rb`（分支 B 不建立 depth）
- Test: `test/capture/passes_test.rb`

每個 pass 的介面統一為 `.apply(model)`（設定 rendering_options）與 `.name`。
不負責寫檔 —— 寫檔由 session 統一處理，這樣三個 pass 必然共用同一組輸出參數。

每個 pass 各自的測試斷言：套用後，該 pass 關心的 key 值符合預期；不關心的 key 不被動到。

### Task 1.6: session 編排

**Files:**
- Create: `src/architech_render/capture/session.rb`
- Test: `test/capture/session_test.rb`

斷言：回傳三個（或分支 B 的兩個）存在且非空的檔案路徑；三檔尺寸相同；
執行後 `ViewState` 比對無差異；中途注入例外時仍還原。

### Task 1.7: 效能量測與閘門

- [ ] 依 skill V7 量三 pass 總耗時。
- [ ] 若 > 6 s：先降到 768 → 再改 beauty 用 viewport 原生尺寸 → 最後才砍 pass。
- [ ] 把實測值填進 `docs/spec.md` 4.2 並 commit。

---

# Phase 2 — 雲端最小路徑（Day 1 上午前半）

### Task 2.1: Supabase schema

**Files:**
- Create: `cloud/supabase/migrations/001_init.sql`

四張表照 `docs/architecture.md` 2.3 節。重點：
`job_events` append-only；`jobs.idempotency_key` 加 unique index；RLS 開啟。

驗證：`supabase db reset` 後跑一段 SQL，確認以他人 user_id 讀取會回 0 rows。

### Task 2.2: cost_guard

**Files:**
- Create: `cloud/lib/cost-guard.ts`
- Test: `cloud/lib/cost-guard.test.ts`

測試四條：解析度超限被擋、每日上限被擋（且 upsert 為 atomic）、
同 user 第二個 running job 回 409、相同 idempotency_key 回既有 job 而不重新計費。

### Task 2.3: job-service 狀態機

**Files:**
- Create: `cloud/lib/job-service.ts`
- Test: `cloud/lib/job-service.test.ts`

測試：合法轉移成功、非法轉移拋錯（例如 `succeeded → running`）、
每次轉移都寫一筆 `job_events`、終態不可再轉移。

### Task 2.4: fal adapter 與四個端點

**Files:**
- Create: `cloud/lib/providers/types.ts`, `cloud/lib/providers/fal.ts`
- Create: `cloud/api/v1/uploads.ts`, `jobs/index.ts`, `jobs/[id].ts`, `hooks/fal.ts`

`ProviderAdapter` 介面只有兩個方法：`submit(payload)` 與 `normalize(webhook)`。
只實作 fal。webhook 必須驗簽章 —— 未驗簽章的端點等於讓任何人改你的 job 狀態。

---

# Phase 3 — 串接與面板（Day 1 上午後半）

### Task 3.1: net 層

`http.rb` 先試 `Sketchup::Http::Request`，依 skill V8 的實測結果決定是否 fallback 到 `net/http`。
`uploader.rb` 上傳後**必須比對 sha256**，不能只看狀態碼。

### Task 3.2: poller

`UI.start_timer` 退避 2 → 5 → 10 s，上限 10 分鐘。狀態一律以雲端回傳為準。

### Task 3.3: HtmlDialog 面板

最小可用：prompt 輸入、Render 按鈕、狀態列、結果圖、錯誤訊息（含診斷碼）。
不做歷史紀錄分頁（列為加分項）。

### Task 3.4: job 可恢復（spec F5）

**Files:**
- Create: `src/architech_render/jobs/local_index.rb`

Ruby 端不維護 job 的真實狀態，只把 `job_id ↔ scene_name` 存進 model 的
attribute dictionary（跟著 .skp 走）。面板開啟時以此向雲端 reconcile。

- [ ] **Step 1: 寫失敗測試**

```ruby
def test_job_id_survives_dialog_close
  model = Sketchup.active_model
  ArchitechRender::Jobs::LocalIndex.record(model, "job-abc", "Scene 1")
  assert_equal [{"job_id" => "job-abc", "scene" => "Scene 1"}],
               ArchitechRender::Jobs::LocalIndex.pending(model)
end
```

- [ ] **Step 2: 執行確認失敗**
- [ ] **Step 3: 實作**（`model.attribute_dictionary("ArchitechRender", true)`）
- [ ] **Step 4: 執行確認通過**
- [ ] **Step 5: Commit**

### Task 3.5: 端到端手動驗收

- [ ] 按下 Render → 出圖，全程 UI 不凍結超過 500 ms。（spec F4）
- [ ] 中途拔網路 → 顯示明確錯誤，不計費，設定已還原。（spec F3）
- [ ] 連按兩次 Render → 只計費一次（冪等）。（spec F6）
- [ ] job 進行中關閉面板再重開 → 能看到該 job 並取回結果。（spec F5）
- [ ] job 進行中關閉並重開 SketchUp → 同上。（spec F5）

---

# Phase 4 — 評估與報告（Day 1 下午，不可砍）

### Task 4.1: 鎖定變因

**Files:** `eval/config.json`

prompt、negative prompt、seed、模型、sampler、steps、CFG、denoise、尺寸、
provider 端點版本、preset_version 全部寫死在此檔並 commit。

### Task 4.2: 6 個場景 × 2 相機

3 外觀（直角量體 / 曲面 / 大面積玻璃）+ 3 內裝（密集開口 / 細長構件 / 複雜家具），
各存 2 個具名 Scene。**不要 6 個都是方盒子 —— 那樣純 img2img 也不會出錯，測不出差異。**

### Task 4.3: 跑批

**Files:** `eval/run.py`

三條件 × 12 shots × 1 seed = 36 張。A = 純 img2img；
**B = img2img + 對 beauty 截圖跑的 Canny**；C = 多重控制。
B 組不可省略 —— 理由見 `.claude/skills/control-map-eval/SKILL.md`。

### Task 4.4: 指標

`edge_f.py`：Canny（參數固定並記錄）→ 2 px 容差邊界配對 → ODS F1。
`depth_corr.py`：單目深度 → 最小平方 scale-shift 對齊 → Spearman ρ + RMSE。
（分支 B 時 depth 指標改用 raytest GT，或整項刪除並在報告中說明。）

### Task 4.5: 統計

`stats.py`：對 shot 做 10,000 次 bootstrap，回報 **C−A 與 C−B 的配對差值與 95% CI**，
不是三組各自的平均值。12 shots 的 CI 會偏寬，報告中須明講。

### Task 4.6: 寫報告

**Files:** `eval/report.md`

必含：完整參數表、C−A 與 C−B 的配對差值 + CI、每 shot 的三聯圖、
**2–3 個 C 表現最差的失敗案例**、fal.ai 實測 p50/p95 與單張成本、
H1/H2 各自是否成立的明確結論句。

若 C 打不贏 B：照 open-questions Q8 的決定，誠實寫入並把論點改寫成
「護城河在語意遮罩與相機真值」。**不要調參數重跑到有優勢為止。**

### Task 4.7: 出 PDF

```bash
./tools/build-pdf.sh deliverable
```

---

## 若進度落後的砍除順序

1. 砍 HtmlDialog 的美觀度（能按能看結果就好）
2. 砍歷史紀錄、砍 cancel 端點
3. 場景 6 → 4（但兩類各留 2 個）
4. **絕不砍**：B 組對照、`ensure` 還原、失敗案例分析、配對 CI

前三項砍掉只是功能少；第四項砍掉會讓整份作業失去論點。
