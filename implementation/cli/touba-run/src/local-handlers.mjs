export const LINEAR_FETCH_SOURCE_TOOL_REF = "tool:examples.linear_skill/FetchSource";
export const STRATEGY_APPLY_CHANGE_TOOL_REF = "tool:examples.strategy_agents/ApplyChange";

export const LOCAL_HANDLER_LIMITS = Object.freeze({
  maxSourceTextLength: 4096,
  maxChangeSummaryLength: 4096,
});

export function buildLocalToolHandlers(options = {}) {
  const handlers = {};

  if (Object.hasOwn(options, "linearSourceText")) {
    handlers[LINEAR_FETCH_SOURCE_TOOL_REF] = createLinearFetchSourceHandler(
      options.linearSourceText,
    );
  }

  if (Object.hasOwn(options, "changeSummary")) {
    handlers[STRATEGY_APPLY_CHANGE_TOOL_REF] = createApplyChangeHandler(options.changeSummary);
  }

  return handlers;
}

function createLinearFetchSourceHandler(sourceText) {
  return ({ toolRef }) => {
    if (toolRef !== LINEAR_FETCH_SOURCE_TOOL_REF) {
      throw new Error(`unsupported local tool ref ${toolRef}`);
    }

    return {
      content: normalizeSourceText(sourceText),
    };
  };
}

function normalizeSourceText(sourceText) {
  if (typeof sourceText !== "string" || sourceText.length === 0) {
    throw new Error("local source text must be a non-empty string");
  }

  if (sourceText.length > LOCAL_HANDLER_LIMITS.maxSourceTextLength) {
    throw new Error(
      `local source text exceeds ${LOCAL_HANDLER_LIMITS.maxSourceTextLength} characters`,
    );
  }

  return sourceText;
}

function createApplyChangeHandler(summary) {
  return ({ toolRef }) => {
    if (toolRef !== STRATEGY_APPLY_CHANGE_TOOL_REF) {
      throw new Error(`unsupported local tool ref ${toolRef}`);
    }

    return {
      summary: normalizeChangeSummary(summary),
    };
  };
}

function normalizeChangeSummary(summary) {
  if (typeof summary !== "string" || summary.length === 0) {
    throw new Error("local change summary must be a non-empty string");
  }

  if (summary.length > LOCAL_HANDLER_LIMITS.maxChangeSummaryLength) {
    throw new Error(
      `local change summary exceeds ${LOCAL_HANDLER_LIMITS.maxChangeSummaryLength} characters`,
    );
  }

  return summary;
}
