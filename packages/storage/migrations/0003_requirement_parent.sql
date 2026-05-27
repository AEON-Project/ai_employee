-- V2 O3: 给 requirements 加 parent_requirement_id 字段
-- 用于 spawn_employee 系统 tool：员工召唤另一员工接子任务时
-- 子需求记录父引用，UI 能显示工单父子关系（"任务树"），
-- 引擎用它防递归（spawn 链深度 ≤ 1，子工单不能再 spawn）。
ALTER TABLE requirements ADD COLUMN parent_requirement_id TEXT REFERENCES requirements(id) ON DELETE SET NULL;
CREATE INDEX req_parent ON requirements(parent_requirement_id);
