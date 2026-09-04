# frozen_string_literal: true
#
# Phase 1 尖刺 — HtmlDialog 的酬載上限與效能（可行性清單 4.4）
#
#   load '/Users/benson/sketch-up-202609/tools/spike/probe_dialog.rb'
#
# 為什麼要測：1024x1024 的 PNG 轉 base64 大約 1–2 MB。
# 如果 HtmlDialog 的橋接撐不住這個量級，預覽圖就必須改走 file:// 路徑，
# 這會改變 ui/bridge.rb 的介面設計。與其實作完才發現，不如先量。
#
# 這支會開一個視窗、非同步逐級加大酬載、跑完自動關閉。
# 不改動模型或顯示設定。中途卡住的話關掉視窗即可。

module ArchitechDialogProbe
  # 1KB → 8MB。1024² PNG 的 base64 約落在 1–2MB，所以重點在中段。
  SIZES = [1_000, 10_000, 100_000, 500_000, 1_000_000, 2_000_000, 4_000_000, 8_000_000].freeze
  WATCHDOG_SECONDS = 8

  HTML = <<~HTML
    <!doctype html><meta charset="utf-8">
    <style>
      body { font: 13px -apple-system, sans-serif; padding: 16px; }
      #log { white-space: pre; font-family: ui-monospace, monospace; font-size: 12px; }
    </style>
    <h3>HtmlDialog 酬載測試</h3>
    <div id="log">等待中…</div>
    <script>
      function log(s) { document.getElementById('log').textContent += "\\n" + s; }

      // Ruby → JS：Ruby 把字串塞進 execute_script，這裡回報實際收到幾個字元
      window.receiveFromRuby = function (s) {
        log("收到 " + s.length + " 字元");
        sketchup.probe_rb2js(String(s.length));
      };

      // JS → Ruby：這裡自己造字串送回去，測反方向
      window.sendToRuby = function (n) {
        var s = new Array(n + 1).join('a');
        log("送出 " + s.length + " 字元");
        sketchup.probe_js2rb(s);
      };
    </script>
  HTML

  def self.run
    @dialog = UI::HtmlDialog.new(
      dialog_title: 'Architech 酬載測試',
      width: 460, height: 320,
      style: UI::HtmlDialog::STYLE_DIALOG
    )
    @dialog.set_html(HTML)

    @queue    = SIZES.flat_map { |n| [[:rb2js, n], [:js2rb, n]] }
    @results  = []
    @t0       = nil
    @current  = nil
    @watchdog = nil

    @dialog.add_action_callback('probe_rb2js') do |_ctx, received_len|
      record(:rb2js, received_len.to_i)
      advance
    end

    @dialog.add_action_callback('probe_js2rb') do |_ctx, payload|
      record(:js2rb, payload.to_s.length)
      advance
    end

    @dialog.add_action_callback('ready') { |_ctx| advance }

    @dialog.set_on_closed { report('視窗被關閉') } if @dialog.respond_to?(:set_on_closed)
    @dialog.show

    # HtmlDialog 的 show 是非同步的，等 DOM 準備好再開始
    UI.start_timer(0.6, false) { advance }
    nil
  end

  def self.record(kind, actual_len)
    stop_watchdog
    expected = @current ? @current[1] : nil
    elapsed  = @t0 ? ((Time.now - @t0) * 1000).round : nil
    intact   = expected && actual_len == expected
    @results << { kind: kind, expected: expected, actual: actual_len,
                  ms: elapsed, intact: intact }
    mark = intact ? '完整' : "**截斷 #{actual_len}/#{expected}**"
    puts "  #{kind}  #{expected.to_s.rjust(9)} 字元  #{elapsed.to_s.rjust(6)} ms  #{mark}"
  end

  def self.advance
    return report('全部完成') if @queue.empty?

    @current = @queue.shift
    kind, n  = @current
    @t0      = Time.now
    start_watchdog(kind, n)

    case kind
    when :rb2js
      # 用純 'a' 避免任何跳脫字元的干擾 —— 我們要測的是傳輸量，不是跳脫
      @dialog.execute_script("window.receiveFromRuby('#{'a' * n}')")
    when :js2rb
      @dialog.execute_script("window.sendToRuby(#{n})")
    end
  end

  def self.start_watchdog(kind, n)
    @watchdog = UI.start_timer(WATCHDOG_SECONDS, false) do
      puts "  #{kind}  #{n.to_s.rjust(9)} 字元  逾時 —— 沒有收到回呼（超過 #{WATCHDOG_SECONDS}s）"
      @results << { kind: kind, expected: n, actual: nil, ms: nil, intact: false }
      report("在 #{kind} #{n} 字元處卡住")
    end
  end

  def self.stop_watchdog
    UI.stop_timer(@watchdog) if @watchdog
    @watchdog = nil
  end

  def self.report(reason)
    stop_watchdog
    @queue = []
    puts "\n===== HtmlDialog 酬載測試結束（#{reason}）====="
    ok = @results.select { |r| r[:intact] }
    puts "完整傳輸的最大值："
    %i[rb2js js2rb].each do |kind|
      best = ok.select { |r| r[:kind] == kind }.map { |r| r[:expected] }.max
      label = kind == :rb2js ? 'Ruby → JS' : 'JS → Ruby'
      if best
        puts "  #{label}：#{best} 字元（約 #{(best / 1024.0 / 1024).round(2)} MB）"
      else
        puts "  #{label}：沒有任何一級完整通過"
      end
    end
    puts "\n判讀："
    puts "  1024x1024 的 PNG 轉 base64 約 1–2 MB。"
    puts "  若兩個方向都能撐過 2,000,000 字元且耗時可接受 → 預覽圖可以走 base64。"
    puts "  否則 ui/bridge.rb 必須改用 file:// 路徑傳預覽圖。"
    @dialog.close if @dialog && @dialog.visible?
  rescue StandardError => e
    puts "！收尾時發生例外：#{e.class}: #{e.message}"
  end
end

puts "\n===== HtmlDialog 酬載測試 ====="
puts "會開一個視窗，逐級加大酬載，跑完自動關閉。"
puts "格式：方向  字元數  耗時  是否完整\n\n"
ArchitechDialogProbe.run
