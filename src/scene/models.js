import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Каталог 3D-моделей аппаратов (public/models/*.glb).
// source: откуда модель — официальный NASA 3D Resources или наш Blender-скрипт.
export const MODEL_CATALOG = {
  apollo_lm: {
    title: 'Apollo Lunar Module',
    source: 'NASA 3D Resources (official)',
    heightM: 7.0,
    script: 'scripts/blender/prep_lander.py',
  },
  artemis_lander: {
    title: 'Artemis crew lander (concept)',
    source: "Blender, procedural — artist's concept after NASA HLS illustration",
    heightM: 12.0,
    script: 'scripts/blender/build_models.py',
  },
  clps_lander: {
    title: 'CLPS robotic lander (concept)',
    source: "Blender, procedural — artist's concept",
    heightM: 3.7,
    script: 'scripts/blender/build_models.py',
  },
  astronaut_nasa: {
    title: 'Astronaut (EVA suit)',
    source: 'NASA 3D Resources (official)',
    heightM: 1.85,
    script: 'scripts/blender/prep_lander.py',
  },
  astronaut: {
    title: 'Astronaut, rigged (concept)',
    source: "Blender, procedural with joints — artist's concept",
    heightM: 1.89,
    script: 'scripts/blender/build_models.py',
  },
  lro: {
    title: 'Lunar Reconnaissance Orbiter',
    source: 'NASA 3D Resources (official)',
    heightM: null,
    script: 'scripts/blender/prep_lander.py',
  },
  flag: {
    title: 'MainTech team flag',
    source: 'Team intro (blender/intro.blend), planting animation',
    heightM: 3.2,
    script: 'scripts/blender/export_team_flag.py',
  },
  apollo14_site: {
    title: 'Apollo 14 landing site relief',
    source: 'NASA 3D Resources (official, 3D-print terrain)',
    heightM: null,
    script: 'scripts/blender/prep_site_plate.py',
  },
  apollo16_site: {
    title: 'Apollo 16 landing site relief',
    source: 'NASA 3D Resources (official, 3D-print terrain)',
    heightM: null,
    script: 'scripts/blender/prep_site_plate.py',
  },
  sls: {
    title: 'SLS Block 1B (concept)',
    source: "Blender, procedural — after NASA illustration",
    heightM: 108,
    script: 'scripts/blender/build_models.py',
  },
};

const loader = new GLTFLoader();
const cache = new Map();

/** Загружает модель (кэш), возвращает клон или null, если файла нет. */
export function loadModel(name) {
  if (!cache.has(name)) {
    cache.set(
      name,
      loader
        .loadAsync(`/models/${name}.glb`)
        .then((gltf) => {
          gltf.scene.traverse((o) => {
            if (o.isMesh) {
              o.castShadow = true;
              o.receiveShadow = true;
            }
          });
          gltf.scene.userData.animations = gltf.animations;
          return gltf.scene;
        })
        .catch((err) => {
          console.warn(`[MoonScene] model ${name}.glb unavailable:`, err.message ?? err);
          return null;
        }),
    );
  }
  return cache.get(name).then((scene) => {
    if (!scene) return null;
    const c = scene.clone(true);
    c.userData.animations = scene.userData.animations;
    return c;
  });
}

/** Какой аппарат сажать на точку данной категории. */
export function landerForSite(site) {
  if (site?.category === 'apollo') return 'apollo_lm';
  if (site?.category === 'artemis') return 'artemis_lander';
  return 'clps_lander';
}
