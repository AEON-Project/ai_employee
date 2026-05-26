/**
 * Spike 2: transformers.js + bge-small-zh-v1.5 在 Bun 下加载
 *
 * 目标：
 *   1) Bun runtime 能 import @xenova/transformers
 *   2) 从 HuggingFace 拉 bge-small-zh-v1.5（首次会下载 ~30MB）
 *   3) embed 一组中文样本，验证维度 = 512
 *   4) 验证相似句的余弦相似度高于不相关句
 */
import { pipeline, env } from '@xenova/transformers';

const t0 = Date.now();

// 把模型缓存放到 spike 目录里，方便看下载文件
env.cacheDir = './.models';
env.allowRemoteModels = true;

console.log('开始加载 bge-small-zh-v1.5（首次会下载 ~30MB）...');
const tLoad = Date.now();

let extractor;
try {
  extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5');
} catch (e) {
  console.error('FAIL: pipeline load', e);
  process.exit(1);
}
console.log(`✓ 模型加载耗时: ${Date.now() - tLoad}ms`);

const samples = [
  '我想要一份关于 React 的前端开发文档',     // A
  '帮我写一篇 React 组件开发教程',           // B (与 A 同义)
  '今天天气怎么样',                          // C (无关)
  '今天会下雨吗',                            // D (与 C 同义)
];

const tEmbed = Date.now();
const out = await extractor(samples, { pooling: 'mean', normalize: true });
console.log(`✓ 4 条文本 embed 耗时: ${Date.now() - tEmbed}ms`);

// transformers.js Tensor → 取 .data + 维度
const dims = out.dims;
console.log(`✓ 输出维度: [${dims.join(', ')}]`);

const dim = dims[dims.length - 1];
if (dim !== 512) {
  console.error(`FAIL: 期望 512 维，实际 ${dim}`);
  process.exit(1);
}

// 取每条的向量
function vec(i: number): Float32Array {
  const slice = out.data.slice(i * dim, (i + 1) * dim);
  return slice as Float32Array;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const vA = vec(0), vB = vec(1), vC = vec(2), vD = vec(3);

const simAB = cosine(vA, vB);
const simAC = cosine(vA, vC);
const simCD = cosine(vC, vD);
const simBD = cosine(vB, vD);

console.log('✓ 相似度矩阵:');
console.log(`  A-B (同义: 前端) = ${simAB.toFixed(4)}`);
console.log(`  C-D (同义: 天气) = ${simCD.toFixed(4)}`);
console.log(`  A-C (无关)       = ${simAC.toFixed(4)}`);
console.log(`  B-D (无关)       = ${simBD.toFixed(4)}`);

if (simAB <= simAC || simCD <= simBD) {
  console.error('FAIL: 同义句相似度未明显高于无关句');
  process.exit(1);
}

console.log(`\n=== PASS in ${Date.now() - t0}ms ===`);
