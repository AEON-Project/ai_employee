-- V2 O5: 给 requirements 加 cron 字段，使其成为"定时模板"
-- cronSpec 非空 = 这个工单是模板，引擎不直接 dispatch，定时 tick 时创建 child 副本派给同员工
-- 支持简化 cron 语法：
--   "every 5 minutes" / "every 1 hour"
--   "daily 09:00"      (每天 9 点)
--   "weekly mon 09:00" (周一 9 点，mon|tue|wed|thu|fri|sat|sun)
ALTER TABLE requirements ADD COLUMN cron_spec TEXT;
ALTER TABLE requirements ADD COLUMN cron_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE requirements ADD COLUMN cron_last_run_at INTEGER;
CREATE INDEX req_cron ON requirements(cron_spec) WHERE cron_spec IS NOT NULL;
