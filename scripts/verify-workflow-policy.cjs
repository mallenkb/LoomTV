#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const workspaceRoot = path.resolve(__dirname, '..');
const workflowsDirectory = path.join(workspaceRoot, '.github', 'workflows');
const WRITE_PERMISSION = /^(?:write|write-all)$/i;
const SHA_PIN = /^[0-9a-f]{40}$/i;
const UNTRUSTED_TRIGGERS = new Set([
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_target',
  'workflow_run',
]);
const PUBLISH_COMMANDS = [
  /\b(?:npm|pnpm|yarn)\s+publish\b/i,
  /\b(?:npm|pnpm|yarn)\b[^\n;&|]*\brun\s+(?:publish|release(?:[:][^\s;&|]+)?)(?:\s|$)/i,
  /\bgh\s+release\s+(?:create|delete|edit|upload)\b/i,
  /\bgh\s+api\b/i,
  /\bgit\s+push\b/i,
  /\bdocker\s+push\b/i,
  /\bdocker\s+buildx\s+build\b[^\n]*\s--push(?:\s|$)/i,
  /\b(?:cargo|twine)\s+publish\b/i,
  /\belectron-builder\b[^\n]*--publish(?:\s+|=)(?!never\b)/i,
];
const PUBLISHING_ACTIONS = [
  /(?:^|[\/._-])(?:create-release|publish-release)(?:[\/._@-]|$)/i,
  /action-gh-release/i,
  /action-automatic-releases/i,
  /upload-release-asset/i,
  /docker\/build-push-action/i,
];

function triggerNames(workflow) {
  if (typeof workflow.on === 'string') return [workflow.on];
  if (Array.isArray(workflow.on)) return workflow.on;
  if (workflow.on && typeof workflow.on === 'object') return Object.keys(workflow.on);
  return [];
}

function permissionViolations(value, location) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    return WRITE_PERMISSION.test(value) ? [`${location} grants ${value}.`] : [];
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return [`${location} must be a permission map or read-only shorthand.`];
  }
  return Object.entries(value)
    .filter(([, permission]) => WRITE_PERMISSION.test(String(permission)))
    .map(([scope, permission]) => `${location}.${scope} grants ${permission}.`);
}

function jobSteps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function hasSelfHostedRunner(value) {
  if (typeof value === 'string') return /\bself-hosted\b/i.test(value);
  if (Array.isArray(value)) return value.some(hasSelfHostedRunner);
  return false;
}

function publishingStep(job) {
  return jobSteps(job).find((step) => (
    step && (
      (typeof step.run === 'string' && PUBLISH_COMMANDS.some((pattern) => pattern.test(step.run)))
      || (typeof step.uses === 'string' && PUBLISHING_ACTIONS.some((pattern) => pattern.test(step.uses)))
    )
  ));
}

function checkoutCredentialViolations(job, fileName, jobName) {
  return jobSteps(job)
    .flatMap((step, stepIndex) => {
      if (!step || typeof step.uses !== 'string' || !/^actions\/checkout@/i.test(step.uses)) return [];
      const persistCredentials = step.with?.['persist-credentials'];
      if (persistCredentials === false || String(persistCredentials).toLowerCase() === 'false') return [];
      return [`${fileName}: jobs.${jobName}.steps[${stepIndex}] checkout must set persist-credentials: false for untrusted code.`];
    });
}

function hasExplicitReadOnlyPermissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return value.contents === undefined || value.contents === 'read' || value.contents === 'none';
}

function actionPinViolations(workflow, fileName) {
  const violations = [];
  for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
    if (job && typeof job.uses === 'string') {
      const separator = job.uses.lastIndexOf('@');
      const ref = separator >= 0 ? job.uses.slice(separator + 1) : '';
      if (!job.uses.startsWith('./') && !SHA_PIN.test(ref)) {
        violations.push(`${fileName}: jobs.${jobName}.uses is not pinned to a full commit SHA.`);
      }
    }
    for (const [index, step] of jobSteps(job).entries()) {
      if (!step || typeof step.uses !== 'string' || step.uses.startsWith('./')) continue;
      const separator = step.uses.lastIndexOf('@');
      const ref = separator >= 0 ? step.uses.slice(separator + 1) : '';
      if (!SHA_PIN.test(ref)) {
        violations.push(`${fileName}: jobs.${jobName}.steps[${index}].uses is not pinned to a full commit SHA.`);
      }
    }
  }
  return violations;
}

function containsSecretsExpression(value) {
  if (typeof value === 'string') {
    return /\$\{\{[\s\S]*?\bsecrets\b[\s\S]*?\}\}/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsSecretsExpression);
  if (value && typeof value === 'object') return Object.values(value).some(containsSecretsExpression);
  return false;
}

