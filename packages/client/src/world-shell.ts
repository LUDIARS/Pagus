import './world-shell.css';

function requiredElement(id: string): HTMLElement {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing world shell element: ${id}`);
    return node;
}

/** Mp-style full-screen world, top menu, bottom actions and tap-to-restore UI. */
export function mountWorldShell(): void {
    const scope = new AbortController();
    const options = { signal: scope.signal };
    const bar = requiredElement('topbar');
    const shell = requiredElement('app-shell');
    const backdrop = requiredElement('backdrop');
    const menu = document.createElement('nav');
    menu.id = 'world-menu';
    menu.hidden = true;
    menu.setAttribute('aria-label', 'メニュー');
    const toggle = document.createElement('button');
    toggle.textContent = 'メニュー';
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', menu.id);
    toggle.setAttribute('aria-expanded', 'false');
    const setMenu = (open: boolean): void => {
        menu.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => setMenu(menu.hidden), options);
    menu.append(requiredElement('hist-btn'), requiredElement('account-btn'), requiredElement('settings-wrap'));
    const dock = document.createElement('nav');
    dock.id = 'world-dock';
    dock.setAttribute('aria-label', '村の操作');
    dock.append(requiredElement('btn-left'), requiredElement('btn-right'));
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.id = 'world-hide-ui';
    hide.textContent = 'UIを消す';
    let hiddenAt = 0;
    hide.addEventListener('click', () => {
        setMenu(false);
        backdrop.click();
        document.body.classList.add('world-ui-hidden');
        hiddenAt = performance.now();
    }, options);
    const restore = (event: PointerEvent): void => {
        if (!document.body.classList.contains('world-ui-hidden') || performance.now() - hiddenAt < 250) return;
        event.preventDefault();
        event.stopPropagation();
        document.body.classList.remove('world-ui-hidden');
        hide.focus();
    };
    document.addEventListener('pointerdown', restore, { ...options, capture: true, passive: false });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            setMenu(false);
            backdrop.click();
            document.body.classList.remove('world-ui-hidden');
        }
    }, options);
    const full = document.createElement('button');
    full.type = 'button';
    full.textContent = '全画面';
    full.addEventListener('click', () => {
        const request = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
        if (request) void request.catch(() => { full.textContent = '全画面にできません'; });
        else full.textContent = 'ホーム画面に追加して全画面で開く';
    }, options);
    menu.append(full);
    bar.prepend(toggle);
    shell.append(menu, dock, hide);
    // A persisted pagehide only parks this document in bfcache. Keep its controls
    // alive so they still work after pageshow; abort only when the page is discarded.
    window.addEventListener('pagehide', (event) => {
        if (!event.persisted) scope.abort();
    }, options);
}
