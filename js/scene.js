import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060e1a);
  scene.fog = new THREE.FogExp2(0x060e1a, 0.0015);
  scene.userData.renderer = renderer;

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 150, 200);
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.minDistance = 10;
  controls.maxDistance = 800;
  controls.target.set(0, -20, 0);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0x304060, 0.6);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0x80b8e0, 1.2);
  dirLight.position.set(50, 100, 30);
  scene.add(dirLight);

  const fillLight = new THREE.DirectionalLight(0x204060, 0.4);
  fillLight.position.set(-30, 50, -50);
  scene.add(fillLight);

  const causticLight = new THREE.PointLight(0x3080c0, 0.5, 300);
  causticLight.position.set(0, 80, 0);
  scene.add(causticLight);

  let animFrameId = null;

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  function animate(callback) {
    function loop() {
      animFrameId = requestAnimationFrame(loop);
      controls.update();
      if (callback) callback();
      renderer.render(scene, camera);
    }
    loop();
    return () => {
      if (animFrameId) cancelAnimationFrame(animFrameId);
      window.removeEventListener('resize', onResize);
    };
  }

  return { renderer, scene, camera, controls, animate };
}

/**
 * Position camera to frame the terrain nicely.
 * Call after createTerrain returns.
 */
export function adjustCamera(camera, controls, terrain) {
  const { terrainWidth, terrainDepth, meanY, minY, maxY } = terrain;
  const maxDim = Math.max(terrainWidth, terrainDepth);

  // Look at sea surface level, not the deep terrain
  const targetY = Math.max(maxY, 0);
  controls.target.set(0, targetY, 0);

  // Position camera well above sea level, looking down at an angle
  const dist = maxDim * 1.0;
  const height = maxDim * 0.9;
  camera.position.set(0, targetY + height, dist * 0.65);

  // Adjust fog density based on terrain size
  camera.near = maxDim * 0.001;
  camera.far = maxDim * 10;
  camera.updateProjectionMatrix();

  controls.minDistance = maxDim * 0.1;
  controls.maxDistance = maxDim * 4;
  controls.update();
}
