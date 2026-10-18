import { executeRunCommand } from "./command.mjs";

// The CLI remains ephemeral even if a trusted provider retains handles.
const code = await executeRunCommand(process.argv.slice(2));
process.exit(code);
