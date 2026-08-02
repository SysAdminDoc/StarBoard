import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const siblingNpm = join(
  dirname(process.execPath),
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
);
const npm =
  process.env.STARBOARD_NPM ||
  (existsSync(siblingNpm) ? siblingNpm : process.platform === 'win32' ? 'npm.cmd' : 'npm');

function run(args) {
  return spawnSync(npm, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
}

function parseJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

const audit = run(['audit', '--include=dev', '--json']);
const auditStdout = audit.stdout || '';
const auditStderr = audit.stderr || '';
const auditReport = parseJson(auditStdout);
const auditSummary = auditReport?.metadata?.vulnerabilities || {};
console.log(
    `DEV AUDIT  npm audit --include=dev exited ${audit.status ?? 'spawn-failed'}: ` +
    `info=${auditSummary.info || 0} low=${auditSummary.low || 0} ` +
    `moderate=${auditSummary.moderate || 0} high=${auditSummary.high || 0} ` +
    `critical=${auditSummary.critical || 0}`,
);
for (const [name, entry] of Object.entries(auditReport?.vulnerabilities || {})) {
  console.log(
    `  ${name}@${entry.version || '?'}: ${entry.severity || 'unknown'} ` +
      `${entry.isDirect ? '(direct)' : '(transitive)'}`,
  );
}
if (auditStderr.trim()) console.log(auditStderr.trim());

const outdated = run(['outdated', '--long', '--json']);
const outdatedStdout = outdated.stdout || '';
const outdatedStderr = outdated.stderr || '';
const outdatedReport = parseJson(outdatedStdout) || {};
const outdatedNames = Object.keys(outdatedReport);
console.log(`DEV FRESHNESS  ${outdatedNames.length} outdated package(s) reported`);
for (const name of outdatedNames) {
  const entry = outdatedReport[name];
  console.log(
    `  ${name}: current=${entry.current || '?'} wanted=${entry.wanted || '?'} ` +
      `latest=${entry.latest || '?'} type=${entry.type || 'unknown'}`,
  );
}
if (outdated.status !== 0 && !outdatedNames.length && outdatedStderr.trim()) {
  console.log(outdatedStderr.trim());
}

// This is an advisory report. Production dependencies remain covered by the
// blocking npm audit step in CI; dev-only findings do not make a release
// unverifiable or imply that the ZIP contains the affected tools.
process.exit(0);
