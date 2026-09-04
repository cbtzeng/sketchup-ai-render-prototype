# frozen_string_literal: true

require 'sketchup.rb'

module ArchitechRender
  ROOT = File.dirname(__FILE__)

  # 載入順序有相依：options_keys 必須最先（其餘模組都引用它的常數），
  # passes 依賴 options_keys，session 依賴前面全部。
  %w[
    architech_render/capture/options_keys
    architech_render/capture/view_state
    architech_render/capture/alignment
    architech_render/capture/passes
    architech_render/capture/session
  ].each { |f| require File.join(ROOT, "#{f}.rb") }
end
