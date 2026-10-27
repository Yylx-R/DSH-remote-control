// 统一线性图标集：24 网格、1.8 描边、圆头圆角，跟随 currentColor
const P = {
  'chevron-left': '<path d="M15 5l-7 7 7 7"/>',
  gear:
    '<circle cx="12" cy="12" r="3.2"/>' +
    '<path d="M12 2.6v2.2M12 19.2v2.2M4.7 4.7l1.6 1.6M17.7 17.7l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.7 19.3l1.6-1.6M17.7 6.3l1.6-1.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'arrow-up': '<path d="M12 19V5.5M6 11.5l6-6 6 6"/>',
  stop: '<rect x="7.5" y="7.5" width="9" height="9" rx="2" fill="currentColor" stroke="none"/>',
  image:
    '<rect x="3" y="4.5" width="18" height="15" rx="2.6"/>' +
    '<circle cx="8.6" cy="9.8" r="1.5"/>' +
    '<path d="M3.4 16.6l4.9-4.9a1.6 1.6 0 0 1 2.3 0l5.2 5.2M14.6 14.2l1.5-1.5a1.6 1.6 0 0 1 2.3 0l2.2 2.2"/>',
  camera:
    '<path d="M4.2 8.4h2.6l1.4-2.1h7.6l1.4 2.1h2.6a1.6 1.6 0 0 1 1.6 1.6v8a1.6 1.6 0 0 1-1.6 1.6H4.2a1.6 1.6 0 0 1-1.6-1.6v-8a1.6 1.6 0 0 1 1.6-1.6z"/>' +
    '<circle cx="12" cy="13.9" r="3.1"/>',
  file:
    '<path d="M14 3.2H7.4A2.2 2.2 0 0 0 5.2 5.4v13.2a2.2 2.2 0 0 0 2.2 2.2h9.2a2.2 2.2 0 0 0 2.2-2.2V8z"/>' +
    '<path d="M14 3.2V8h4.8M8.6 12.6h6.8M8.6 16.2h4.6"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  monitor:
    '<rect x="3" y="4.2" width="18" height="11.6" rx="2.2"/>' +
    '<path d="M9 19.8h6M12 15.8v4"/>',
  refresh: '<path d="M20 11.4a8 8 0 1 0-.7 4.4"/><path d="M20 4.6v6.8h-6.6"/>',
  link:
    '<path d="M10.2 13.8a4.6 4.6 0 0 0 6.5 0l2.1-2.1a4.6 4.6 0 0 0-6.5-6.5l-1 1"/>' +
    '<path d="M13.8 10.2a4.6 4.6 0 0 0-6.5 0l-2.1 2.1a4.6 4.6 0 0 0 6.5 6.5l1-1"/>',
  chat:
    '<path d="M20.4 12a8.4 8.4 0 0 1-8.4 8.4 8.5 8.5 0 0 1-3.7-.8L3.6 21l1.4-4.7A8.4 8.4 0 1 1 20.4 12z"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
}

export function icon(name, size = 20) {
  const body = P[name] || ''
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
    `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
  )
}

export function mountIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.innerHTML = icon(el.dataset.icon, Number(el.dataset.iconSize) || 20)
  }
}
