// Физика посадки (метры, секунды; локальная система точки: x — восток, y — север, z — вверх).
//
// Фазы как у Apollo (P64 → P66 → касание):
//  • APPROACH — оптимальное по энергии наведение на «ворота» над точкой (Е-наведение):
//      a_cmd = 6·(r_f − r − v·t)/t² − 2·(v_f − v)/t,  тяга = a_cmd − g, |тяга| ≤ T_max
//    модуль наклоняется назад — тяга гасит горизонтальную скорость;
//  • VERTICAL — вертикальный спуск с постоянной скоростью (тяга ≈ g), гашение остатка сноса;
//  • CONTACT — щуп касается грунта на 1.5 м → двигатель выключен → свободное падение (g = 1.62);
//  • LANDED.
// Атмосферы нет: никакого сопротивления, траектория определяется только тягой и гравитацией.

export const G_MOON = 1.62;

export class DescentSim {
  /**
   * @param {object} o
   * @param {number[]} o.approachDir — единичное горизонтальное направление прилёта [x, y]
   * @param {number} o.startAlt — высота начала подхода, м
   * @param {number} o.startRange — расстояние до точки по горизонтали, м
   * @param {number} o.thrustMax — предел ускорения от тяги, м/с² (Apollo LM ~3–4.5)
   * @param {number} o.gateAlt — высота «ворот» перед вертикальным спуском, м
   */
  constructor({ approachDir = [0, 1], startAlt = 1200, startRange = 1500, thrustMax = 4.2, gateAlt = 22, approachTime = 52 } = {}) {
    const [dx, dy] = approachDir;
    this.dir = [dx, dy];
    this.thrustMax = thrustMax;
    this.gateAlt = gateAlt;
    this.r = [-dx * startRange, -dy * startRange, startAlt];
    // начальная скорость: к точке ~45 м/с и вниз ~22 м/с (ниже траектории P64 Apollo по масштабу)
    this.v = [dx * 45, dy * 45, -22];
    this.thrust = [0, 0, G_MOON];
    this.t = 0;
    this.tgo = approachTime;
    this.phase = 'APPROACH';
    this.maxThrustSeen = 0;
    this.touchdownSpeed = null;
  }

  /** Высота над грунтом (м): groundZ — функция высоты рельефа в (x, y) относительно точки. */
  step(dt, groundZ = () => 0) {
    const r = this.r;
    const v = this.v;
    const ground = groundZ(r[0], r[1]);
    const alt = r[2] - ground;
    let a = [0, 0, 0];

    if (this.phase === 'APPROACH') {
      const t = Math.max(this.tgo, 2);
      const rf = [0, 0, this.gateAlt + groundZ(0, 0)];
      const vf = [0, 0, -1.2];
      for (let i = 0; i < 3; i++) a[i] = (6 * (rf[i] - r[i] - v[i] * t)) / (t * t) - (2 * (vf[i] - v[i])) / t;
      this.tgo -= dt;
      if (this.tgo <= 0.5 || alt <= this.gateAlt) this.phase = 'VERTICAL';
    } else if (this.phase === 'VERTICAL') {
      // гасим снос пропорционально, держим −1 м/с (последние метры — −0.8)
      const vz = alt > 6 ? -1.0 : -0.8;
      a = [-0.8 * v[0] - 0.15 * r[0], -0.8 * v[1] - 0.15 * r[1], 1.5 * (vz - v[2])];
      if (alt <= 1.5) this.phase = 'CONTACT'; // щуп коснулся грунта — «Contact light»
    }

    // тяга = требуемое ускорение − гравитация, с ограничением по модулю и без «тяги вниз»
    let T = [0, 0, 0];
    if (this.phase === 'APPROACH' || this.phase === 'VERTICAL') {
      T = [a[0], a[1], a[2] + G_MOON];
      if (T[2] < 0.2) T[2] = 0.2;
      const m = Math.hypot(...T);
      if (m > this.thrustMax) T = T.map((x) => (x * this.thrustMax) / m);
    }
    this.thrust = T;
    this.maxThrustSeen = Math.max(this.maxThrustSeen, Math.hypot(...T));

    if (this.phase !== 'LANDED') {
      for (let i = 0; i < 3; i++) v[i] += (T[i] - (i === 2 ? G_MOON : 0)) * dt;
      for (let i = 0; i < 3; i++) r[i] += v[i] * dt;
      const g2 = groundZ(r[0], r[1]);
      if (r[2] <= g2) {
        this.touchdownSpeed = Math.hypot(...v);
        r[2] = g2;
        this.v = [0, 0, 0];
        this.phase = 'LANDED';
      }
    }
    this.t += dt;
    return this.state(groundZ);
  }

  state(groundZ = () => 0) {
    const alt = this.r[2] - groundZ(this.r[0], this.r[1]);
    return {
      t: this.t,
      phase: this.phase,
      pos: [...this.r],
      vel: [...this.v],
      thrust: [...this.thrust],
      alt,
      vs: this.v[2],
      hs: Math.hypot(this.v[0], this.v[1]),
      throttle: Math.hypot(...this.thrust) / this.thrustMax,
    };
  }
}
