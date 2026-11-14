import * as THREE from 'three';
import { Sky } from './sky.js';
import { latLonToVector } from '../coords.js';
import { siteFrame } from './horizon.js';
import { R_KM } from '../polar/PolarData.js';

// Вид с поверхности для точек вне тайла полюса (Apollo, Chang'e 4 и т.д.).
// Детального рельефа здесь нет — гладкая сфера R с честной пометкой «terrain not modeled».
// Локальная система (км): X — восток, Y — вверх, Z — юг; начало — точка на сфере.

const EARTH_RADIUS_KM = 6371;

export class SphereSiteView {
  constructor({ onAssetError } = {}) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.0005, 30000);

    this.sunLight = new THREE.DirectionalLight(0xffffff, 3.2);
    this.earthLight = new THREE.DirectionalLight(0x9db8ff, 0);
    this.scene.add(this.sunLight, this.sunLight.target, this.earthLight, this.earthLight.target);

    // гладкий «колпак» сферы радиусом 120 км: y = −d²/(2R) (край лунной сферы)
    const g = new THREE.CircleGeometry(120, 160, 0, Math.PI * 2).rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const d2 = p.getX(i) ** 2 + p.getZ(i) ** 2;
      p.setY(i, -d2 / (2 * R_KM));
    }
    g.computeVertexNormals();
    this.ground = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x3a3936, roughness: 1, metalness: 0 }));
    this.scene.add(this.ground);

    this.sky = null;
    this.onAssetError = onAssetError;
    this.models = new THREE.Group();
    this.scene.add(this.models);
  }

  /** Перестроить локальную систему под точку (lat, lon). */
  setSite(lat, lon) {
    this.siteMoon = latLonToVector(lat, lon, R_KM);
    this.frame = siteFrame(this.siteMoon);
    const { east, up, north } = this.frame;
    // строки матрицы: восток, вверх, юг → «система Луны → локальная»
    const m = new THREE.Matrix4().set(
      east.x, east.y, east.z, 0,
      up.x, up.y, up.z, 0,
      -north.x, -north.y, -north.z, 0,
      0, 0, 0, 1,
    );
    this.moonToLocal = new THREE.Quaternion().setFromRotationMatrix(m);
    if (this.sky) {
      this.sky.clearDome();
      this.scene.remove(this.sky.group);
    }
    this.sky = new Sky({ moonToLocal: this.moonToLocal, onAssetError: this.onAssetError });
    this.scene.add(this.sky.group);
  }

  dirToLocal(d, out = new THREE.Vector3()) {
    return out.copy(d).applyQuaternion(this.moonToLocal);
  }

  /** Положение глаза в системе Луны (для параллакса Земли). */
  eyeMoon(camera = this.camera) {
    const inv = this.moonToLocal.clone().invert();
    return camera.position.clone().applyQuaternion(inv).add(this.siteMoon);
  }

  applyState(sub, date) {
    const sunDir = latLonToVector(sub.sunLat, sub.sunLon);
    const earthPos = latLonToVector(sub.earthLat, sub.earthLon, sub.earthDistKm);
    const eye = this.eyeMoon();
    const earthDir = earthPos.clone().sub(eye).normalize();
    this.sunLight.position.copy(this.dirToLocal(sunDir)).multiplyScalar(100);
    this.earthLight.position.copy(this.dirToLocal(earthDir)).multiplyScalar(100);
    this.earthLight.intensity = this.sunLight.intensity * (this.earthshineRatio ?? 0.015) * sub.earthPhase;
    this.sky.update(this.camera, {
      sunDirMoon: sunDir,
      earthDirMoon: earthDir,
      earthAngR: Math.asin(EARTH_RADIUS_KM / earthPos.distanceTo(eye)),
      sub,
      date,
    });
    return { sunL: this.dirToLocal(sunDir) };
  }

  placeModel(object) {
    this.models.clear();
    if (!object) return;
    object.position.set(0, 0, 0);
    object.quaternion.identity();
    object.scale.setScalar(0.001);
    this.models.add(object);
  }
}
