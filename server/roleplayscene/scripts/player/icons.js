export function createPlayerIcon(name) {
  const svg = document.createElementNS
    ? document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    : document.createElement('svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList?.add?.('theater-icon');

  const appendPath = (d) => {
    const path = document.createElementNS
      ? document.createElementNS('http://www.w3.org/2000/svg', 'path')
      : document.createElement('path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  };

  const appendCircle = (cx, cy, r) => {
    const circle = document.createElementNS
      ? document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      : document.createElement('circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', r);
    svg.appendChild(circle);
  };

  switch (name) {
    case 'previous':
      appendPath('m15 18-6-6 6-6');
      break;
    case 'next':
      appendPath('m9 18 6-6-6-6');
      break;
    case 'play':
      appendPath('M8 5v14l11-7-11-7Z');
      break;
    case 'stop':
      appendPath('M7 7h10v10H7z');
      break;
    case 'list':
      appendPath('M8 6h13');
      appendPath('M8 12h13');
      appendPath('M8 18h13');
      appendCircle('4', '6', '1');
      appendCircle('4', '12', '1');
      appendCircle('4', '18', '1');
      break;
    case 'music':
      appendPath('M9 18V5l12-2v13');
      appendCircle('6', '18', '3');
      appendCircle('18', '16', '3');
      break;
    case 'history':
      appendPath('M3 12a9 9 0 1 0 3-6.7');
      appendPath('M3 4v5h5');
      appendPath('M12 7v5l3 2');
      break;
    case 'pencil':
      appendPath('M12 20h9');
      appendPath('M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z');
      break;
    case 'print':
      appendPath('M6 9V4h12v5');
      appendPath('M6 18h12v2H6z');
      appendPath('M6 14h12');
      appendPath('M6 10H4a2 2 0 0 0-2 2v4h4');
      appendPath('M18 16h4v-4a2 2 0 0 0-2-2h-2');
      break;
    case 'close':
      appendPath('M18 6 6 18');
      appendPath('m6 6 12 12');
      break;
    default:
      appendCircle('12', '12', '8');
      break;
  }

  return svg;
}
