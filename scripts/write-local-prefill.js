#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = process.cwd();
const ENV_PATH = resolve(ROOT, '.env.local');
const OUTPUT_PATHS = [
  resolve(ROOT, 'public', 'local-prefill.json'),
  resolve(ROOT, 'dist', 'local-prefill.json'),
];

function parseEnvFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}`);
  }

  const values = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function firstValue(env, ...keys) {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function firstNumber(env, ...keys) {
  const value = firstValue(env, ...keys);
  if (value === undefined) {
    return undefined;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined && entryValue !== '')
  );
}

if (!existsSync(ENV_PATH)) {
  // 无 .env.local（CI / 其他开发者 / 生产构建）时安全跳过，不报错
  console.log(JSON.stringify({ status: 'skipped', reason: '.env.local not found' }));
  process.exit(0);
}

const env = parseEnvFile(ENV_PATH);
const prefill = {
  llmApi: compactObject({
    provider: 'bailian',
    apiKey: firstValue(env, 'BAILIAN_API_KEY', 'VITE_BAILIAN_API_KEY'),
    model: firstValue(env, 'BAILIAN_MODEL', 'VITE_BAILIAN_MODEL') || 'qwen-plus',
  }),
  simultaneousInterpretation: compactObject({
    model:
      firstValue(env, 'VOLCENGINE_AST_MODEL_ID', 'VITE_VOLCENGINE_AST_MODEL_ID') ||
      'Doubao_scene_SLM_Doubao_SI_model2000000748711437826',
    translatedAudioDelayMs: firstNumber(
      env,
      'VOLCENGINE_AST_TRANSLATED_AUDIO_DELAY_MS',
      'VITE_VOLCENGINE_AST_TRANSLATED_AUDIO_DELAY_MS'
    ),
    credentials: compactObject({
      apiKey: firstValue(env, 'VOLCENGINE_AST_API_KEY', 'VITE_VOLCENGINE_AST_API_KEY'),
      appId: firstValue(env, 'VOLCENGINE_AST_APP_ID', 'VITE_VOLCENGINE_AST_APP_ID'),
      accessToken: firstValue(
        env,
        'VOLCENGINE_AST_ACCESS_TOKEN',
        'VITE_VOLCENGINE_AST_ACCESS_TOKEN'
      ),
      secretKey: firstValue(env, 'VOLCENGINE_AST_SECRET_KEY', 'VITE_VOLCENGINE_AST_SECRET_KEY'),
      resourceId:
        firstValue(env, 'VOLCENGINE_AST_RESOURCE_ID', 'VITE_VOLCENGINE_AST_RESOURCE_ID') ||
        'volc.service_type.10053',
    }),
  }),
};

for (const outputPath of OUTPUT_PATHS) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(prefill, null, 2)}\n`);
}

console.log(
  JSON.stringify(
    {
      status: 'ok',
      outputs: OUTPUT_PATHS.map((path) => path.replace(`${ROOT}/`, '')),
      keys: {
        llmApi: Object.keys(prefill.llmApi),
        simultaneousInterpretation: Object.keys(prefill.simultaneousInterpretation),
        credentials: Object.keys(prefill.simultaneousInterpretation.credentials || {}),
      },
    },
    null,
    2
  )
);
