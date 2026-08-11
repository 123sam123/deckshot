/**
 * DECKSHOT — ZOMBIES zone doors, as individual meshes.
 *
 * Owner: zombies.
 *
 * The old mode threw away the entire merged world (and its collision BVH) on
 * every zone purchase — a visible hitch, six times a match. Here the static
 * world is built ONCE without door brushes, and each door is its own little
 * mesh this manager shows or hides from the zone mask. Opening a door is a
 * visibility flip plus a short dissolve, not a rebuild.
 *
 * Collision stays authoritative elsewhere: the server's director and the
 * client's prediction world are both rebuilt from `collisionBrushesFor` —
 * this module is presentation only.
 */

import * as THREE from 'three';
import { brushMatrix } from './brushes.js';
import type { MapDef } from '../../../shared/maps.js';
import type { Brush } from '../../../shared/mapdata.js';
import { Audio } from '../audio/index.js';

interface DoorRec {
  zone: number;
  mesh: THREE.Mesh;
  center: THREE.Vector3;
  /** Seconds left of the open dissolve; 0 = settled. */
  dissolve: number;
}

const DISSOLVE_TIME = 0.45;

export class DoorManager {
  private readonly doors: DoorRec[] = [];
  private readonly group = new THREE.Group();
  private mask = 1;

  constructor(scene: THREE.Scene, map: MapDef, materials?: { get(m: Brush['material']): THREE.Material }) {
    this.group.name = 'zombies-doors';
    const byId = new Map(map.brushes.map((b) => [b.id, b]));
    for (let zone = 0; zone < map.doorBrushIdsByZone.length; zone++) {
      for (const id of map.doorBrushIdsByZone[zone]) {
        const brush = byId.get(id);
        if (!brush) continue;
        const geo = new THREE.BoxGeometry(brush.half.x * 2, brush.half.y * 2, brush.half.z * 2);
        const base = materials?.get(brush.material);
        // Clone so the dissolve's opacity fade cannot bleed into the shared
        // registry material every other mesh uses.
        const mat = base
          ? (base.clone() as THREE.Material)
          : new THREE.MeshStandardMaterial({ color: 0x5a5148, roughness: 0.9 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.applyMatrix4(brushMatrix(brush));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
        this.doors.push({
          zone,
          mesh,
          center: new THREE.Vector3(brush.center.x, brush.center.y, brush.center.z),
          dissolve: 0,
        });
      }
    }
    scene.add(this.group);
  }

  /** Apply the authoritative zone mask. Newly-opened doors dissolve out. */
  setZoneMask(mask: number): void {
    if (mask === this.mask) return;
    for (const d of this.doors) {
      const open = (mask & (1 << d.zone)) !== 0;
      const wasOpen = (this.mask & (1 << d.zone)) !== 0;
      if (open && !wasOpen && d.mesh.visible) {
        d.dissolve = DISSOLVE_TIME;
        Audio.play('door_open', { position: { x: d.center.x, y: d.center.y, z: d.center.z } });
      } else if (!open) {
        d.mesh.visible = true;
        d.dissolve = 0;
        const mat = d.mesh.material as THREE.Material;
        mat.transparent = false;
        mat.opacity = 1;
      }
    }
    this.mask = mask;
  }

  update(dt: number): void {
    for (const d of this.doors) {
      if (d.dissolve <= 0) continue;
      d.dissolve -= dt;
      const mat = d.mesh.material as THREE.Material;
      if (d.dissolve <= 0) {
        d.mesh.visible = false;
        mat.transparent = false;
        mat.opacity = 1;
      } else {
        mat.transparent = true;
        mat.opacity = d.dissolve / DISSOLVE_TIME;
      }
    }
  }

  dispose(): void {
    for (const d of this.doors) {
      d.mesh.geometry.dispose();
      (d.mesh.material as THREE.Material).dispose();
    }
    this.doors.length = 0;
    this.group.parent?.remove(this.group);
  }
}
