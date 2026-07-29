/**
 * DECKSHOT — third-person player avatars.
 *
 * Written at integration: the fan-out covered the viewmodel (the gun in YOUR
 * hands) but nothing rendered OTHER players, and a multiplayer shooter needs
 * bodies.
 *
 * The bodies are built directly from `HITBOX_TEMPLATE` — the same capsules the
 * server hit-tests against. That is deliberate and worth keeping: in a game
 * decided by one-shot headshots, a visual model that is fatter, thinner or
 * taller than the hitbox is a fairness bug that players experience as "the hit
 * detection is broken". Building both from one source makes that class of bug
 * impossible rather than merely unlikely.
 */

import * as THREE from 'three';

import { HITBOX_TEMPLATE, stanceScale } from '../../../shared/hitbox.js';
import { PLAYER_RADIUS, eyeHeightForStance } from '../../../shared/tuning.js';
import { HitboxPart, Stance, TeamId, type Loadout, type PlayerId, type Vec3 } from '../../../shared/types.js';
import { buildWeaponMesh } from './viewmodel.js';

const TEAM_COLORS: Record<number, number> = {
  [TeamId.FFA]: 0xc8452f,
  [TeamId.Alpha]: 0x2f7fc8,
  [TeamId.Bravo]: 0xc8892f,
  [TeamId.None]: 0x777777,
};

/** Parts rendered with the darker "gear" material rather than body colour. */
const GEAR_PARTS = new Set<HitboxPart>([HitboxPart.Head, HitboxPart.ArmL, HitboxPart.ArmR]);

const UP = new THREE.Vector3(0, 1, 0);

export interface AvatarState {
  position: Vec3;
  yaw: number;
  pitch: number;
  stance: Stance;
  alive: boolean;
  team: TeamId;
  name: string;
  loadout: Loadout;
}

class Avatar {
  readonly group = new THREE.Group();
  private readonly stanceGroup = new THREE.Group();
  private readonly weaponAnchor = new THREE.Group();
  private readonly body: THREE.Mesh[] = [];
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly gearMat: THREE.MeshStandardMaterial;
  private weapon: THREE.Group | null = null;
  private weaponKey = '';
  private team: TeamId = TeamId.None;

  constructor(team: TeamId) {
    this.team = team;
    const color = TEAM_COLORS[team] ?? TEAM_COLORS[TeamId.None];

    this.bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.05 });
    this.gearMat = new THREE.MeshStandardMaterial({ color: 0x24282e, roughness: 0.6, metalness: 0.25 });

    for (const cap of HITBOX_TEMPLATE) {
      const mesh = this.buildCapsule(cap.a, cap.b, cap.radius, GEAR_PARTS.has(cap.part) ? this.gearMat : this.bodyMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.stanceGroup.add(mesh);
      this.body.push(mesh);
    }

    // Roughly where a rifle sits when shouldered: right of centre, chest height.
    this.weaponAnchor.position.set(PLAYER_RADIUS * 0.75, 1.36, -0.12);
    this.stanceGroup.add(this.weaponAnchor);

    this.group.add(this.stanceGroup);
  }

  private buildCapsule(a: Vec3, b: Vec3, radius: number, mat: THREE.Material): THREE.Mesh {
    const va = new THREE.Vector3(a.x, a.y, a.z);
    const vb = new THREE.Vector3(b.x, b.y, b.z);
    const seg = new THREE.Vector3().subVectors(vb, va);
    const len = seg.length();

    // CapsuleGeometry's cylindrical section runs along +Y and excludes the
    // hemispherical caps, so its length argument is the segment length.
    const geo = new THREE.CapsuleGeometry(radius, len, 4, 10);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(va).addScaledVector(seg, 0.5);
    if (len > 1e-6) {
      mesh.quaternion.setFromUnitVectors(UP, seg.normalize());
    }
    return mesh;
  }

  setTeam(team: TeamId): void {
    if (team === this.team) return;
    this.team = team;
    this.bodyMat.color.setHex(TEAM_COLORS[team] ?? TEAM_COLORS[TeamId.None]);
  }

  setLoadout(loadout: Loadout): void {
    const key = `${loadout.primary}:${loadout.camo}:${loadout.attachments.join(',')}`;
    if (key === this.weaponKey) return;
    this.weaponKey = key;

    if (this.weapon) {
      this.weaponAnchor.remove(this.weapon);
      disposeTree(this.weapon);
    }
    this.weapon = buildWeaponMesh(loadout.primary, loadout.camo, loadout.attachments);
    this.weapon.scale.setScalar(1.0);
    this.weaponAnchor.add(this.weapon);
  }

  update(s: AvatarState): void {
    this.group.position.set(s.position.x, s.position.y, s.position.z);
    this.group.rotation.y = s.yaw;

    // Stance is a Y squash of the same capsules the server tests against, so
    // the silhouette and the hitboxes stay in lockstep.
    this.stanceGroup.scale.y = stanceScale(s.stance);

    // The weapon tracks pitch so a player aiming up at you looks like it.
    this.weaponAnchor.rotation.x = -s.pitch;
    this.weaponAnchor.position.y = eyeHeightForStance(Stance.Stand) - 0.26;

    this.group.visible = s.alive;
    this.setTeam(s.team);
    this.setLoadout(s.loadout);
  }

  dispose(): void {
    for (const m of this.body) m.geometry.dispose();
    if (this.weapon) disposeTree(this.weapon);
    this.bodyMat.dispose();
    this.gearMat.dispose();
  }
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
  });
}

/**
 * Pools avatars by player id. Call `sync` once per frame with the interpolated
 * remote players; it creates, updates and retires bodies as players come and go.
 */
export class AvatarPool {
  private readonly avatars = new Map<PlayerId, Avatar>();
  private readonly seen = new Set<PlayerId>();

  constructor(private readonly scene: THREE.Scene) {}

  sync(players: Iterable<[PlayerId, AvatarState]>): void {
    this.seen.clear();

    for (const [id, state] of players) {
      this.seen.add(id);
      let avatar = this.avatars.get(id);
      if (!avatar) {
        avatar = new Avatar(state.team);
        this.avatars.set(id, avatar);
        this.scene.add(avatar.group);
      }
      avatar.update(state);
    }

    for (const [id, avatar] of this.avatars) {
      if (this.seen.has(id)) continue;
      this.scene.remove(avatar.group);
      avatar.dispose();
      this.avatars.delete(id);
    }
  }

  get(id: PlayerId): THREE.Object3D | undefined {
    return this.avatars.get(id)?.group;
  }

  dispose(): void {
    for (const [, avatar] of this.avatars) {
      this.scene.remove(avatar.group);
      avatar.dispose();
    }
    this.avatars.clear();
  }
}
