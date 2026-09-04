---
name: sketchup-api-verify
description: |
  Use whenever writing, reviewing, or reasoning about SketchUp Ruby API code in this repo —
  and ALWAYS before implementing anything that touches write_image, rendering_options,
  fog, camera aspect ratio, or Sketchup::Http. Enforces the project rule that API names and
  behaviours are never guessed: they are discovered on the real machine first and recorded.
  Also provides the Ruby Console verification snippets for docs/open-questions.md section B.
allowed-tools: Bash, Read, Write, Edit, Grep
---

# SketchUp API 驗證

## 唯一的鐵則

**不臆造 API。** 不確定的方法名、參數、key 名、回傳值，一律先在實機的 Ruby Console
問出來，再寫程式碼。猜一個看起來合理的名字寫上去，是這個專案最容易犯、也最貴的錯。

判斷標準：你能不能指著 `docs/sketchup-api-feasibility.md` 或某篇 journal，說「這個是我實測過的」？
不能，就先去測。

環境（已確認）：SketchUp 2026 · 26.2.242 · **Ruby 3.2.2** · macOS · universal。
注意 Ruby 3 的破壞性變更 —— 網路上的 SketchUp 範例多半是 Ruby 2.x 時代寫的。

## 先問，再用

任何物件都先這樣問，不要憑印象：

```ruby
obj = Sketchup.active_model.rendering_options
puts (obj.methods - Object.instance_methods).sort.inspect
```

---

## V1 — 環境確認

```ruby
puts "RUBY_VERSION = #{RUBY_VERSION}"
puts "SketchUp     = #{Sketchup.version} (#{Sketchup.version_number})"
puts "is64bit      = #{Sketchup.is_64bit?}" if Sketchup.respond_to?(:is_64bit?)
puts "temp_dir     = #{Sketchup.temp_dir}"  if Sketchup.respond_to?(:temp_dir)
```

## V2 — dump rendering_options（open-questions Q10）

**這份 dump 是之後所有 key 名的唯一來源。** 跑完把輸出整份貼進 Q10。

```ruby
ro = Sketchup.active_model.rendering_options

# 先看它支援哪些列舉方法，不要假設
puts "可用方法：#{(ro.methods - Object.instance_methods).sort.inspect}"
puts "-" * 60

if ro.respond_to?(:each_pair)
  ro.each_pair { |k, v| puts "#{k}\t#{v.inspect}" }
elsif ro.respond_to?(:each_key)
  ro.each_key { |k| puts "#{k}\t#{ro[k].inspect}" }
elsif ro.respond_to?(:keys)
  ro.keys.sort.each { |k| puts "#{k}\t#{ro[k].inspect}" }
else
  puts "！三種列舉方式都不支援，把上面的『可用方法』貼回來，我們再想辦法"
end
```

存成檔案比較好貼：

```ruby
path = File.join(Sketchup.temp_dir, "rendering_options.txt")
File.open(path, "w") { |f|
  ro.each_pair { |k, v| f.puts "#{k}\t#{v.inspect}" } if ro.respond_to?(:each_pair)
}
puts path
```

同樣方式 dump `Sketchup.active_model.shadow_info`。

## V3 — write_image 寬高比（open-questions Q11 · 最高風險）

這**不是可以選的設計**，是要量出來的事實。三個 pass 若沒像素對齊，
多重控制的結果可能比純 img2img 更差。

```ruby
model = Sketchup.active_model
view  = model.active_view
dir   = Sketchup.temp_dir

puts "viewport = #{view.vpwidth} x #{view.vpheight} (#{(view.vpwidth.to_f/view.vpheight).round(3)})"
puts "camera.aspect_ratio = #{view.camera.aspect_ratio.inspect}"

# A：不動 camera，直接要正方形
view.write_image(filename: File.join(dir, "ar_default.png"), width: 1024, height: 1024)

# B：先把 camera 鎖成 1:1 再要正方形
orig = view.camera.aspect_ratio
view.camera.aspect_ratio = 1.0
view.write_image(filename: File.join(dir, "ar_locked.png"), width: 1024, height: 1024)
view.camera.aspect_ratio = orig

puts dir
```

比對 A 和 B：**是被裁切、上下加邊、還是看到更多東西？** 把兩張圖一起回報。

> 實務上的收斂方向：與其去適應 `write_image` 的行為，不如**明確設定
> `camera.aspect_ratio` 並用相符的輸出比例**，讓這個問題不存在。但要先量過才知道這招有沒有用。

## V4 — fog 深度標定（open-questions Q12 · 決定 depth pass 存亡）

### 為什麼要標定

SketchUp Ruby API **沒有 depth buffer**，fog 是唯一的替代品。但：
- fog 衰減是線性還是指數 → 未知
- `FogStartDist` / `FogEndDist` 的單位與座標意義 → 未知
- ControlNet 的 depth adapter 期待的通常是**視差（≈1/z）**而非距離 z

三者任一不成立，fog 圖就是被扭曲的深度。**先標定，再決定要不要做。**

### 測試模型

新開一個 .skp，相機放原點朝 +Y，在 **1 / 2 / 5 / 10 / 20 / 50 公尺**各放一面
2×2 m 白色垂直牆面，彼此不遮擋（左右錯開或做成階梯）。存成 `eval/scenes/_fog-calibration.skp`。

### 建議起始設定

