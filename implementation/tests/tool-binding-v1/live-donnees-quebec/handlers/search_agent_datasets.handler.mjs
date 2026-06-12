import {
  ToubaHandlerError,
  defineTool,
} from "../../../../runtime/touba-handler-sdk/src/index.mjs";

const DONNEES_QUEBEC_PACKAGE_SEARCH_URL =
  "https://www.donneesquebec.ca/recherche/api/3/action/package_search";

await defineTool({
  toolRef: "tool:examples.donnees_quebec_agent_live/SearchDatasets",
  requiredGrants: ["network"],
  inputSignature: [{ name: "request", type_ref: "type:examples.donnees_quebec_agent_live/DonneesQuebecAgentRequest" }],
  outputType: "type:examples.donnees_quebec_agent_live/DonneesQuebecSearchResult",
  run: async ({ request: sourceRequest }) => {
    validateSourceRequest(sourceRequest);

    if (sourceRequest.dry_run) {
      return {
        mode: "dry_run",
        api_url: DONNEES_QUEBEC_PACKAGE_SEARCH_URL,
        query: sourceRequest.query,
        result_count: 1,
        first_dataset_title: "Jeu de données de démonstration",
        llm_model: sourceRequest.llm_model,
      };
    }

    return await searchDonneesQuebec(sourceRequest);
  },
});

function validateSourceRequest(sourceRequest) {
  if (!sourceRequest || typeof sourceRequest.query !== "string" || sourceRequest.query.trim() === "") {
    throw new ToubaHandlerError("InvalidArguments", "request.query must be a non-empty string");
  }
  if (!Number.isInteger(sourceRequest.rows) || sourceRequest.rows < 1 || sourceRequest.rows > 10) {
    throw new ToubaHandlerError("InvalidArguments", "request.rows must be an integer between 1 and 10");
  }
  if (typeof sourceRequest.dry_run !== "boolean") {
    throw new ToubaHandlerError("InvalidArguments", "request.dry_run must be a boolean");
  }
  if (typeof sourceRequest.llm_model !== "string" || sourceRequest.llm_model.trim() === "") {
    throw new ToubaHandlerError("InvalidArguments", "request.llm_model must be a non-empty string");
  }
  if (typeof sourceRequest.goal !== "string" || sourceRequest.goal.trim() === "") {
    throw new ToubaHandlerError("InvalidArguments", "request.goal must be a non-empty string");
  }
}

async function searchDonneesQuebec(sourceRequest) {
  const url = new URL(DONNEES_QUEBEC_PACKAGE_SEARCH_URL);
  url.searchParams.set("q", sourceRequest.query);
  url.searchParams.set("rows", String(sourceRequest.rows));

  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new ToubaHandlerError(
      "NetworkRequestFailed",
      `Données Québec request failed: ${error.message}`,
    );
  }

  if (!response.ok) {
    throw new ToubaHandlerError("HttpRequestFailed", `Données Québec returned HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ToubaHandlerError(
      "InvalidApiJson",
      `Données Québec returned invalid JSON: ${error.message}`,
    );
  }

  if (payload.success !== true || typeof payload.result?.count !== "number") {
    throw new ToubaHandlerError(
      "InvalidApiPayload",
      "Données Québec package_search payload is missing success/result.count",
    );
  }

  const firstDataset = Array.isArray(payload.result.results) ? payload.result.results[0] : undefined;
  return {
    mode: "live",
    api_url: DONNEES_QUEBEC_PACKAGE_SEARCH_URL,
    query: sourceRequest.query,
    result_count: payload.result.count,
    first_dataset_title: typeof firstDataset?.title === "string" ? firstDataset.title : "",
    llm_model: sourceRequest.llm_model,
  };
}
