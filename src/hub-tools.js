import {
  DEFAULT_FIND_LIMIT,
  LOG_PREFIX,
  MAX_DESCRIBE_TOOLS,
  MAX_FIND_LIMIT,
  MAX_RESULT_CHARS,
} from "./constants.js";
import { defaultRegistryGetter, readRegistrySnapshot, safeSlice } from "./registry.js";
import { isPlainObject, validateAgainstSchema } from "./schema-validator.js";
import { isExtensionEnabled, isExtensionWriteEnabled } from "./settings.js";

export const HUB_TOOL_NAMES = Object.freeze([
  "list_extensions",
  "find_tools",
  "describe_tools",
  "run_read_tool",
  "run_tool",
]);

function formatError(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function buildTruncatedEnvelope(toolId, serialized, previewLen, maxChars) {
  const preview = safeSlice(serialized, previewLen);
  return {
    tool: toolId,
    truncated: true,
    originalChars: serialized.length,
    maxChars,
    note: `Result truncated from ${serialized.length} to ${preview.length} characters.`,
    resultPreview: preview,
  };
}

export function finalizeToolResult(toolId, rawResult, maxChars = MAX_RESULT_CHARS) {
  const normalized = rawResult === undefined ? null : rawResult;
  let serialized;
  try {
    serialized = JSON.stringify(normalized);
  } catch (error) {
    return {
      tool: toolId,
      code: "serialization-error",
      error: `Tool "${toolId}" returned a non-JSON-serializable value: ${formatError(error)}`,
    };
  }
  if (serialized === undefined) {
    return { tool: toolId, result: null };
  }
  const fullEnvelope = { tool: toolId, result: normalized };
  if (JSON.stringify(fullEnvelope).length <= maxChars) {
    return fullEnvelope;
  }

  // Fit the entire JSON-serialized truncation envelope (including escaped quotes in resultPreview)
  // within maxChars when maxChars can hold the envelope overhead.
  const emptyEnvelope = buildTruncatedEnvelope(toolId, serialized, 0, maxChars);
  if (JSON.stringify(emptyEnvelope).length > maxChars) {
    return buildTruncatedEnvelope(toolId, serialized, Math.max(0, maxChars), maxChars);
  }

  let lo = 0;
  let hi = Math.min(serialized.length, maxChars);
  let best = emptyEnvelope;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = buildTruncatedEnvelope(toolId, serialized, mid, maxChars);
    if (JSON.stringify(candidate).length <= maxChars) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

async function invokeWithAttribution(tool, args, context) {
  let pending;
  if (typeof context?.asTokenUser === "function") {
    // Must stay synchronous inside asTokenUser; await returned Promise outside.
    pending = context.asTokenUser(() => tool.execute(args, context));
  } else {
    pending = tool.execute(args, context);
  }
  return await pending;
}

function matchesQuery(tool, query) {
  const tokens = String(query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = [
    tool.id,
    tool.name,
    tool.extensionKey,
    tool.extensionName,
    tool.description,
  ].join(" ").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function matchesExtensionFilter(ext, filter) {
  const needle = String(filter ?? "").trim().toLowerCase();
  if (!needle) return true;
  return ext.key.toLowerCase().includes(needle) || ext.name.toLowerCase().includes(needle);
}

export function createHubTools({
  extensionAPI,
  getRegistry = defaultRegistryGetter,
  maxResultChars = MAX_RESULT_CHARS,
  onSnapshot,
} = {}) {
  function getFreshSnapshot() {
    const snapshot = readRegistrySnapshot(getRegistry);
    try {
      onSnapshot?.(snapshot);
    } catch {
      // Snapshot observer must not break tool execution.
    }
    return snapshot;
  }

  function enabledExtensions(snapshot) {
    return snapshot.extensions.filter((ext) => isExtensionEnabled(extensionAPI, ext.key));
  }

  async function executeRegistryTool(args, context, { readOnlyOnly }) {
    const toolId = typeof args?.tool === "string" ? args.tool.trim() : "";
    if (!toolId) {
      return { tool: toolId, code: "invalid-tool-id", error: "tool id (<extKey>/<toolName>) is required." };
    }

    const snapshot = getFreshSnapshot();
    const tool = snapshot.toolsById.get(toolId);
    if (!tool) {
      return {
        tool: toolId,
        code: "tool-not-found",
        error: `Tool "${toolId}" was not found. Call list_extensions or find_tools to see available tools.`,
      };
    }

    if (!isExtensionEnabled(extensionAPI, tool.extensionKey)) {
      return {
        tool: toolId,
        code: "extension-disabled",
        error: `Extension "${tool.extensionName}" (${tool.extensionKey}) is disabled in Tool Hub settings.`,
      };
    }

    if (readOnlyOnly && !tool.readOnly) {
      return {
        tool: toolId,
        code: "read-only-required",
        error: `Tool "${toolId}" is not marked readOnly: true and cannot run through run_read_tool. Use run_tool on an edit-scoped connection if writing tools are allowed for ${tool.extensionKey}.`,
      };
    }

    if (!readOnlyOnly && !tool.readOnly && !isExtensionWriteEnabled(extensionAPI, tool.extensionKey)) {
      return {
        tool: toolId,
        code: "write-disabled",
        error: `Writing tools are disabled for "${tool.extensionName}" (${tool.extensionKey}). Enable "${tool.extensionName} — allow writing tools" in Tool Hub settings to run "${toolId}".`,
      };
    }

    const toolArgs = args?.args === undefined ? {} : args.args;
    if (!isPlainObject(toolArgs)) {
      return {
        tool: toolId,
        code: "validation-failed",
        error: `Invalid arguments for "${toolId}": args must be a plain object.`,
      };
    }

    let validation;
    try {
      validation = validateAgainstSchema(toolArgs, tool.parameters);
    } catch (error) {
      return {
        tool: toolId,
        code: "schema-error",
        error: `Parameter schema for "${toolId}" could not be validated: ${formatError(error)}`,
      };
    }
    if (!validation.valid) {
      return {
        tool: toolId,
        code: "validation-failed",
        error: `Arguments failed schema validation for "${toolId}": ${validation.errors.join("; ")}`,
        validationErrors: validation.errors,
      };
    }

    try {
      const rawResult = await invokeWithAttribution(tool, toolArgs, context);
      return finalizeToolResult(toolId, rawResult, maxResultChars);
    } catch (error) {
      return {
        tool: toolId,
        code: "execution-error",
        error: `Tool "${toolId}" threw an error: ${formatError(error)}`,
      };
    }
  }

  const list_extensions = {
    name: "list_extensions",
    scope: "read",
    description:
      "List enabled extensions in window.RoamExtensionTools with tool counts and summaries. Start here or with find_tools, then call describe_tools before running a tool.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler() {
      const snapshot = getFreshSnapshot();
      const enabled = enabledExtensions(snapshot);
      let totalTools = 0;
      const extensions = enabled.map((ext) => {
        totalTools += ext.toolCount;
        const row = {
          key: ext.key,
          name: ext.name,
          toolCount: ext.toolCount,
          readCount: ext.readCount,
          writeCount: ext.writeCount,
          writeEnabled: isExtensionWriteEnabled(extensionAPI, ext.key),
          summary: ext.summary,
        };
        if (ext.version) row.version = ext.version;
        if (ext.guide) row.guide = ext.guide;
        return row;
      });
      return {
        extensions,
        totalExtensions: extensions.length,
        totalTools,
      };
    },
  };

  const find_tools = {
    name: "find_tools",
    scope: "read",
    description:
      "Search enabled extension tools by extension or query (no schemas). Call describe_tools on 1-5 returned ids before calling run_read_tool or run_tool.",
    inputSchema: {
      type: "object",
      properties: {
        extension: {
          type: "string",
          description: "Optional extension key or name substring filter.",
        },
        query: {
          type: "string",
          description: "Optional keywords matched against tool id, name, description, and extension.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_FIND_LIMIT,
          description: `Max tools to return (1-${MAX_FIND_LIMIT}, default ${DEFAULT_FIND_LIMIT}).`,
        },
      },
      additionalProperties: false,
    },
    handler(args = {}) {
      const snapshot = getFreshSnapshot();
      const enabled = enabledExtensions(snapshot);
      const rawLimit = args?.limit;
      const limit = Number.isInteger(rawLimit)
        ? Math.max(1, Math.min(MAX_FIND_LIMIT, rawLimit))
        : DEFAULT_FIND_LIMIT;

      const matched = [];
      for (const ext of enabled) {
        if (args?.extension && !matchesExtensionFilter(ext, args.extension)) continue;
        const writeEnabled = isExtensionWriteEnabled(extensionAPI, ext.key);
        for (const tool of ext.tools) {
          if (args?.query && !matchesQuery(tool, args.query)) continue;
          matched.push({
            id: tool.id,
            extension: ext.key,
            extensionName: ext.name,
            name: tool.name,
            description: tool.shortDescription,
            readOnly: tool.readOnly,
            writeEnabled,
          });
        }
      }

      const slice = matched.slice(0, limit);
      const response = {
        tools: slice,
        totalMatched: matched.length,
        truncated: matched.length > slice.length,
      };
      const guides = {};
      for (const row of slice) {
        const ext = enabled.find((candidate) => candidate.key === row.extension);
        if (ext?.guide) guides[ext.key] = ext.guide;
      }
      if (Object.keys(guides).length > 0) response.guides = guides;
      return response;
    },
  };

  const describe_tools = {
    name: "describe_tools",
    scope: "read",
    description:
      "Return full descriptions and parameter schemas for 1-5 tool ids (<extKey>/<toolName>) from list_extensions or find_tools. Call before run_read_tool or run_tool.",
    inputSchema: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          minItems: 1,
          maxItems: MAX_DESCRIBE_TOOLS,
          items: { type: "string" },
          description: `1 to ${MAX_DESCRIBE_TOOLS} tool ids (<extKey>/<toolName>).`,
        },
      },
      required: ["tools"],
      additionalProperties: false,
    },
    handler(args = {}) {
      const requested = args?.tools;
      if (!Array.isArray(requested) || requested.length < 1 || requested.length > MAX_DESCRIBE_TOOLS) {
        return {
          error: `tools must be an array of 1 to ${MAX_DESCRIBE_TOOLS} tool ids.`,
        };
      }
      const snapshot = getFreshSnapshot();
      const tools = [];
      const errors = [];
      for (const rawId of requested) {
        const id = typeof rawId === "string" ? rawId.trim() : "";
        if (!id) {
          errors.push({ id: String(rawId ?? ""), error: "Tool id must be a non-empty string." });
          continue;
        }
        const tool = snapshot.toolsById.get(id);
        if (!tool) {
          errors.push({ id, error: "Tool not found." });
          continue;
        }
        if (!isExtensionEnabled(extensionAPI, tool.extensionKey)) {
          errors.push({ id, error: `Extension "${tool.extensionName}" (${tool.extensionKey}) is disabled.` });
          continue;
        }
        let safeParameters = tool.parameters;
        try {
          const serialized = JSON.stringify(tool.parameters);
          if (serialized && serialized.length > maxResultChars) {
            safeParameters = {
              _truncated: true,
              note: `Parameter schema exceeded ${maxResultChars} chars and was omitted.`,
            };
          }
        } catch {
          safeParameters = {
            _serializationError: true,
            note: "Parameter schema was not JSON-serializable.",
          };
        }
        tools.push({
          id: tool.id,
          extension: tool.extensionKey,
          extensionName: tool.extensionName,
          name: tool.name,
          description: tool.description,
          readOnly: tool.readOnly,
          writeEnabled: isExtensionWriteEnabled(extensionAPI, tool.extensionKey),
          parameters: safeParameters,
        });
      }
      const response = { tools };
      if (errors.length > 0) response.errors = errors;
      return response;
    },
  };

  const run_read_tool = {
    name: "run_read_tool",
    scope: "read",
    description:
      "Run one read-only extension tool (<extKey>/<toolName>). Call describe_tools first to inspect its parameters. Refuses non-read-only tools.",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "Tool id (<extKey>/<toolName>).",
        },
        args: {
          type: "object",
          description: "Tool arguments matching describe_tools parameters.",
        },
      },
      required: ["tool"],
      additionalProperties: false,
    },
    handler(args, context) {
      return executeRegistryTool(args, context, { readOnlyOnly: true });
    },
  };

  const run_tool = {
    name: "run_tool",
    scope: "edit",
    description:
      "Run one enabled extension tool (<extKey>/<toolName>), including writing tools when allowed in settings. Call describe_tools first to inspect its parameters.",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "Tool id (<extKey>/<toolName>).",
        },
        args: {
          type: "object",
          description: "Tool arguments matching describe_tools parameters.",
        },
      },
      required: ["tool"],
      additionalProperties: false,
    },
    handler(args, context) {
      return executeRegistryTool(args, context, { readOnlyOnly: false });
    },
  };

  return [list_extensions, find_tools, describe_tools, run_read_tool, run_tool];
}

export function registerHubTools(extensionAPI, tools) {
  const ai = extensionAPI?.ai;
  if (typeof ai?.addTool !== "function") {
    console.warn(`${LOG_PREFIX} extensionAPI.ai.addTool is unavailable in this Roam version.`);
    return () => {};
  }
  const registered = [];
  const removeRegistered = () => {
    for (const name of registered.splice(0).reverse()) {
      try {
        ai.removeTool?.({ name });
      } catch {
        // Roam also removes extension-scoped tools on unload.
      }
    }
  };
  try {
    for (const tool of tools) {
      ai.addTool({
        name: tool.name,
        description: tool.description,
        scope: tool.scope,
        inputSchema: tool.inputSchema,
        handler: tool.handler,
      });
      registered.push(tool.name);
    }
  } catch (error) {
    removeRegistered();
    throw error;
  }
  return removeRegistered;
}
