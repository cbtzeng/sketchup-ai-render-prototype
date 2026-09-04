---
branch: main
date: 2026-09-05
status: open
---

# SketchUp 的 stdlib 載入在同一台機器上出現兩種相反結果

## 觀察

同一台機器（SketchUp 2026 / Ruby 3.2.2 / macOS 15.7.1），兩次不同的 Ruby Console 執行：

**第一次** —— `probe_net.rb` 在 `require 'digest'` 直接失敗：

```
LoadError: cannot load such file -- digest.so
```

同一支腳本稍後 `require 'net/http'` 也失敗：

```
LoadError: cannot load such file -- socket.so
```

**第二次** —— `probe_stdlib.rb` 逐項 require，**全部成功**：

```
require 'digest'      OK
require 'digest/sha2' OK
require 'openssl'     OK
require 'socket'      OK
require 'net/http'    OK
```

且 `Digest::SHA256` 可用、`OpenSSL::Digest.digest('SHA256','abc')` 算出正確值。

## 我先前的錯誤

我在只有第一次觀察時，就把可行性清單 5.4 改成「**實測：完全不可用**」，
並斷言「`Sketchup::Http` 是唯一的網路選項，`NetHttpBackend` 已無存在意義」。

**那個結論下得太早。** 單一次觀察不足以支撐「完全不可用」這種絕對敘述，
尤其是在我當時已經知道「符號存在於二進位中」這個矛盾證據的情況下。
正確的做法是先重測、或至少把結論寫成「觀察到失敗，原因未明」。

## 目前掌握的事實

- Ruby 二進位中確實有 `Init_digest` / `Init_socket` / `Init_openssl` / `Init_zlib` 等符號。
- `lib/ruby` 目錄底下確實**沒有** `digest.so` / `socket.so` 這些檔案，
  只有 `debug.bundle` 與 `rbs_extension.bundle`。
- 兩種結果都真實發生過。

## 未解：為什麼會有兩種結果

尚未查明。可能方向（都未驗證）：

- 兩次執行之間 SketchUp 的載入狀態不同（某個內建擴充在其中一次已經先載入了這些）。
- RubyGems 的 `kernel_require` 在不同狀態下對靜態擴充的解析行為不同
  （兩次的 backtrace 都經過 `rubygems/core_ext/kernel_require.rb`）。
- 第一次執行時有其他外掛尚未完成載入。

**這件事要不要繼續追查，取決於它會不會咬人。** 見下方決定。

## 決定：不追查原因，改成執行期驗證

不論原因為何，處理方式是一樣的：**不做任何靜態假設，執行期實際驗證一次。**

`net/digest_util.rb` 已改為「真的算一次 sha256('abc') 並比對已知值」來挑後端，
而不是檢查常數存不存在 —— 常數檢查會被 autoload、部分載入、相依缺失騙過去，
而我們真正要問的問題只有一個：**這條路能不能算出正確的 SHA-256？**

三層候選依序實測：`digest` → `openssl` → 純 Ruby。
偵測過程記在 `detect_log`，後端落到純 Ruby 時看得出是哪一層失敗、為什麼。

效能差距使這件事值得認真對待：**2 MB 資料，原生實作 1 ms，純 Ruby 約 1.3 秒。**
差 1000 倍。三張 1024² 的控制圖若落到純 Ruby，就是 4 秒卡在主執行緒。

## 對網路層的影響

`Sketchup::Http` **一直都可用**（兩次執行都在），所以它仍是主要路徑，這點不變。

`NetHttpBackend` **保留**，但降級為「可能可用的後備」而非「確定的退路」。
若哪天要真的走它，必須在使用前實際發一個請求驗證，不能只看 `require` 有沒有成功。

## 給後續的教訓

這個專案的規則是「不臆造 API」。這次的失誤不是臆造，是**過度概括單一次觀察**——
同樣要避免。可行性清單的 🟢/🔴 標記應該要求「可重現」，
一次性的觀察頂多標 🟡 並註明樣本數。
