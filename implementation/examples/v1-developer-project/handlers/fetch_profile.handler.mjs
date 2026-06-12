const input = await readStdin();
const request = JSON.parse(input);

if (request.protocol !== "touba-tool-handler-v1") {
  respondError("InvalidProtocol", "unsupported handler protocol");
} else if (request.tool_ref !== "tool:examples.v1_developer_project/FetchProfile") {
  respondError("InvalidToolRef", "unexpected tool ref");
} else if (!request.secret_handles.includes("DEMO_API_KEY")) {
  respondError("MissingSecretHandle", "DEMO_API_KEY handle missing from request");
} else if (typeof process.env.DEMO_API_KEY !== "string" || process.env.DEMO_API_KEY === "") {
  respondError("MissingSecretValue", "DEMO_API_KEY value missing from handler environment");
} else {
  const sourceRequest = request.arguments?.request;
  if (!sourceRequest || typeof sourceRequest.query !== "string") {
    respondError("InvalidArguments", "request.query must be a string");
  } else {
    respond({
      title: sourceRequest.query,
      score: 0.82,
      secret_value_in_stdin: input.includes(process.env.DEMO_API_KEY),
    });
  }
}

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function respond(value) {
  process.stdout.write(JSON.stringify({ ok: true, value }));
}

function respondError(code, message) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }));
}
