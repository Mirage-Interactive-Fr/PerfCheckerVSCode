// Pluto 1.0.4's injected environment runs after its authenticated WebSocket
// connects. A VS Code iframe cannot rely on Pluto's SameSite=Strict cookie.
// Keep the existing URL credential on Pluto's own navigation links only.
export default function environment() {
  if (!document.documentElement.hasAttribute('data-perfchecker-navigation')) {
    document.documentElement.setAttribute('data-perfchecker-navigation', 'ready');
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
  }
  // Unspecified overrides retain Pluto's native header, Recent list and picker.
  return {};
}
