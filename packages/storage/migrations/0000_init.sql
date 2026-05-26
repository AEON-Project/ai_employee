-- 0000_init.sql
-- V1.0 初始 schema：17 张标准表（vec_chunks 虚拟表见 0001_vec.sql）。

CREATE TABLE `projects` (
  `id`               text PRIMARY KEY NOT NULL,
  `name`             text NOT NULL,
  `description`      text NOT NULL DEFAULT '',
  `knowledge_status` text NOT NULL DEFAULT 'idle',
  `status`           text NOT NULL DEFAULT 'active',
  `created_at`       integer NOT NULL,
  `archived_at`      integer
);

CREATE TABLE `employees` (
  `id`                  text PRIMARY KEY NOT NULL,
  `name`                text NOT NULL,
  `avatar`              text,
  `role`                text NOT NULL,
  `persona`             text NOT NULL DEFAULT '',
  `model_provider`      text NOT NULL,
  `model_name`          text NOT NULL,
  `model_base_url`      text,
  `model_key_ref`       text NOT NULL,
  `model_temperature`   real DEFAULT 1.0,
  `model_max_tokens`    integer,
  `memory_style_text`   text NOT NULL DEFAULT '',
  `stats_json`          text,
  `status`              text NOT NULL DEFAULT 'active',
  `created_at`          integer NOT NULL,
  `archived_at`         integer
);

CREATE TABLE `skills` (
  `id`                  text PRIMARY KEY NOT NULL,
  `name`                text NOT NULL,
  `category`            text NOT NULL,
  `description`         text NOT NULL,
  `prompt_template`     text NOT NULL,
  `required_tools_json` text NOT NULL DEFAULT '[]',
  `examples_json`       text,
  `builtin`             integer NOT NULL DEFAULT 0,
  `created_at`          integer NOT NULL
);

CREATE TABLE `employee_skills` (
  `employee_id` text NOT NULL,
  `skill_id`    text NOT NULL,
  `order`       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`employee_id`, `skill_id`),
  FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`skill_id`)    REFERENCES `skills`(`id`)
);
CREATE INDEX `emp_skills_emp` ON `employee_skills` (`employee_id`);

CREATE TABLE `requirements` (
  `id`                text PRIMARY KEY NOT NULL,
  `title`             text NOT NULL,
  `description`       text NOT NULL,
  `project_id`        text,
  `assignee_id`       text,
  `priority`          text NOT NULL DEFAULT 'P1',
  `status`            text NOT NULL,
  `plan_json`         text,
  `deliverable_ref`   text,
  `budget_cap_json`   text NOT NULL,
  `created_at`        integer NOT NULL,
  `completed_at`     integer,
  FOREIGN KEY (`project_id`)  REFERENCES `projects`(`id`)  ON DELETE CASCADE,
  FOREIGN KEY (`assignee_id`) REFERENCES `employees`(`id`)
);
CREATE INDEX `req_proj`     ON `requirements` (`project_id`);
CREATE INDEX `req_assignee` ON `requirements` (`assignee_id`);
CREATE INDEX `req_status`   ON `requirements` (`status`);

