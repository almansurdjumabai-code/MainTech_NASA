import * as THREE from 'three';
import { G_MOON, kickDust } from './effects.js';

// Процедурная анимация астронавта (модель astronaut.glb с пивотами-суставами из Blender).
// Походка — «лунный галоп» как у экипажей Apollo: при g = 1.62 м/с² шаг превращается в прыжок
// с долгой фазой полёта; руки балансируют, корпус наклонён вперёд из-за ранца.

const JOINTS = ['Pelvis', 'Spine', 'Neck', 'ShoulderL', 'ShoulderR', 'ElbowL', 'ElbowR', 'HipL', 'HipR', 'KneeL', 'KneeR'];

export class AstronautRig {
  constructor(object) {
    this.object = object;
    this.j = {};
    for (const n of JOINTS) {
      const o = object.getObjectByName(n);
      if (o) this.j[n] = { o, q: o.quaternion.clone() };
    }
    this.ok = Object.keys(this.j).length >= 9;
    this.phase = 0;
    this.lastContact = 0;
    this.mode = 'walk'; // 'idle' | 'walk' | 'plant'
    this.lookTarget = null;
  }

  _rot(name, x = 0, y = 0, z = 0) {
    const j = this.j[name];
    if (!j) return;
    j.o.quaternion.copy(j.q).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ')));
  }

  /**
   * t — время, dt — шаг; speed — м/с. Возвращает вертикальный подскок (м).
   * dust — пул лунной пыли (в тех же координатах, что и родитель модели), опционально.
   */
  update(t, dt, { speed = 1.1, dust = null } = {}) {
    if (!this.ok) return 0;
    const breath = Math.sin(t * 1.6) * 0.02; // дыхание
    if (this.mode === 'idle' || this.mode === 'plant') {
      const look = Math.sin(t * 0.37) * 0.5 + Math.sin(t * 0.11) * 0.3;
      this._rot('Spine', 0.05 + breath, look * 0.15, 0);
      this._rot('Neck', Math.sin(t * 0.23) * 0.12 - 0.05, look * 0.5, 0);
      const plant = this.mode === 'plant';
      // при установке флага правая рука вытянута вперёд и вниз
      this._rot('ShoulderR', plant ? -1.1 + Math.sin(t * 2) * 0.05 : -0.05 + breath, 0, plant ? 0 : -0.12);
      this._rot('ElbowR', plant ? -0.5 : -0.25, 0, 0);
      this._rot('ShoulderL', -0.05 - breath, 0, 0.12);
      this._rot('ElbowL', -0.3, 0, 0);
      for (const s of ['L', 'R']) {
        this._rot(`Hip${s}`, 0, 0, 0);
        this._rot(`Knee${s}`, 0.04, 0, 0);
      }
      this.object.position.y = 0;
      return 0;
    }

    // галоп: период ~ время полёта при отталкивании 0.9 м/с вверх: T = 2v/g ≈ 1.1 с
    const period = (2 * 0.9) / G_MOON;
    this.phase += (dt / period) * Math.min(1.4, speed / 1.1);
    const p = this.phase % 1;
    const air = p < 0.78; // 78% цикла в полёте
    const k = air ? p / 0.78 : 0;
    const hop = air ? 0.28 * 4 * k * (1 - k) : 0; // парабола
    const crouch = air ? 0 : Math.sin(((p - 0.78) / 0.22) * Math.PI); // присед при касании
    const swing = Math.sin(p * Math.PI * 2);

    this._rot('Pelvis', 0, 0, swing * 0.04);
    this._rot('Spine', 0.16 + breath + crouch * 0.08, swing * 0.06, 0);
    this._rot('Neck', -0.12 - crouch * 0.05, Math.sin(t * 0.3) * 0.25, 0);
    this._rot('HipL', -0.35 * swing - crouch * 0.5, 0, 0);
    this._rot('HipR', 0.35 * swing - crouch * 0.5, 0, 0);
    this._rot('KneeL', 0.25 + Math.max(0, swing) * 0.35 + crouch * 0.8, 0, 0);
    this._rot('KneeR', 0.25 + Math.max(0, -swing) * 0.35 + crouch * 0.8, 0, 0);
    this._rot('ShoulderL', 0.3 * swing - 0.15, 0, 0.18);
    this._rot('ShoulderR', -0.3 * swing - 0.15, 0, -0.18);
    this._rot('ElbowL', -0.45 - crouch * 0.2, 0, 0);
    this._rot('ElbowR', -0.45 - crouch * 0.2, 0, 0);

    // касание грунта → выброс пыли из-под ботинок
    if (!air && this.lastAir && dust) {
      const w = new THREE.Vector3();
      this.object.getWorldPosition(w);
      const local = dust.points.parent ? dust.points.parent.worldToLocal(w.clone()) : w;
      kickDust(dust, local.x, 0, local.z, { n: 30, speed: 1.4, size: 0.06 });
    }
    this.lastAir = air;
    return hop * (1 - crouch * 0.4) - crouch * 0.08;
  }
}
