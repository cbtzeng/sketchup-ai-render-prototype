# frozen_string_literal: true

require File.join(File.dirname(__FILE__), 'bridge.rb')

module ArchitechRender
  # ⚠️ 見 bridge.rb 開頭的命名警告：這個 module 叫 UI，會遮蔽 SketchUp 的
  # 頂層 ::UI。本檔案裡凡是 SketchUp 的 UI 一律寫 `::UI`。
  module UI
    # ui/dialog.rb —— HtmlDialog 的生命週期。
    #
    # 只做四件事：建立視窗、掛上 Bridge、處理關閉、確保單例。
    # 任何跟前端溝通的邏輯都不在這裡（在 bridge.rb）——這是刻意的邊界，
    # 不然「開視窗」跟「傳資料」會纏在一起，兩邊都難改。
    module Dialog
      TITLE = 'Architech Render'

      # preferences_key 讓 SketchUp 幫我們記住視窗大小與位置。
      # 這是 HtmlDialog 相對 WebDialog 的既有好處，不用自己存。
      PREFERENCES_KEY = 'com.architech.render.panel'

      DEFAULT_WIDTH  = 420
      DEFAULT_HEIGHT = 760
      MIN_WIDTH      = 360
      MIN_HEIGHT     = 480

      # ui_assets 與 ui 是兄弟目錄
      ASSETS_DIR = File.expand_path(File.join(File.dirname(__FILE__), '..', 'ui_assets'))
      INDEX_HTML = File.join(ASSETS_DIR, 'index.html')

      class << self
        attr_reader :dialog
      end

      # 單例。第二次呼叫不會開第二個視窗，而是把既有的帶到前景。
      #
      # 為什麼要在意：使用者按兩下工具列圖示是很常見的事，
      # 兩個面板各自持有 Bridge 的 @dialog 會讓 emit 只送到其中一個，
      # 狀態列從此對不上——這種 bug 現場很難重現。
      def self.show
        if open?
          focus
          return @dialog
        end

        unless File.exist?(INDEX_HTML)
          message("找不到面板資源：#{INDEX_HTML}")
          return nil
        end

        @dialog = build
        Bridge.attach(@dialog)

        # set_on_closed 是 HtmlDialog 的既有 API（🟢）。用 respond_to? 保險，
        # 因為沒有它的話 Bridge 會一直抓著已關閉的視窗發 execute_script。
        if @dialog.respond_to?(:set_on_closed)
          @dialog.set_on_closed { on_closed }
        else
          Bridge.log(:warn, 'HtmlDialog#set_on_closed 不存在，關閉後無法清理 Bridge')
        end

        @dialog.set_file(INDEX_HTML)
        @dialog.show
        @dialog
      end

      def self.build
        ::UI::HtmlDialog.new(
          dialog_title:    TITLE,
          preferences_key: PREFERENCES_KEY,
          scrollable:      true,
          resizable:       true,
          width:           DEFAULT_WIDTH,
          height:          DEFAULT_HEIGHT,
          min_width:       MIN_WIDTH,
          min_height:      MIN_HEIGHT,
          style:           ::UI::HtmlDialog::STYLE_DIALOG
        )
      end

      def self.open?
        return false unless @dialog

        # visible? 在視窗被使用者關掉後回 false。若某個版本沒有這個方法，
        # 保守當成「開著」——寧可 focus 一個已關的視窗（無害），
        # 也不要開出第二個面板（會壞掉狀態列）。
        @dialog.respond_to?(:visible?) ? @dialog.visible? : true
      rescue StandardError
        false
      end

      def self.focus
        return unless @dialog

        # bring_to_front 是 HtmlDialog 的既有 API（🟢），但仍用 respond_to? 守著；
        # 沒有的話退而求其次重新 show 一次（同一個物件，不會產生第二個視窗）。
        if @dialog.respond_to?(:bring_to_front)
          @dialog.bring_to_front
        else
          @dialog.show
        end
      rescue StandardError => e
        Bridge.log(:warn, "focus 失敗: #{e.class}: #{e.message}")
      end

      def self.close
        @dialog.close if @dialog && @dialog.respond_to?(:close)
      rescue StandardError => e
        Bridge.log(:warn, "close 失敗: #{e.class}: #{e.message}")
      ensure
        on_closed
      end

      def self.toggle
        open? ? close : show
      end

      # 視窗關閉後 Bridge 必須放掉它。
      # spec 2.3：關閉面板不會取消雲端的 job——job 狀態存在雲端，
      # 所以這裡只解除橋接，不去中止任何進行中的工作。
      def self.on_closed
        Bridge.detach
        @dialog = nil
      end

      def self.message(text)
        if defined?(::UI) && ::UI.respond_to?(:messagebox)
          ::UI.messagebox(text)
        else
          puts "[ArchitechRender] #{text}"
        end
      end

      # 選單註冊。刻意**不**在檔案載入時自動執行——src/architech_render.rb
      # 的載入清單由主流程決定，這裡只提供一個冪等的入口讓它呼叫：
      #
      #   ArchitechRender::UI::Dialog.install_menu!
      #
      # 重複呼叫不會產生重複的選單項（SketchUp 沒有移除選單項的 API，
      # 一旦加重複了只能重開 SketchUp）。
      def self.install_menu!
        return false if @menu_installed
        return false unless defined?(::UI) && ::UI.respond_to?(:menu)

        ::UI.menu('Plugins').add_item('Architech Render…') { show }
        @menu_installed = true
        true
      rescue StandardError => e
        Bridge.log(:warn, "install_menu! 失敗: #{e.class}: #{e.message}")
        false
      end

      # 🔴 工具列圖示需要 16/24px 的 PNG 資源，本次沒有產生圖檔，
      # 所以不提供 install_toolbar!。要做的話 UI::Toolbar / UI::Command 的
      # `small_icon=` / `large_icon=` 需要實際檔案路徑，缺檔在某些平台會靜默失敗。
    end
  end
end
