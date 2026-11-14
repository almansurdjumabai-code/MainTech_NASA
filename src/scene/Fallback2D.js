import { PolarData } from './polar/PolarData.js';
import { CATEGORIES } from './markers.js';

// Запасной режим (этап 7): если WebGL недоступен — статичный снимок полюса (LOLA + тени из Horizons)
// с кликабельными точками. Те же события siteclick / surfaceclick, что и у 3D-сцены.

export class Fallback2D {
  constructor(container, emit) {
    this.emit = emit;
    this.sites = [];
    this.root = document.createElement('div');
    this.root.className = 'moon-fallback';
    this.root.innerHTML = `
      <div class="fb-map"><img alt="South Pole of the Moon, LOLA terrain with sunlight and shadows"><div class="fb-pins"></div></div>
      <div class="fb-note"><b>3D view unavailable</b> on this device — showing a static LOLA render of the South Pole
      (shadows computed for <span data-date></span>).</div>`;
    container.appendChild(this.root);
    this.img = this.root.querySelector('img');
    this.pins = this.root.querySelector('.fb-pins');
    this.img.addEventListener('click', (e) => this._click(e));
    fetch('/fallback/fallback.json')
      .then((r) => r.json())
      .then((meta) => {
        this.meta = meta;
        this.setDate(this.date ?? new Date());
        this._renderPins();
      })
      .catch(() => {
        this.root.querySelector('.fb-note').textContent = '3D view and static map are unavailable (files missing).';
      });
  }

  setDate(date) {
    this.date = new Date(date);
    if (!this.meta) return;
    // ближайший по времени кадр
    const best = this.meta.frames.reduce((a, b) =>
      Math.abs(Date.parse(b.date) - this.date) < Math.abs(Date.parse(a.date) - this.date) ? b : a,
    );
    this.img.src = `/fallback/${best.file}`;
    this.root.querySelector('[data-date]').textContent = best.date.slice(0, 10);
  }

  setSites(sites) {
    this.sites = sites;
    this._renderPins();
  }

  _toPercent(lat, lon) {
    const { x, y } = PolarData.latLonToMap(lat, lon);
    const h = this.meta?.halfExtentKm ?? 200;
    return { left: ((x + h) / (2 * h)) * 100, top: ((h - y) / (2 * h)) * 100, inside: Math.abs(x) < h && Math.abs(y) < h };
  }

  _renderPins() {
    this.pins.innerHTML = '';
    for (const s of this.sites) {
      const p = this._toPercent(s.lat, s.lon);
      if (!p.inside) continue;
      const cat = CATEGORIES[s.category] ?? CATEGORIES.custom;
      const b = document.createElement('button');
      b.className = 'fb-pin';
      b.dataset.id = s.id;
      b.style.cssText = `left:${p.left}%;top:${p.top}%;--c:${cat.color}`;
      b.innerHTML = `<i>${cat.icon}</i>${s.name}`;
      b.addEventListener('click', () => this.emit('siteclick', { id: s.id }));
      this.pins.appendChild(b);
    }
  }

  _click(e) {
    const r = this.img.getBoundingClientRect();
    const h = this.meta?.halfExtentKm ?? 200;
    const x = ((e.clientX - r.left) / r.width) * 2 * h - h;
    const y = h - ((e.clientY - r.top) / r.height) * 2 * h;
    this.emit('surfaceclick', PolarData.mapToLatLon(x, y));
  }

  select(id) {
    for (const b of this.pins.children) b.classList.toggle('selected', b.dataset.id === id);
  }

  dispose() {
    this.root.remove();
  }
}
