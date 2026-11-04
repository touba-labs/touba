import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPythonHost } from "./python-host.mjs";
import { resolvePackageHost } from "../../touba-project/src/package-hosts.mjs";

const loadedPackageIdentities = new Map();

/** One lifecycle for explicitly selected trusted JS/Python host modules. */
export function createHostModuleLoader() {
  const modules = new Map(), hosts = new Set();
  let closed = false;
  async function load(filename, { kind, projectRoot } = {}) {
    if (closed) throw new Error("host module loader is closed");
    const selected = filename.startsWith("pkg:") ? resolvePackageHost(filename, kind, projectRoot) : null;
    const path = selected?.path ?? resolve(filename);
    if (selected) {
      const previous = loadedPackageIdentities.get(path);
      if (previous !== undefined && previous !== selected.identity) throw Object.assign(new Error("restart the host after replacing a loaded package"), { code: "PackageHostRestartRequired" });
      loadedPackageIdentities.set(path, selected.identity);
    }
    if (!modules.has(path)) modules.set(path, (async () => {
      if (!path.endsWith(".py")) return import(pathToFileURL(path).href);
      const host = await loadPythonHost(path);
      if (closed) { host.close(); throw new Error("host module loader is closed"); }
      hosts.add(host);
      return {
        decideAgentCapability: host.metadata.decide ? host.decide : undefined,
        attestHumanApproval: host.metadata.attest ? host.attest : undefined,
        checkCompensationAuthority: host.metadata.compensation ? host.compensation : undefined,
        initiatorRef: host.metadata.initiator_ref ?? undefined,
        resolveInitiator: host.metadata.resolve_initiator ? host.resolveInitiator : undefined,
        provider_metadata: host.metadata.provider_metadata ?? undefined,
        initialModes: host.metadata.initial_modes ?? undefined,
      };
    })());
    return modules.get(path);
  }
  return {
    load,
    async decisionProvider(filename, options = {}) {
      const module = await load(filename, { ...options, kind: "decision_provider" });
      const decide = module.decideAgentCapability ?? module.decide ?? module.default;
      if (typeof decide !== "function") throw Object.assign(new Error(
        "host must export decideAgentCapability (JavaScript) or decide_agent_capability (Python)"), { code: "DecisionProviderInvalid" });
      const metadata = module.provider_metadata ?? module.providerMetadata ?? decide.metadata;
      const initialModes = module.initialModes ?? decide.initialModes;
      return metadata === undefined && initialModes === undefined ? decide : { decide, metadata, initialModes };
    },
    async approvalHost(filename, options = {}) {
      const module = await load(filename, { ...options, kind: "human_approval" });
      if (typeof module.attestHumanApproval !== "function") throw Object.assign(new Error(
        "host must export attestHumanApproval (JavaScript) or attest_human_approval (Python)"), { code: "HumanApprovalAuthorityUnavailable" });
      return { humanApprovalAuthority: module.attestHumanApproval, humanApprovalInitiator: module.resolveInitiator ?? module.initiatorRef };
    },
    async compensationHost(filename) {
      // Package activation has its own closed kinds; this surface selects a local trusted host explicitly.
      if (filename.startsWith("pkg:")) throw Object.assign(new Error("select an explicit compensation authority host file"), { code: "CompensationAuthorityRefused" });
      const module = await load(filename);
      if (typeof module.checkCompensationAuthority !== "function") throw Object.assign(new Error(
        "host must export checkCompensationAuthority (JavaScript) or check_compensation_authority (Python)"), { code: "CompensationAuthorityRefused" });
      return { check: module.checkCompensationAuthority };
    },
    close() { closed = true; for (const host of hosts) host.close(); hosts.clear(); modules.clear(); },
  };
}