function findPolicyViolations(fileName, source) {
  let workflow;
  try {
    workflow = YAML.parse(source);
  } catch (error) {
    return [`${fileName}: invalid YAML (${error.message}).`];
  }
  if (!workflow || typeof workflow !== 'object') return [`${fileName}: workflow must be a YAML object.`];

  const violations = actionPinViolations(workflow, fileName);
  if (workflow.permissions === undefined) {
    violations.push(`${fileName}: workflow must declare explicit permissions.`);
  }
  for (const [lineIndex, line] of source.split(/\r?\n/).entries()) {
    if (/\b(?:pnpm|npm|yarn)\s+install\b/.test(line) && !line.includes('--frozen-lockfile')) {
      violations.push(`${fileName}:${lineIndex + 1}: dependency install must use --frozen-lockfile.`);
    }
  }
  for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
    if (hasSelfHostedRunner(job?.['runs-on'])) {
      violations.push(`${fileName}: jobs.${jobName} must not use a self-hosted runner.`);
    }
    const publishing = publishingStep(job);
    if (publishing && job?.environment === undefined) {
      violations.push(`${fileName}: jobs.${jobName} contains a publishing command but has no protected environment.`);
    }
  }
  const triggers = triggerNames(workflow);
  const runsOnUntrustedInput = triggers.some((trigger) => UNTRUSTED_TRIGGERS.has(trigger));
  if (!runsOnUntrustedInput) return violations;

  if (triggers.includes('pull_request_target')) {
    violations.push(`${fileName}: pull_request_target is prohibited for repository-code validation.`);
  }
  if (triggers.includes('workflow_run')) {
    violations.push(`${fileName}: workflow_run is prohibited for repository-code validation.`);
  }
  if (!hasExplicitReadOnlyPermissions(workflow.permissions)) {
    violations.push(`${fileName}: untrusted-trigger workflows must declare explicit deny-all or contents: read permissions.`);
  }
  violations.push(...permissionViolations(workflow.permissions, `${fileName}: permissions`));
  for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
    violations.push(...permissionViolations(job?.permissions, `${fileName}: jobs.${jobName}.permissions`));
    if (job?.environment !== undefined) {
      violations.push(`${fileName}: jobs.${jobName}.environment is prohibited in untrusted-trigger workflows.`);
    }
    violations.push(...checkoutCredentialViolations(job, fileName, jobName));
    if (job?.secrets !== undefined) {
      violations.push(`${fileName}: jobs.${jobName}.secrets is prohibited in untrusted-trigger workflows.`);
    }
    for (const [stepIndex, step] of jobSteps(job).entries()) {
      if (!step) continue;
      const hasPublishingCommand = typeof step.run === 'string'
        && PUBLISH_COMMANDS.some((pattern) => pattern.test(step.run));
      const hasPublishingAction = typeof step.uses === 'string'
        && PUBLISHING_ACTIONS.some((pattern) => pattern.test(step.uses));
      if (hasPublishingCommand || hasPublishingAction) {
        violations.push(`${fileName}: jobs.${jobName}.steps[${stepIndex}] contains a publishing command or action.`);
      }
    }
  }
  if (containsSecretsExpression(workflow) || /\bsecrets\s*:\s*inherit\b/i.test(source)) {
    violations.push(`${fileName}: untrusted-trigger workflows must not reference the secrets context.`);
  }
  return violations;
}

function desktopPackagingViolations(packageDocument, fileName = 'apps/desktop/package.json') {
  const distScript = packageDocument?.scripts?.dist;
  if (typeof distScript !== 'string'
    || !/\belectron-builder\b/.test(distScript)
    || !/--publish(?:=|\s+)never\b/.test(distScript)) {
    return [`${fileName}: scripts.dist must invoke electron-builder with --publish=never.`];
  }
  return [];
}

function verifyWorkflowDirectory(directory = workflowsDirectory) {
  const files = fs.readdirSync(directory)
    .filter((fileName) => /\.ya?ml$/i.test(fileName))
    .sort();
  const violations = files.flatMap((fileName) => findPolicyViolations(
    fileName,
    fs.readFileSync(path.join(directory, fileName), 'utf8'),
  ));
  const desktopPackagePath = path.join(workspaceRoot, 'apps', 'desktop', 'package.json');
  violations.push(...desktopPackagingViolations(
    JSON.parse(fs.readFileSync(desktopPackagePath, 'utf8')),
  ));
  if (violations.length > 0) {
    throw new Error(`Workflow policy violations:\n- ${violations.join('\n- ')}`);
  }
  return files;
}

if (require.main === module) {
  try {
    const files = verifyWorkflowDirectory();
    console.log(`Workflow policy passed for ${files.length} workflow${files.length === 1 ? '' : 's'}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  desktopPackagingViolations,
  findPolicyViolations,
  verifyWorkflowDirectory,
};
