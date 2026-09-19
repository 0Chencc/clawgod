const fs = require("fs");
const settingsPath = process.argv[1];
const isMax = process.argv[2]?.toLowerCase() === "true";
const baseDeny = ["DesignSync","NotebookEdit","PushNotification","RemoteTrigger","CronCreate","CronDelete","CronList"];
const maxDeny = ["EnterPlanMode","ExitPlanMode","SendMessage","ScheduleWakeup","AskUserQuestion","ReportFindings"];
const baseFlags = ["disableWorkflows","disableClaudeAiConnectors","disableArtifact"];
const maxFlags = ["disableBundledSkills","disableRemoteControl"];
const deny = isMax ? [...baseDeny, ...maxDeny] : baseDeny;
const flags = isMax ? [...baseFlags, ...maxFlags] : baseFlags;
let s = {};
try { s = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
let changed = false;
// Downgrade max to on and migrate the old default Remote Control disable.
if (!isMax) {
  for (const k of maxFlags) { if (k in s) { delete s[k]; changed = true; } }
  if (Array.isArray(s.permissions?.deny)) {
    const before = s.permissions.deny.length;
    s.permissions.deny = s.permissions.deny.filter(t => !maxDeny.includes(t));
    if (s.permissions.deny.length !== before) changed = true;
  }
}
for (const k of flags) { if (!(k in s)) { s[k] = true; changed = true; } }
if (!s.permissions) s.permissions = {};
if (!Array.isArray(s.permissions.deny)) s.permissions.deny = [];
const ex = new Set(s.permissions.deny);
for (const t of deny) { if (!ex.has(t)) { s.permissions.deny.push(t); changed = true; } }
if (changed) fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
