import { generateHandlerStubFromAirTool } from "./stub.mjs";

// Parse data literals, never execute submitted source. Exact regeneration
// accepts only the canonical unimplemented template, not a marker in arbitrary code.
export function isCanonicalHandlerStub(content, language = "javascript") {
  try {
    const read = name => {
      if (language === "python") {
        const match = content.match(new RegExp(`^${name} = json\\.loads\\((.+)\\)$`, "mu"));
        if (!match) throw new Error("missing literal");
        return JSON.parse(JSON.parse(match[1]));
      }
      const match = content.match(new RegExp(`^const ${name} = ([\\s\\S]*?);$`, "mu"));
      if (!match) throw new Error("missing literal");
      return JSON.parse(match[1]);
    };
    const tool = { id: read("TOOL_REF"), required_capabilities: read("REQUIRED_GRANTS"),
      required_secrets: read("REQUIRED_SECRET_HANDLES"),
      signature: { inputs: read("INPUT_SIGNATURE"), output_type: read("OUTPUT_TYPE") } };
    return content === generateHandlerStubFromAirTool(tool, { language });
  } catch { return false; }
}
