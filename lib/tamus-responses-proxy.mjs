#!/usr/bin/env node

import http from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const HOST = process.env.TAMUS_PROXY_HOST || "127.0.0.1";
const PORT = Number(process.env.TAMUS_PROXY_PORT || "8765");
const UPSTREAM_BASE_URL = (
  process.env.TAMUS_UPSTREAM_BASE_URL || "https://chat-api.tamu.ai/api/v1"
).replace(/\/+$/, "");
const STATE_DIR = path.join(
  process.env.TAMUS_CODEX_HOME ||
    process.env.CODEX_HOME ||
    path.join(process.env.HOME || process.cwd(), ".codex"),
  "logs",
);
const PID_FILE = path.join(STATE_DIR, "tamus-responses-proxy.pid");
const SUPPORTED_MODEL_IDS = new Set([
  "protected.Claude 3.5 Haiku",
  "protected.Claude 3.5 Sonnet",
  "protected.Claude Sonnet 4.5",
  "protected.Claude-Haiku-4.5",
  "protected.gemini-2.0-flash",
  "protected.gemini-2.0-flash-lite",
  "protected.gemini-2.5-flash-lite",
  "protected.gpt-4.1",
  "protected.gpt-4o",
  "protected.gpt-5.1",
  "protected.gpt-5.2",
  "protected.llama3.2",
  "tamu-study-mode",
]);

function getApiKey() {
  return process.env.TAMUS_API_KEY || "";
}

function logLine(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function writePidFile() {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PID_FILE, `${process.pid}\n`);
}

function cleanupPidFile() {
  try {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
  } catch {}
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildUsage(usage) {
  if (!usage) {
    return {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    };
  }

  return {
    input_tokens: usage.prompt_tokens ?? 0,
    input_tokens_details: {
      cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    },
    output_tokens: usage.completion_tokens ?? 0,
    output_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    },
    total_tokens: usage.total_tokens ?? 0,
  };
}

function normalizeToolChoice(toolChoice) {
  if (toolChoice == null) {
    return undefined;
  }

  if (typeof toolChoice === "string") {
    return toolChoice;
  }

  if (toolChoice.type === "function" && toolChoice.function?.name) {
    return toolChoice;
  }

  if (toolChoice.type === "function" && toolChoice.name) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return undefined;
}

function translateTools(tools) {
  if (!Array.isArray(tools)) {
    return undefined;
  }

  const translated = tools
    .filter((tool) => tool?.type === "function" && tool.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.parameters || {
          type: "object",
          properties: {},
        },
      },
    }));

  return translated.length > 0 ? translated : undefined;
}

function translateContentPart(part) {
  if (!part || typeof part !== "object") {
    return null;
  }

  if (
    part.type === "input_text" ||
    part.type === "output_text" ||
    part.type === "summary_text" ||
    part.type === "text"
  ) {
    return {
      type: "text",
      text: typeof part.text === "string" ? part.text : "",
    };
  }

  if (
    (part.type === "input_image" || part.type === "image") &&
    typeof part.image_url === "string"
  ) {
    return {
      type: "image_url",
      image_url: { url: part.image_url },
    };
  }

  return null;
}

function buildChatContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts = content
    .map(translateContentPart)
    .filter((part) => part !== null);

  if (parts.length === 0) {
    return "";
  }

  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("\n\n");
  }

  return parts;
}

function translateMessageItem(item) {
  const role = item.role === "system" ? "developer" : item.role;

  if (!role) {
    return null;
  }

  return {
    role,
    content: buildChatContent(item.content),
  };
}

function stringifyToolOutput(output) {
  if (typeof output === "string") {
    return output;
  }

  return JSON.stringify(output ?? "");
}

