// Pluto 1.0.4's injected environment runs after its authenticated WebSocket
// connects. A VS Code iframe cannot rely on Pluto's SameSite=Strict cookie.
// Keep the existing URL credential on Pluto's own navigation links only.
export default function environment() {
  if (!document.documentElement.hasAttribute('data-perfchecker-navigation')) {
    document.documentElement.setAttribute('data-perfchecker-navigation', 'ready');
    const popupCapability = '__PERFCHECKER_PLUTO_POPUP_CAPABILITY__';
    let parentOrigin;
    const pendingPopups=[];
    window.addEventListener('message', event => {
      if (window.parent === window || event.source !== window.parent ||
          event.data?.type !== 'perfcheckerPlutoHost' || event.data.capability !== popupCapability) return;
      if (parentOrigin && parentOrigin !== event.origin) return;
      parentOrigin = event.origin;
      document.documentElement.setAttribute('data-perfchecker-popup','ready');
      window.parent.postMessage({type:'perfcheckerPlutoReady',capability:popupCapability},parentOrigin);
      for(const url of pendingPopups.splice(0))window.parent.postMessage({type:'perfcheckerPlutoPopup',capability:popupCapability,url},parentOrigin);
    });
    const openContext = event => {
      if (window.parent===window || !/^[a-f0-9]{64}$/.test(popupCapability) || !event.isTrusted) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link) return;
      const href=link.getAttribute('href');if(!href||href.startsWith('#'))return;
      const destination = new URL(link.href,location.href),secret=new URL(location.href).searchParams.get('secret');
      if (!secret || destination.origin !== location.origin || !/^https?:$/.test(destination.protocol)) return;
      const navigation=/^\/(?:edit|open|new)?$/.test(destination.pathname);
      const sourceExport=destination.pathname==='/notebookfile'&&link.target==='_blank'&&!link.hasAttribute('download');
      const htmlExport=destination.pathname==='/notebookexport'&&link.matches('.export-html-dialog .ple-download a[download]');
      if(link.hasAttribute('download')&&!htmlExport)return;
      const modified=event.button===1||event.ctrlKey||event.metaKey||event.shiftKey;
      if (!(sourceExport || htmlExport || navigation && (modified || link.target==='_blank'))) return;
      if (destination.searchParams.has('secret') && destination.searchParams.get('secret')!==secret) return;
      if (!destination.searchParams.has('secret')) destination.searchParams.set('secret',secret);
      event.preventDefault();
      if(parentOrigin)window.parent.postMessage({type:'perfcheckerPlutoPopup',capability:popupCapability,url:destination.href},parentOrigin);
      else if(pendingPopups.length<8)pendingPopups.push(destination.href);
    };
    document.addEventListener('click',openContext,true);
    document.addEventListener('auxclick',openContext,true);
    const retainSession = event => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      const href = link?.getAttribute('href');
      const secret = new URL(location.href).searchParams.get('secret');
      if (!secret || !href || href.startsWith('#') || link.hasAttribute('download')) return;
      const destination = new URL(href, location.href);
      if (!/^https?:$/.test(destination.protocol) || destination.origin !== location.origin) return;
      if (!/\/(?:edit|open|new)?$/.test(destination.pathname)) return;
      if (!destination.searchParams.has('secret')) destination.searchParams.set('secret', secret);
      link.href = destination.href;
    };
    document.addEventListener('click', retainSession, true);
    document.addEventListener('auxclick', retainSession, true);

    // VS Code's ancestor sandbox disables window.confirm, including in nested
    // Pluto frames. Keep Pluto 1.0.4's own localized question and stock handler:
    // capture its question without approval, ask in an HTML dialog, then replay
    // only that same button with one approval for that exact question.
    let replaying = false, pendingDialog;
    document.addEventListener('click', event => {
      if (replaying || !event.isTrusted || location.pathname !== '/') return;
      const button = event.target instanceof Element ? event.target.closest('#recent li.running > button:first-child') : null;
      const row = button?.closest('li'), link = row?.querySelector('a[href]');
      const target = link ? new URL(link.href, location.href) : null;
      if (!button || !target || target.origin !== location.origin || target.pathname !== '/edit' || !target.searchParams.get('id')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (pendingDialog) return;
      const originalConfirm = window.confirm;
      let question;
      try {
        replaying = true;
        window.confirm = message => {if (question === undefined) question = String(message); return false;};
        button.click();
      } finally {window.confirm = originalConfirm; replaying = false;}
      if (!question) return;
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-label', 'Pluto confirmation');
      const text = document.createElement('p'); text.textContent = question;
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.type = 'button';
      const approve = document.createElement('button'); approve.textContent = 'Confirm'; approve.type = 'button';
      dialog.append(text, cancel, approve); document.body.append(dialog); pendingDialog = dialog;
      const dismiss = () => {dialog.close(); dialog.remove(); pendingDialog = undefined; button.focus();};
      cancel.addEventListener('click', dismiss);
      dialog.addEventListener('cancel', event => {event.preventDefault(); dismiss();});
      approve.addEventListener('click', () => {
        // A pending question cannot approve a replaced row or another notebook.
        const current = link?.isConnected ? new URL(link.href, location.href) : null;
        if (!button.isConnected || !row.classList.contains('running') || !current ||
            current.origin !== target.origin || current.pathname !== target.pathname ||
            current.searchParams.get('id') !== target.searchParams.get('id')) {dismiss(); return;}
        let consumed = false;
        try {
          replaying = true;
          window.confirm = message => {
            if (!consumed && String(message) === question) {consumed = true; return true;}
            return false;
          };
          button.click();
        } finally {window.confirm = originalConfirm; replaying = false; dismiss();}
      });
      dialog.showModal(); cancel.focus();
    }, true);
  }
  // Unspecified overrides retain Pluto's native header, Recent list and picker.
  return {};
}
