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
    architech_render/net/digest_util
    architech_render/net/http_client
    architech_render/net/uploader
    architech_render/net/api_client
    architech_render/net/poller
    architech_render/jobs/local_index
    architech_render/net/cloud_backend
    architech_render/net/local_backend
    architech_render/ui/bridge
    architech_render/ui/dialog
    architech_render/config
  ].freeze

  FILES.each { |f| require File.join(ROOT, "#{f}.rb") }

  Config.apply!

  # 選擇並注入生成後端。邏輯在 Config.select_backend! ——
  # 那是唯一真實來源，測試呼叫的是同一個方法而不是複製一份。
  #
  # 優先本機生成（已在這台機器驗證可用），找不到 .venv-gen 才退回雲端。
  # bridge 刻意要求明確注入而非自己 defined? 偵測：
  # 介面不合會在載入期就爆，不是 render 跑到一半才炸。
  Config.select_backend!

  UI::Dialog.install_menu!
end
