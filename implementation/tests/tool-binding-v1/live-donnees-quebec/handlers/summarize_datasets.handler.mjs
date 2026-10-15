import {
  ToubaHandlerError,
  defineTool,
} from "../../../../runtime/touba-handler-sdk/src/index.mjs";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

await defineTool({
  toolRef: "tool:examples.donnees_quebec_agent_live/SummarizeDatasets",
  requiredGrants: ["network", "secret_read"],
  requiredSecretHandles: ["OPENAI_API_KEY"],
  inputSignature: [{ name: "search", type_ref: "type:examples.donnees_quebec_agent_live/DonneesQuebecSearchResult" }],
  outputType: "type:examples.donnees_quebec_agent_live/DonneesQuebecAgentBrief",
  run: async ({ request: search, context }) => {
    validateSearchResult(search);

    if (search.mode === "dry_run") {
      return {
        mode: "dry_run",
        query: search.query,
        result_count: search.result_count,
        first_dataset_title: search.first_dataset_title,
        summary: `Dry-run brief for ${search.query}: ${search.result_count} matching dataset(s).`,
      };
    }

    const apiKey = context.env.OPENAI_API_KEY;
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new ToubaHandlerError("MissingSecretValue", "OPENAI_API_KEY is not available to the handler");
    }

    const summary = await summarizeWithOpenAI(search, apiKey);
    return {
      mode: "live",
      query: search.query,
      result_count: search.result_count,
      first_dataset_title: search.first_dataset_title,
      summary,
    };
  },
});

function validateSearchResult(search) {
  if (!search || typeof search !== "object" || Array.isArray(search)) {
    throw new ToubaHandlerError("InvalidArguments", "search must be an object");
  }
  for (const field of ["mode", "api_url", "query", "first_dataset_title", "llm_model"]) {
    if (typeof search[field] !== "string") {
      throw new ToubaHandlerError("InvalidArguments", `search.${field} must be a string`);
    }
  }
  if (!Number.isInteger(search.result_count) || search.result_count < 0) {
    throw new ToubaHandlerError("InvalidArguments", "search.result_count must be a non-negative integer");
  }
}

async function summarizeWithOpenAI(search, apiKey) {
  const body = {
    model: search.llm_model,
    instructions: [
      "Summarize the supplied public dataset search results.",
      "Answer in one short French sentence.",
      "Do not invent data that is absent from the payload.",
    ].join(" "),
    input: [
      `Données Québec query: ${search.query}`,
      `Result count: ${search.result_count}`,
      `First title: ${search.first_dataset_title || "(no title)"}`,
      `API URL: ${search.api_url}`,
    ].join("\n"),
    max_output_tokens: 120,
    store: false,
  };

  let response;
  try {
    response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new ToubaHandlerError("OpenAIRequestFailed", `OpenAI request failed: ${error.message}`);
  }

  if (!response.ok) {
    throw new ToubaHandlerError("OpenAIHttpError", `OpenAI returned HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ToubaHandlerError("OpenAIInvalidJson", `OpenAI returned invalid JSON: ${error.message}`);
  }

  if (payload.status !== "completed" || payload.error != null || payload.incomplete_details != null) {
    throw new ToubaHandlerError("OpenAIIncompleteOutput", "OpenAI did not complete the summary");
  }
  const outputText = extractOutputText(payload).trim();
  if (outputText === "") {
    throw new ToubaHandlerError("OpenAIEmptyOutput", "OpenAI response did not contain output text");
  }
  return outputText;
}

function extractOutputText(payload) {
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  const texts = [];
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        texts.push(content.text);
      }
    }
  }
  return texts.join("\n");
}
