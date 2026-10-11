export const TRAY_MENU_ACTION_ORIGIN = 'https://loom-tray.invalid';

export type ServerTrayMenuInfo = {
  port: number;
  webUrl: string;
  adminUrl: string | null;
};

// Lucide's Copy icon: https://github.com/lucide-icons/lucide/blob/main/icons/copy.svg
const COPY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

function escapeHtml(value: string): string {
  const replacements: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  };
  return value.replace(/[&<>"']/g, character => replacements[character] ?? character);
}

export function serverTrayMenuHeight(hasAdminAction: boolean): number {
  return hasAdminAction ? 250 : 220;
}

export function serverTrayMenuHtml(info: ServerTrayMenuInfo, hasAdminAction: boolean, nonce: string): string {
  const action = (name: string, label: string) => `<button class="action" role="menuitem" data-action="${name}">${label}</button>`;
  const copyRow = (label: string, value: string | null, name: string, description: string) => `
    <div class="value-row">
      <span class="value" title="${escapeHtml(value ?? 'Not configured')}">${label}: ${escapeHtml(value ?? 'Not configured')}</span>
      <button class="copy" role="menuitem" data-action="${name}" aria-label="${description}" title="${description}" ${value === null ? 'disabled' : ''}>${COPY_ICON}</button>
    </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
  <title>Loom tray menu</title>
  <style>
    * { box-sizing: border-box; }
    :root { color-scheme: light dark; }
    body { margin: 0; font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; user-select: none; }
    .menu { height: 100vh; padding: 6px; overflow-y: auto; border: 1px solid rgba(0,0,0,.15); border-radius: 10px; background: rgba(248,248,248,.96); color: #222; }
    button { font: inherit; color: inherit; border: 0; background: transparent; cursor: default; }
    .action { display: block; width: 100%; height: 30px; padding: 0 10px; border-radius: 5px; text-align: left; }
    .action:hover, .action:focus-visible { background: #0868f9; color: white; outline: none; }
    .separator { height: 1px; margin: 6px 4px; background: rgba(0,0,0,.14); }
    .value-row { display: flex; align-items: center; gap: 10px; height: 30px; padding-left: 10px; }
    .value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #666; }
    .copy { display: grid; place-items: center; width: 30px; height: 28px; flex: 0 0 30px; border-radius: 5px; }
    .copy:hover:not(:disabled), .copy:focus-visible { background: rgba(0,0,0,.09); outline: none; }
    .copy:disabled { opacity: .25; }
    @media (prefers-color-scheme: dark) {
      .menu { background: rgba(49,50,54,.97); border-color: rgba(255,255,255,.16); color: #f2f2f2; }
      .separator { background: rgba(255,255,255,.17); }
      .value { color: #b8b9bd; }
      .copy:hover:not(:disabled), .copy:focus-visible { background: rgba(255,255,255,.12); }
    }
  </style>
</head>
<body>
  <div class="menu" role="menu" aria-label="Loom">
    ${action('open', 'Open Loom')}
    ${action('open-web', 'Open Web')}
    ${hasAdminAction ? action('open-admin', 'Open Loom admin') : ''}
    <div class="separator" role="separator"></div>
    ${copyRow('Port', String(info.port), 'copy-port', 'Copy port')}
    ${copyRow('Web URL', info.webUrl, 'copy-web', 'Copy web URL')}
    ${copyRow('Admin URL', info.adminUrl, 'copy-admin', 'Copy admin URL')}
    <div class="separator" role="separator"></div>
    ${action('quit', 'Quit Loom')}
  </div>
  <script nonce="${nonce}">
    const buttons = () => Array.from(document.querySelectorAll('button:not(:disabled)'));
    const send = action => { window.location.href = '${TRAY_MENU_ACTION_ORIGIN}/' + action; };
    document.addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (button && !button.disabled) send(button.dataset.action);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); send('close'); return; }
      const items = buttons();
      const index = items.indexOf(document.activeElement);
      let next;
      if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) next = (index + 1) % items.length;
      else if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) next = (index - 1 + items.length) % items.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = items.length - 1;
      if (next !== undefined) { event.preventDefault(); items[next].focus(); }
    });
    buttons()[0]?.focus();
  </script>
</body>
</html>`;
}
