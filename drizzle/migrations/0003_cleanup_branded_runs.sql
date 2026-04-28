-- 일회성 cleanup: brand 점수 체계 변경(2026-04-28) 후 기존 brand 명 검색 응답 데이터 일괄 삭제.
--
-- 대상: 모든 workspaces 의 brand prompt 응답 (prompt_text 가 brandConfig 의 brandName 또는 brandAliases 어느 하나라도 ILIKE 매칭).
-- 보존: 일반 검색 prompt 응답은 그대로 유지 (워크스페이스의 핵심 운영 데이터).
--
-- 멱등성: 한 번 적용 후 다시 실행되면 매칭 row 가 없어 삭제 0건. 안전.

DO $$
DECLARE
  ws RECORD;
  alias_text TEXT;
  pattern TEXT;
  deleted_total INT := 0;
  deleted_step INT;
BEGIN
  FOR ws IN SELECT id, brand_config FROM workspaces LOOP
    -- 1) brandName 매칭 runs 삭제
    IF ws.brand_config IS NOT NULL
      AND ws.brand_config ? 'brandName'
      AND TRIM(COALESCE(ws.brand_config->>'brandName', '')) <> ''
    THEN
      pattern := '%' || TRIM(ws.brand_config->>'brandName') || '%';
      DELETE FROM runs
      WHERE workspace_id = ws.id
        AND prompt_text ILIKE pattern;
      GET DIAGNOSTICS deleted_step = ROW_COUNT;
      deleted_total := deleted_total + deleted_step;
    END IF;

    -- 2) brandAliases (콤마/세미콜론/줄바꿈 구분) 각각 매칭 runs 삭제
    IF ws.brand_config IS NOT NULL
      AND ws.brand_config ? 'brandAliases'
      AND COALESCE(ws.brand_config->>'brandAliases', '') <> ''
    THEN
      FOR alias_text IN
        SELECT TRIM(BOTH FROM unnest(regexp_split_to_array(ws.brand_config->>'brandAliases', '[,;\n]+')))
      LOOP
        IF alias_text IS NOT NULL AND alias_text <> '' THEN
          pattern := '%' || alias_text || '%';
          DELETE FROM runs
          WHERE workspace_id = ws.id
            AND prompt_text ILIKE pattern;
          GET DIAGNOSTICS deleted_step = ROW_COUNT;
          deleted_total := deleted_total + deleted_step;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  RAISE NOTICE '[cleanup-branded-runs] 총 % 건 삭제됨', deleted_total;
END $$;
