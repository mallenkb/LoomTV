const userAgentKey = ['n', 'p', 'm', '_config_user_agent'].join('');
const userAgent = process.env[userAgentKey] || '';
const execPathKey = ['n', 'p', 'm', '_execpath'].join('');
const execPath = process.env[execPathKey] || '';
const argv = process.argv.join(' ');

if (
  !userAgent.startsWith('pnpm/')
  && !/[/\\]pnpm(?:\.c?js|\.mjs)?$/i.test(execPath)
  && !/[/\\]pnpm[/\\]/i.test(execPath)
  && !/[/\\]pnpm(?:\.c?js|\.mjs)?(?:\s|$)/i.test(argv)
) {
  console.error('This project uses pnpm. Run `corepack pnpm install` and `corepack pnpm start`.');
  process.exit(1);
}