function translateInputToMessages(body) {
  const messages = [];
  let pendingToolCalls = [];

  function flushPendingToolCalls() {
    if (pendingToolCalls.length === 0) {
      return;
    }

    messages.push({
      role: "assistant",
      content: "",
      tool_calls: pendingToolCalls,
    });
    pendingToolCalls = [];
  }

  if (typeof body.instructions === "string" && body.instructions.trim() !== "") {
    messages.push({
      role: "developer",
      content: body.instructions,
    });
  }

  const input = Array.isArray(body.input) ? body.input : [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (item.type === "message") {
      flushPendingToolCalls();
      const message = translateMessageItem(item);
      if (message) {
        messages.push(message);
      }
      continue;
    }

    if (item.type === "function_call") {
      pendingToolCalls.push({
        id: item.call_id || `call_${randomUUID()}`,
        type: "function",
        function: {
          name: item.name || "unknown_function",
          arguments: item.arguments || "{}",
        },
      });
      continue;
    }

    if (
      item.type === "function_call_output" ||
      item.type === "custom_tool_call_output"
    ) {
      flushPendingToolCalls();
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || `call_${randomUUID()}`,
        content: stringifyToolOutput(item.output),
      });
    }
  }

  flushPendingToolCalls();
  return messages;
}

function extractAssistantText(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }

  if (Array.isArray(message?.content)) {
    return message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n\n");
  }

  return "";
}

function buildBaseResponse(body, responseId) {
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress",
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    model: body.model,
    output: [],
    parallel_tool_calls: Boolean(body.parallel_tool_calls),
    previous_response_id: body.previous_response_id ?? null,
    reasoning:
      body.reasoning ?? {
        effort: null,
        summary: null,
      },
    store: Boolean(body.store),
    temperature: body.temperature ?? 1.0,
    text: body.text ?? { format: { type: "text" } },
    tool_choice: body.tool_choice ?? "auto",
    tools: Array.isArray(body.tools) ? body.tools : [],
    top_p: body.top_p ?? 1.0,
    truncation: body.truncation ?? "disabled",
    usage: null,
    user: body.user ?? null,
    metadata: body.metadata ?? {},
  };
}

function sendCompletedResponse(res, body, outputItems, usage) {
  const responseId = `resp_${randomUUID().replace(/-/g, "")}`;
  const base = buildBaseResponse(body, responseId);
  const responseCreated = { ...base };

  sseEvent(res, "response.created", {
    type: "response.created",
    response: responseCreated,
  });
  sseEvent(res, "response.in_progress", {
    type: "response.in_progress",
    response: responseCreated,
  });

  if (
    outputItems.length > 0 &&
    outputItems.every((item) => item.type === "function_call")
  ) {
    outputItems.forEach((item, outputIndex) => {
      sseEvent(res, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
      });
      sseEvent(res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      });
    });
  } else {
    const item =
      outputItems[0] || {
        id: `msg_${randomUUID().replace(/-/g, "")}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "", annotations: [] }],
      };
    const text =
      item.content?.find((part) => part.type === "output_text")?.text || "";

    sseEvent(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: item.id,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    });
    sseEvent(res, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: {
        type: "output_text",
        text: "",
        annotations: [],
      },
    });
    sseEvent(res, "response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    });
    sseEvent(res, "response.output_text.done", {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    });
    sseEvent(res, "response.content_part.done", {
      type: "response.content_part.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: {
        type: "output_text",
        text,
        annotations: [],
      },
    });
    sseEvent(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item,
    });
  }

  const completed = {
    ...base,
    status: "completed",
    completed_at: Math.floor(Date.now() / 1000),
    output: outputItems,
    usage,
  };
  sseEvent(res, "response.completed", {
    type: "response.completed",
    response: completed,
  });
  res.end();
}

function buildOutputItems(chatCompletion) {
  const choice = chatCompletion?.choices?.[0];
  const message = choice?.message || {};

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return message.tool_calls.map((toolCall) => ({
      id: `fc_${toolCall.id || randomUUID().replace(/-/g, "")}`,
      type: "function_call",
      status: "completed",
      call_id: toolCall.id || `call_${randomUUID().replace(/-/g, "")}`,
      name: toolCall.function?.name || "unknown_function",
      arguments: toolCall.function?.arguments || "{}",
    }));
  }

  const text = extractAssistantText(message);
  return [
    {
      id: `msg_${randomUUID().replace(/-/g, "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text,
          annotations: [],
        },
      ],
    },
  ];
}

