-- V2 O4: 工单 checkpoint 快照表（baseline + manual）
-- 用于在 LLM 干坏事（包括非 git 项目改坏数据文件）时一键回滚。
--
-- 接单时引擎自动建 baseline；LLM 可调 checkpoint 系统 tool 主动建 manual snapshot；
-- 用户驳回时可选回滚到 baseline。
--
-- backend_kind:
--   - 'git'  : workdir 是 git 仓库，ref 存 commit sha（HEAD），revert = git reset --hard
--   - 'tar'  : workdir 非 git，ref 存相对路径 checkpoints/<reqId>/<id>.tar.gz
--   - 'none' : workdir 不存在 / 不可访问；只记录尝试痕迹，revert 时 no-op
CREATE TABLE checkpoints (
  id                   TEXT PRIMARY KEY,
  requirement_id       TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('baseline', 'manual')),
  label                TEXT NOT NULL,
  backend_kind         TEXT NOT NULL CHECK (backend_kind IN ('git', 'tar', 'none')),
  ref                  TEXT,
  workdir              TEXT,
  created_at           INTEGER NOT NULL
);
CREATE INDEX ckpt_req ON checkpoints(requirement_id, created_at);
