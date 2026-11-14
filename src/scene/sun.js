import * as THREE from 'three';

// Видимый диск Солнца с ореолом (спрайт далеко в направлении света).
export function createSunSprite() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.08, 'rgba(255,253,240,1)');
  g.addColorStop(0.12, 'rgba(255,240,200,0.5)');
  g.addColorStop(0.4, 'rgba(255,220,160,0.08)');
  g.addColorStop(1, 'rgba(255,220,160,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  sprite.name = 'sun-sprite';
  sprite.scale.setScalar(40);
  return sprite;
}
