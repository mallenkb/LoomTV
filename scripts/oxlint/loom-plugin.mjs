// Oxlint JS plugin for checks the built-in rules cannot express.
//
// A synchronous child process freezes the Electron main thread (and the
// in-process canonical server) for as long as the command runs. The built-in
// no-restricted-imports rule catches `import { execSync }`; this rule catches
// member calls such as `childProcess.execSync(...)`. Quit-time cleanup that
// genuinely must block can opt out on one line with a comment saying why.
const SYNC_CHILD_PROCESS = new Set(['execFileSync', 'execSync', 'spawnSync']);

const noSyncChildProcess = {
  meta: {
    type: 'problem',
    messages: {
      sync: 'Synchronous child processes block the main thread; use the async form.',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const { property } = node;
        if (!node.computed && property.type === 'Identifier' && SYNC_CHILD_PROCESS.has(property.name)) {
          context.report({ node, messageId: 'sync' });
        }
      },
    };
  },
};

export default {
  meta: { name: 'loom' },
  rules: {
    'no-sync-child-process': noSyncChildProcess,
  },
};