function summarizeOutput(chatCompletion, outputItems) {
  const choice = chatCompletion?.choices?.[0];
  const message = choice?.message || {};
  const text = extractAssistantText(message);
  return {
    finish_reason: choice?.finish_reason ?? null,
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
    text_length: text.length,
    output_items: outputItems.length,
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function fetchUpstreamJson(pathname, init) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      status: 500,
      json: {
        error: {
          type: "api_key_missing",
          message: "Set TAMUS_API_KEY before using the TAMU proxy.",
        },
      },
    };
  }

  try {
    const response = await fetch(`${UPSTREAM_BASE_URL}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...(init?.headers || {}),
      },
    });

    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {
        error: {
          type: "upstream_invalid_json",
          message: text || "Upstream returned an empty body.",
        },
      };
    }

    return {
      ok: response.ok,
      status: response.status,
      json,
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      json: {
        error: {
          type: "upstream_connection_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}

async function handleResponses(req, res) {
  const startedAt = Date.now();
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    jsonResponse(res, 400, {
      error: {
        type: "invalid_json",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }

  const messages = translateInputToMessages(body);
  logLine(
    `request method=${req.method} path=${req.url} input_items=${Array.isArray(body.input) ? body.input.length : 0} messages=${messages.length}`,
  );
  const upstreamBody = {
    model: body.model,
    messages,
    stream: false,
  };

  const translatedTools = translateTools(body.tools);
  if (translatedTools) {
    upstreamBody.tools = translatedTools;
    const toolChoice = normalizeToolChoice(body.tool_choice);
    if (toolChoice !== undefined) {
      upstreamBody.tool_choice = toolChoice;
    }
  }

  if (typeof body.max_output_tokens === "number") {
    upstreamBody.max_tokens = body.max_output_tokens;
  }

  if (typeof body.temperature === "number") {
    upstreamBody.temperature = body.temperature;
  }

  if (typeof body.top_p === "number") {
    upstreamBody.top_p = body.top_p;
  }

  const upstream = await fetchUpstreamJson("/chat/completions", {
    method: "POST",
    body: JSON.stringify(upstreamBody),
  });

  if (!upstream.ok) {
    logLine(
      `upstream status=${upstream.status} path=/chat/completions duration_ms=${Date.now() - startedAt}`,
    );
    jsonResponse(res, upstream.status, upstream.json);
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const outputItems = buildOutputItems(upstream.json);
  const usage = buildUsage(upstream.json.usage);
  const outputSummary = summarizeOutput(upstream.json, outputItems);
  logLine(
    `upstream status=${upstream.status} path=/chat/completions output_items=${outputSummary.output_items} tool_calls=${outputSummary.tool_calls} text_length=${outputSummary.text_length} finish_reason=${outputSummary.finish_reason} duration_ms=${Date.now() - startedAt}`,
  );
  sendCompletedResponse(res, body, outputItems, usage);
}

async function handleModels(res) {
  const upstream = await fetchUpstreamJson("/models", { method: "GET" });
  if (upstream.ok && Array.isArray(upstream.json?.data)) {
    upstream.json = {
      ...upstream.json,
      data: upstream.json.data.filter((model) =>
        SUPPORTED_MODEL_IDS.has(model?.id),
      ),
    };
  }
  jsonResponse(res, upstream.status, upstream.json);
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    jsonResponse(res, 404, { error: { type: "not_found", message: "Not Found" } });
    return;
  }

  if (req.method === "GET" && req.url === "/healthz") {
    jsonResponse(res, 200, {
      ok: true,
      upstream_base_url: UPSTREAM_BASE_URL,
      has_api_key: Boolean(getApiKey()),
    });
    return;
  }

  if (
    req.method === "GET" &&
    (req.url === "/models" || req.url === "/v1/models")
  ) {
    await handleModels(res);
    return;
  }

  if (
    req.method === "POST" &&
    (req.url === "/responses" ||
      req.url === "/v1/responses" ||
      req.url === "/responses/compact" ||
      req.url === "/v1/responses/compact")
  ) {
    await handleResponses(req, res);
    return;
  }

  jsonResponse(res, 404, {
    error: {
      type: "not_found",
      message: `No proxy route for ${req.method} ${req.url}`,
    },
  });
});

server.listen(PORT, HOST, () => {
  writePidFile();
  logLine(
    `proxy_listening url=http://${HOST}:${PORT} upstream=${UPSTREAM_BASE_URL} pid=${process.pid}`,
  );
});

["SIGINT", "SIGTERM", "exit"].forEach((signal) => {
  process.on(signal, () => {
    cleanupPidFile();
    if (signal !== "exit") {
      process.exit(0);
    }
  });
});
