# frozen_string_literal: true

require 'json'

module ArchitechRender
  module Jobs
    # 把進行中的 job id 存進模型的 attribute dictionary。
    #
    # 這是 spec 驗收條件 F5（job 可恢復）的實作。存在模型裡而不是 Ruby 記憶體，
    # 所以關掉面板、甚至關掉 SketchUp 再開，都還找得回進行中的 job。
    #
    # 只存「指向雲端的指標」，不存狀態本身 ——
    # 狀態一律以雲端為準，本地推測是 bug 的來源。
    module LocalIndex
      DICT = 'ArchitechRender'
      KEY  = 'pending_jobs'
      MAX  = 20 # 避免無限累積；正常情況同時只會有 1 個

      module_function

      def record(model, job_id, request = {})
        return false unless model && job_id

        entries = pending(model)
        entries.reject! { |e| e['job_id'] == job_id }
        entries << {
          'job_id'     => job_id,
          'scene'      => request[:scene] || request['scene'],
          'prompt'     => truncate(request[:prompt] || request['prompt']),
          'created_at' => Time.now.to_i
        }
        write(model, entries.last(MAX))
        true
      end

      def forget(model, job_id)
        return false unless model && job_id
        write(model, pending(model).reject { |e| e['job_id'] == job_id })
        true
      end

      def pending(model)
        return [] unless model
        raw = model.get_attribute(DICT, KEY, nil)
        return [] if raw.nil? || raw.to_s.empty?
        parsed = JSON.parse(raw)
        parsed.is_a?(Array) ? parsed : []
      rescue JSON::ParserError
        # 資料壞掉時回空陣列而不是拋錯。這只是便利功能，
        # 不該因為它讓整個面板開不起來。
        []
      end

      def write(model, entries)
        model.set_attribute(DICT, KEY, JSON.generate(entries))
      rescue StandardError
        false
      end

      def truncate(text, limit = 120)
        return nil if text.nil?
        s = text.to_s
        s.length > limit ? "#{s[0, limit]}…" : s
      end
    end
  end
end
