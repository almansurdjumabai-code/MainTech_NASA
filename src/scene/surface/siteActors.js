import * as THREE from 'three';
import { loadModel } from '../models.js';
import { AstronautRig } from '../astronautRig.js';
import { lunarDust } from '../effects.js';

// «Жизнь» на месте посадки (единицы — метры, группа масштабируется в км сцены):
// астронавт галопом обходит модуль и поднимает пыль, флаг команды ставится с анимацией из интро,
// при посадке струя двигателя сдувает реголит по баллистическим траекториям.

export class SiteActors {
  /** unit — сколько единиц сцены в 1 м (сцены полюса/поверхности в км → 0.001) */
  constructor({ unit = 0.001 } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'site-actors';
    this.dust = lunarDust(4000);
    this.dust.points.material.uniforms.uUnit.value = unit;
    this.group.add(this.dust.points);
    this.t = 0;
    this.ready = this._load();
  }

  async _load() {
    const [astro, flag] = await Promise.all([loadModel('astronaut'), loadModel('flag')]);
    if (astro) {
      this.astro = astro;
      this.rig = new AstronautRig(astro);
      this.group.add(astro);
    }
    if (flag) {
      this.flag = flag;
      flag.position.set(-6, 0, 5);
      this.group.add(flag);
      const clips = flag.userData.animations ?? [];
      if (clips.length) {
        this.mixer = new THREE.AnimationMixer(flag);
        for (const c of clips) {
          const a = this.mixer.clipAction(c);
          a.setLoop(THREE.LoopOnce);
          a.clampWhenFinished = true;
          a.play();
        }
      }
    }
  }

  /** Повторно запустить сценку: флаг ставится, астронавт идёт. */
  restart() {
    this.t = 0;
    this.mixer?.setTime(0);
    this.dust.clear();
  }

  /** Выброс реголита струёй двигателя: altM — высота сопла над грунтом, м. */
  engineBlast(altM, power = 1) {
    if (altM > 25) return;
    const k = (1 - altM / 25) * power;
    const n = Math.round(60 * k);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 15 + Math.random() * 45 * k; // пыль разлетается очень быстро и далеко — воздуха нет
      const r = 1 + Math.random() * 3;
      this.dust.spawn(Math.cos(a) * r, 0.05, Math.sin(a) * r, Math.cos(a) * v, v * (0.03 + Math.random() * 0.08), Math.sin(a) * v, 1.5 + Math.random() * 2, 0.1 + Math.random() * 0.15, { hot: false });
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.dust.geo.dispose();
    this.dust.points.material.dispose();
    this.mixer?.stopAllAction();
  }

  update(dt, { walking = true } = {}) {
    this.t += dt;
    const t = this.t;
    this.mixer?.update(dt);
    if (this.rig) {
      // первые 4 с — астронавт у флага, потом обходит модуль по кругу 9 м
      const planting = t < 4;
      this.rig.mode = !walking ? 'idle' : planting ? 'plant' : 'walk';
      if (planting || !walking) {
        this.astro.position.set(-5.2, 0, 6.2);
        this.astro.rotation.y = Math.PI * 0.75;
      } else {
        const w = 0.11; // рад/с ≈ 1 м/с по окружности 9 м
        const a = (t - 4) * w + 2.3;
        this.astro.position.set(Math.cos(a) * 9, 0, Math.sin(a) * 9);
        this.astro.rotation.y = -a; // лицом по ходу движения
      }
      const lift = this.rig.update(t, dt, { speed: 1.0, dust: this.rig.mode === 'walk' ? this.dust : null });
      this.astro.position.y = Math.max(0, lift);
    }
    this.dust.update(dt);
  }
}
