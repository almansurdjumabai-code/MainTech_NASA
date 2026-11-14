import * as THREE from 'three';
import { ParticlePool, particleMaterial, discTex } from './effects.js';

// Спецэффекты аппарата (координаты внутри модели — метры):
//  • навигационные огни мигают (красный/зелёный — короткие вспышки, прожекторы — ровно),
//  • двигатели ориентации (RCS) дают короткие выбросы газа: в вакууме газ мгновенно
//    расширяется конусом и исчезает за доли секунды — без клубов и шлейфа.

export class LanderFx {
  constructor(lander, { unit = 1 } = {}) {
    this.lander = lander;
    this.navs = [];
    this.rcs = [];
    lander.traverse((o) => {
      if (o.isMesh && /^(NavLight|FloodLamp)/.test(o.name)) {
        o.material = o.material.clone();
        this.navs.push({ o, base: o.material.emissiveIntensity ?? 1, flood: o.name.startsWith('FloodLamp'), phase: o.name.includes('Green') ? 0.5 : 0 });
      }
      if (/^RCS_\d$/.test(o.name)) this.rcs.push(o);
    });
    this.gas = new ParticlePool(1500, particleMaterial({ map: discTex, color: 0xc9d6ff, hot: 0xffffff, hotTime: 0.3, opacity: 0.55, grow: 6, unit }));
    this.gas.points.renderOrder = 3;
    lander.add(this.gas.points);
    this._v = new THREE.Vector3();
  }

  /** Короткий импульс случайного двигателя ориентации. */
  pulse() {
    if (!this.rcs.length) return;
    const n = this.rcs[Math.floor(Math.random() * this.rcs.length)];
    const p = n.getWorldPosition(this._v);
    this.lander.worldToLocal(p);
    const dir = new THREE.Vector3(p.x, 0, p.z).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(Math.random() < 0.5 ? -1 : 1);
    for (let i = 0; i < 40; i++) {
      const v = 18 + Math.random() * 14;
      const d = side.clone().multiplyScalar(v).add(new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6));
      this.gas.spawn(p.x, p.y, p.z, d.x, d.y, d.z, 0.25 + Math.random() * 0.15, 0.25 + Math.random() * 0.2);
    }
  }

  dispose() {
    this.gas.points.removeFromParent();
    this.gas.geo.dispose();
    this.gas.points.material.dispose();
    for (const n of this.navs) n.o.material.dispose();
  }

  update(t, dt, { rcsRate = 0 } = {}) {
    for (const n of this.navs) {
      const m = n.o.material;
      // вспышка 0.12 с раз в секунду; прожекторы горят ровно
      const on = n.flood ? 1 : ((t + n.phase) % 1) < 0.12 ? 1 : 0.08;
      if ('emissiveIntensity' in m) m.emissiveIntensity = n.base * (n.flood ? 1.3 : 2.5) * on;
    }
    if (rcsRate > 0 && Math.random() < rcsRate * dt) this.pulse();
    this.gas.update(dt);
  }
}