CREATE TABLE `threads` (
  `id`             text PRIMARY KEY NOT NULL,
  `requirement_id` text NOT NULL,
  `created_at`     integer NOT NULL,
  FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `threads_req_unique` ON `threads` (`requirement_id`);

CREATE TABLE `messages` (
  `id`           text PRIMARY KEY NOT NULL,
  `thread_id`    text NOT NULL,
  `seq`          integer NOT NULL,
  `role`         text NOT NULL,
  `type`         text NOT NULL,
  `content_json` text NOT NULL,
  `tokens_json`  text,
  `created_at`   integer NOT NULL,
  FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `msg_thread_seq` ON `messages` (`thread_id`, `seq`);

CREATE TABLE `clarifications` (
  `id`                     text PRIMARY KEY NOT NULL,
  `requirement_id`         text NOT NULL,
  `round`                  integer NOT NULL,
  `trigger`                text NOT NULL,
  `employee_understanding` text,
  `proposed_plan_json`     text,
  `questions_json`         text NOT NULL,
  `resolved_at`            integer,
  `created_at`             integer NOT NULL,
  FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `clar_req_round` ON `clarifications` (`requirement_id`, `round`);

CREATE TABLE `reports` (
  `id`             text PRIMARY KEY NOT NULL,
  `requirement_id` text NOT NULL,
  `content_md`     text NOT NULL,
  `metrics_json`   text NOT NULL,
  `generated_by`   text NOT NULL DEFAULT 'auto',
  `created_at`     integer NOT NULL,
  FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `report_req` ON `reports` (`requirement_id`);

CREATE TABLE `conventions` (
  `id`          text PRIMARY KEY NOT NULL,
  `project_id`  text NOT NULL,
  `content`     text NOT NULL,
  `enforcement` text NOT NULL,
  `category`    text,
  `source`      text NOT NULL DEFAULT 'ui',
  `file_path`   text,
  `created_at`  integer NOT NULL,
  `updated_at`  integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
CREATE INDEX `conv_proj` ON `conventions` (`project_id`);

CREATE TABLE `memory_items` (
  `id`                     text PRIMARY KEY NOT NULL,
  `scope`                  text NOT NULL,
  `scope_id`               text NOT NULL,
  `kind`                   text NOT NULL,
  `content`                text NOT NULL,
  `source_requirement_id`  text,
  `hit_count`              integer NOT NULL DEFAULT 0,
  `last_hit_at`            integer,
  `importance_score`       real NOT NULL DEFAULT 0.5,
  `user_feedback`          text NOT NULL DEFAULT 'none',
  `pending_review`         integer NOT NULL DEFAULT 0,
  `archived`               integer NOT NULL DEFAULT 0,
  `created_at`             integer NOT NULL,
  FOREIGN KEY (`source_requirement_id`) REFERENCES `requirements`(`id`) ON DELETE SET NULL
);
CREATE INDEX `mem_scope` ON `memory_items` (`scope`, `scope_id`, `kind`, `archived`);

CREATE TABLE `runtime_state` (
  `requirement_id`     text PRIMARY KEY NOT NULL,
  `current_step`       integer NOT NULL DEFAULT 0,
  `history_summary`    text NOT NULL DEFAULT '',
  `budget_used_json`   text NOT NULL,
  `last_heartbeat_at`  integer NOT NULL,
  FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON DELETE CASCADE
);

CREATE TABLE `tools` (
  `id`                 text PRIMARY KEY NOT NULL,
  `name`               text NOT NULL UNIQUE,
  `description`        text NOT NULL,
  `input_schema_json`  text NOT NULL,
  `requires_auth`      integer NOT NULL DEFAULT 0,
  `builtin`            integer NOT NULL DEFAULT 1
);

CREATE TABLE `tool_grants` (
  `employee_id` text NOT NULL,
  `tool_id`     text NOT NULL,
  `granted_at`  integer NOT NULL,
  PRIMARY KEY (`employee_id`, `tool_id`),
  FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`tool_id`)     REFERENCES `tools`(`id`)     ON DELETE CASCADE
);

CREATE TABLE `credential_refs` (
  `id`           text PRIMARY KEY NOT NULL,
  `kind`         text NOT NULL,
  `keychain_key` text NOT NULL UNIQUE,
  `label`        text,
  `created_at`   integer NOT NULL
);

CREATE TABLE `tg_message_links` (
  `chat_id`    integer NOT NULL,
  `message_id` integer NOT NULL,
  `kind`       text NOT NULL,
  `ref_id`     text NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`chat_id`, `message_id`)
);
CREATE INDEX `tg_kind_ref` ON `tg_message_links` (`kind`, `ref_id`);

CREATE TABLE `chunks` (
  `id`          text PRIMARY KEY NOT NULL,
  `source_type` text NOT NULL,
  `source_id`   text NOT NULL,
  `chunk_idx`   integer NOT NULL,
  `content`     text NOT NULL,
  `tokens`      integer NOT NULL,
  `created_at`  integer NOT NULL
);
CREATE INDEX `chunks_source` ON `chunks` (`source_type`, `source_id`);
