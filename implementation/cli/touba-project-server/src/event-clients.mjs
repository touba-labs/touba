// Live delivery and replay use the same permission boundary. New event kinds
// remain private until their audience has been declared here.
import { projectMetadataEvent } from './project-metadata.mjs';
const clients = new WeakMap();
export function eventVisibleToIdentity(type, identity) {
  if (identity === null) return true; // Explicit project-bearer mode.
  if (identity?.active !== true) return false;
  const permits = permission => identity.permissions?.includes("*") || identity.permissions?.includes(permission);
  if (type === 'approval.dossier.viewed') return permits('audit.read');
  if (type.startsWith("touba.server.")) return true;
  if (/^(project|artifact|validation)\./u.test(type)) return permits("projects.read");
  if (/^(change|element|package)\./u.test(type)) return permits("governance.read");
  if (type.startsWith("deployment.")) return permits("deployments.read");
  if (/^(human_decision|human_wait|mobile_pairing)\./u.test(type)) return permits("decisions.read");
  if (/^(interaction|sandbox_run|trigger)\./u.test(type)) return permits("executions.read");
  return false;
}

export function registerEventClient(response, identity, { onClose = () => {}, heartbeatMs = 15000, lifetimeMs = 60000 } = {}) {
  clients.set(response, identity);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat); clearTimeout(lifetime); clients.delete(response); onClose();
  };
  const heartbeat = setInterval(() => {
    if (response.destroyed || response.writableEnded) return close();
    if (response.writableLength > 1024 * 1024) { response.destroy(); close(); return; }
    response.write(": heartbeat\n\n");
  }, heartbeatMs);
  // Reconnection rechecks the human session and project bearer, so a long-lived
  // stream cannot preserve revoked authority indefinitely.
  const lifetime = setTimeout(() => { response.end(); close(); }, lifetimeMs);
  heartbeat.unref?.(); lifetime.unref?.();
  response.once("close", close);
}

export function writeSse(response, event, data) {
  if (response.destroyed || response.writableEnded) return;
  if (!eventVisibleToIdentity(event, clients.get(response))) return;
  const frame = `${typeof data?.event_id === "string" ? `id: ${data.event_id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(projectMetadataEvent(response, event, data))}\n\n`;
  // Never accumulate an unbounded queue behind a disconnected/slow browser.
  if (response.writableLength + Buffer.byteLength(frame) > 1024 * 1024) { response.destroy(); return; }
  response.write(frame);
}
