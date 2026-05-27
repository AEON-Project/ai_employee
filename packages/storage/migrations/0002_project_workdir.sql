-- V1.1: 给项目加 workdir 字段（项目对应的本地代码仓库根目录绝对路径）
-- 用于待验收页面自动跑 git diff 展示真实改动
ALTER TABLE projects ADD COLUMN workdir TEXT;
