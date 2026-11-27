export const HUB_VERSION = "0.2.0";
export const LOG_PREFIX = "[roam-tool-hub]";
export const RUNTIME_VERSION_KEY = "__ROAM_TOOL_HUB_VERSION";

export const MAX_TOOL_DESCRIPTION_CHARS = 300;
export const MAX_SUMMARY_CHARS = 140;
export const MAX_DESCRIBE_TOOLS = 5;
export const DEFAULT_FIND_LIMIT = 25;
export const MAX_FIND_LIMIT = 100;
export const MAX_RESULT_CHARS = 40_000;

export const GUIDELINES_PAGE_TITLE = "roam/agent guidelines";
export const GUIDELINES_SUMMARY_THRESHOLD = 20;

export const INBOX_PAGE_TITLE = "roam/tool-hub/inbox";
export const INBOX_CALL_PREFIX = "rth-call";
export const INBOX_RESULT_PREFIX = "rth-result";
export const MAX_INBOX_HISTORY = 10;
export const MAX_INBOX_RESULT_CHARS = 35_000;

export const SETTING_IDS = Object.freeze({
  refreshButton: "refresh-extensions",
  guidelinesEnabled: "guidelines-index-enabled",
  guidelinesBlockUid: "guidelines-block-uid",
  cmdJBridgeEnabled: "cmd-j-bridge-enabled",
});
