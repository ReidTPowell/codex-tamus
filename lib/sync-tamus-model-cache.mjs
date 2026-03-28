#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..");

const codexHome =
  process.env.TAMUS_CODEX_HOME ||
  process.env.CODEX_HOME ||
  path.join(process.env.HOME || process.cwd(), ".codex");
const cachePath = path.join(codexHome, "models_cache.json");
const modelsPath = path.join(repoRoot, "models", "tamus-models.json");
const enabled = process.argv.includes("--enable");

const tamusModels = JSON.parse(readFileSync(modelsPath, "utf8"));
const tamusSlugs = new Set(tamusModels.map((model) => model.slug));

function fallbackTemplate() {
  return {
    slug: "protected.gpt-5.2",
    display_name: "protected.gpt-5.2",
    description: "TAMU protected GPT-5.2 via the local Responses proxy.",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      {
        effort: "low",
        description: "Balances speed with some reasoning; useful for straightforward queries and short explanations",
      },
      {
        effort: "medium",
        description: "Provides a solid balance of reasoning depth and latency for general-purpose tasks",
      },
      {
        effort: "high",
        description: "Maximizes reasoning depth for complex or ambiguous problems",
      },
      {
        effort: "xhigh",
        description: "Extra high reasoning for complex problems",
      },
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    availability_nux: null,
    upgrade: null,
    base_instructions:
      "You are Codex, a coding agent based on GPT-5. You and the user share the same workspace and collaborate to achieve the user's goals.",
    supports_reasoning_summaries: true,
    default_reasoning_summary: "auto",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    context_window: 272000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: false,
  };
}

function loadCache() {
  if (!existsSync(cachePath)) {
    return {
      fetched_at: new Date().toISOString(),
      etag: null,
      client_version: null,
      models: [],
    };
  }

  try {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return {
      fetched_at: new Date().toISOString(),
      etag: null,
      client_version: null,
      models: [],
    };
  }
}

function getTemplateModel(models) {
  if (!Array.isArray(models)) {
    return fallbackTemplate();
  }

  return (
    models.find((model) => model?.slug === "gpt-5.2") ||
    models.find((model) => model?.visibility === "list") ||
    models[0] ||
    fallbackTemplate()
  );
}

function buildCacheModel(template, spec) {
  return {
    ...template,
    slug: spec.slug,
    display_name: spec.display_name,
    description: spec.description,
    visibility: "list",
    supported_in_api: true,
    priority: spec.priority,
    availability_nux: null,
    upgrade: null,
  };
}

const cache = loadCache();
const originalModels = Array.isArray(cache.models) ? cache.models : [];
const nonTamusModels = originalModels.filter((model) => !tamusSlugs.has(model?.slug));
let nextModels = nonTamusModels;

if (enabled) {
  const template = getTemplateModel(originalModels);
  nextModels = [
    ...nonTamusModels,
    ...tamusModels.map((spec) => buildCacheModel(template, spec)),
  ];
}

if (JSON.stringify(nextModels) === JSON.stringify(originalModels)) {
  process.exit(0);
}

const nextCache = {
  ...cache,
  fetched_at: new Date().toISOString(),
  models: nextModels,
};

try {
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(nextCache, null, 2)}\n`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `Warning: failed to update TAMU model picker cache at ${cachePath}: ${detail}\n`,
  );
}
