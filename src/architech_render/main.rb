# frozen_string_literal: true

module ArchitechRender
  ROOT = File.dirname(File.dirname(__FILE__)) unless defined?(ROOT)

  # 載入順序有相依：
  #   options_keys 最先（Phase 0 的實測產物，其餘模組都引用它的常數）
  #   net/errors 最先於 net/ 其他檔案
  #   cloud_backend 依賴 net/ 全部與 jobs/local_index
  #   config 依賴 net/（要設定它們的 class attribute）
  #   ui/ 最後
  FILES = %w[
    architech_render/capture/options_keys
    architech_render/capture/view_state
    architech_render/capture/alignment
    architech_render/capture/passes
    architech_render/capture/session
    architech_render/net/errors
    architech_render/net/http_client
    architech_render/net/uploader
    architech_render/net/api_client
    architech_render/net/poller
    architech_render/jobs/local_index
    architech_render/net/cloud_backend
    architech_render/config
    architech_render/ui/bridge
    architech_render/ui/dialog
  ].freeze

  FILES.each { |f| require File.join(ROOT, "#{f}.rb") }

  Config.apply!

  # 明確注入雲端後端。
  # bridge 刻意不用 defined? 偵測 net/ —— 它要求呼叫端明確注入，
  # 這樣介面不合會在載入期就爆，而不是 render 跑到一半才炸。
  # 注意：這裡的 UI 是 ArchitechRender::UI，不是 SketchUp 的頂層 ::UI。
  UI::Bridge.backend = Net::CloudBackend

  UI::Dialog.install_menu!
end