先用 V2 的 dump 確認 key 名，再照下面設。**這些是起點值，不是答案** ——
第一輪就是要看它們代表什麼。

| 設定 | 建議值 | 理由 |
|---|---|---|
| 霧開關 | on | |
| 霧色 | 純黑 `Sketchup::Color.new(0,0,0)` | 遠 = 暗，灰階單調遞增 |
| 「用背景色當霧色」 | off | 否則霧色被背景蓋掉，量不到 |
| FogStartDist | `0` | 讓斜率從相機起算，好擬合 |
| FogEndDist | `60`（m，略大於最遠牆） | 若 50 m 那面已全黑，代表單位不是公尺或非線性 |
| 邊線 | 關 | 黑線會污染灰階取樣 |
| 材質/貼圖 | 關，面設純白 | 只留深度訊號 |
| 陰影 | 關 | |
| 背景/天空 | 純白或純黑，記下是哪個 | 遠景斷層就從這裡來 |

### 回報

| 距離 (m) | 1 | 2 | 5 | 10 | 20 | 50 |
|---|---|---|---|---|---|---|
| 灰階 0–255 | | | | | | |

外加：背景灰階值、實際設的 Start/End、以及**你把 End 從 60 改成 30 之後灰階怎麼變**
（這一項最能看出單位到底是什麼）。

### 判讀

- 灰階對距離接近直線 → 線性，可用，只需做 z→視差 轉換。
- 灰階很快就飽和（例如 10 m 就全黑）→ 指數，需擬合成查表函數。
- 灰階不隨距離單調變化 → **fog 不能當深度，改走 V5。**

## V5 — 後備深度：raytest（fog 失敗時）

`view.pickray(x, y)` + `model.raytest(ray)` 給的是**物理正確的真深度**，
但每個像素一次 raytest，且跑在主執行緒。

用途定位：**不是生產用的控制圖，是評估用的量尺（GT-depth）。**
64×64 就足以算 Spearman ρ。先量它跑多久：

```ruby
require 'benchmark'
view = Sketchup.active_model.active_view
n = 64
t = Benchmark.realtime do
  n.times { |iy|
    n.times { |ix|
      x = (ix + 0.5) * view.vpwidth  / n
      y = (iy + 0.5) * view.vpheight / n
      ray = view.pickray(x, y)
      Sketchup.active_model.raytest(ray)
    }
  }
end
puts "#{n}x#{n} = #{n*n} rays in #{t.round(2)}s"
```

## V6 — 副作用（open-questions Q13）

```ruby
model = Sketchup.active_model
puts "改之前 modified? = #{model.modified?}"
before = {}
model.rendering_options.each_pair { |k, v| before[k] = v }

model.rendering_options["DisplayFog"] = true    # key 名以 V2 dump 為準

puts "改之後 modified? = #{model.modified?}"

model.rendering_options.each_pair { |k, v| before[k] = v if false }  # no-op
before.each { |k, v| model.rendering_options[k] = v }

diff = before.reject { |k, v| model.rendering_options[k] == v }
puts diff.empty? ? "還原完全一致" : "還原後不一致：#{diff.keys.inspect}"
puts "還原後 modified? = #{model.modified?}"
```

接著手動按 Ctrl+Z，看撤銷的是你自己的編輯，還是我們改的顯示設定。

**若 modified? 被設起、或 undo stack 被污染**（目前的假設就是會），
擷取流程必須額外處理，且要在 UI 上誠實告知。這是會被一星負評的等級。

## V7 — 效能預算（open-questions Q14）

目標（`docs/spec.md` 4.2）：三個 pass 1024×1024，**p50 ≤ 3 s、p95 ≤ 6 s**。

拆解：每個 pass ≈ 0.6–0.8 s（切設定 + 重繪 + 寫檔），三個約 2 s，留 1 s 給
設定切換與可能的 `view.refresh` 等待。

```ruby
require 'benchmark'
view = Sketchup.active_model.active_view
%w[beauty edge depth].each { |name|
  t = Benchmark.realtime {
    # …在此切換該 pass 的 rendering_options…
    view.refresh if view.respond_to?(:refresh)
    view.write_image(filename: File.join(Sketchup.temp_dir, "#{name}.png"), width: 1024, height: 1024)
  }
  puts "#{name}: #{t.round(2)}s"
}
```

**超過 6 s 的處置順序**：先降到 768×768 → 再考慮把 beauty pass 改用 viewport 原生尺寸
→ 最後才考慮砍 pass。不要為了省時間犧牲像素對齊。

## V8 — Sketchup::Http 二進位上傳（open-questions Q15）

```ruby
puts (Sketchup::Http::Request.instance_methods - Object.instance_methods).sort.inspect
```

先看它有哪些方法，再決定怎麼送。若二進位 body 會被破壞，
退路是 `require 'net/http'` —— bundle 內已確認含 OpenSSL 3.1.0。

驗證方式：送一個 500 KB 的 PNG，比對伺服器收到的 byte 數與 sha256 是否相符。
**「有回 200」不等於「檔案完整」。**

---

## 每次驗證完要做的事

1. 把結果填回 `docs/open-questions.md`。
2. 更新 `docs/sketchup-api-feasibility.md` 的信心標記（🔴 → 🟡 → 🟢），附上實測數字。
3. 若結果會改變架構（fog、對齊這兩項一定會），用 `./tools/journal-new.sh` 寫一篇決策紀錄。
