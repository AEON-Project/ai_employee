-- 0001_vec.sql
-- sqlite-vec 虚拟表（vec0）。维度 512 对应 bge-small-zh-v1.5。
-- drizzle 无法描述虚拟表，单独以 raw SQL migration 维护。
-- 检索范式：
--   SELECT c.*
--     FROM vec_chunks v
--     JOIN chunks c ON c.id = v.chunk_id
--    WHERE v.embedding MATCH ? AND k = 10
--    ORDER BY distance;

CREATE VIRTUAL TABLE `vec_chunks` USING vec0(
  embedding float[512],
  chunk_id  text
);
