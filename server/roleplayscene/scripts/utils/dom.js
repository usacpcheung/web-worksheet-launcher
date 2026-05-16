export const $ = (sel, el=document) => el.querySelector(sel);
export const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));
export function h(tag, attrs={}, ...children) {
  const el = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c);
  return el;
}
