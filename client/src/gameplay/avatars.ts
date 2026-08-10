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
 *
 * Skins (see `skins.ts`) dress those capsules with per-part materials and
 * surface-hugging gear; the base capsules render with a small radial inset so
 * the gear shells stand proud while staying inside the hitbox. Team identity
 * deliberately does NOT touch the body: teammates get a team-coloured
 * nameplate + ground rim, enemies get nothing (an enemy nameplate drawn
 * through geometry is a wallhack), and in FFA nobody gets either.
 */

import * as THREE from 'three';

import { HITBOX_TEMPLATE, stanceScale } from '../../../shared/hitbox.js';
import { PLAYER_RADIUS, eyeHeightForStance } from '../../../shared/tuning.js';
import {
  HitboxPart,
  SkinId,
  Stance,
  TeamId,
  type Loadout,
  type PlayerId,
  type Vec3,
} from '../../../shared/types.js';
import { HEAD_INSET, LIMB_INSET, buildSkinAppearance, type SkinAppearance } from './skins.js';
import { buildWeaponMesh } from './viewmodel.js';

const TEAM_COLORS: Record<number, number> = {
  [TeamId.Alpha]: 0x4da3ff,
  [TeamId.Bravo]: 0xff8b4d,
};

const UP = new THREE.Vector3(0, 1, 0);

/** Nameplates fade from full strength here… */
const NAMEPLATE_FADE_START = 50;
/** …to invisible here. */
const NAMEPLATE_FADE_END = 65;
const NAMEPLATE_BASE_OPACITY = 0.85;

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

/** Per-frame context the pool needs to resolve teammate identity + fades. */
export interface AvatarViewContext {
  /** The local player's team — nameplates are teammates-only. */
  localTeam: TeamId;
  /** Camera position, for the nameplate distance fade. */
  cameraPos: Vec3;
}

class Avatar {
  readonly group = new THREE.Group();
  private readonly stanceGroup = new THREE.Group();
  private readonly weaponAnchor = new THREE.Group();
  private body: THREE.Mesh[] = [];
  private appearance: SkinAppearance | null = null;
  private skin: SkinId | null = null;
  private weapon: THREE.Group | null = null;
  private weaponKey = '';

  // --- teammate identity ---------------------------------------------------
  private readonly plate: THREE.Sprite;
  private readonly plateMat: THREE.SpriteMaterial;
  private plateTex: THREE.CanvasTexture | null = null;
  private plateKey = '';
  private readonly rim: THREE.Mesh;
  private readonly rimMat: THREE.MeshBasicMaterial;

  constructor(skin: SkinId) {
    // Roughly where a rifle sits when shouldered: right of centre, chest height.
    this.weaponAnchor.position.set(PLAYER_RADIUS * 0.75, 1.36, -0.12);
    this.stanceGroup.add(this.weaponAnchor);
    this.group.add(this.stanceGroup);
    this.setSkin(skin);

    // Teammate nameplate: drawn through geometry at reduced opacity (that is
    // the point of it — you should never shoot the player behind a wall
    // because you could not tell they were friendly).
    this.plateMat = new THREE.SpriteMaterial({
      transparent: true,
      opacity: NAMEPLATE_BASE_OPACITY,
      depthTest: false,
      depthWrite: false,
    });
    this.plate = new THREE.Sprite(this.plateMat);
    this.plate.renderOrder = 90;
    this.plate.scale.set(0.85, 0.21, 1);
    this.plate.visible = false;
    this.group.add(this.plate);

    // Thin team rim at the feet.
    this.rimMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    this.rim = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.4, 28), this.rimMat);
    this.rim.rotation.x = -Math.PI / 2;
    this.rim.position.y = 0.03;
    this.rim.visible = false;
    this.group.add(this.rim);
  }

  private buildCapsule(a: Vec3, b: Vec3, radius: number, mat: THREE.Material, inset: number): THREE.Mesh {
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
    // Radial inset only (see skins.ts): the visual silhouette sits a hair
    // inside the hitbox so the surface-hugging gear shells actually render.
    mesh.scale.set(inset, 1, inset);
    return mesh;
  }

  private setSkin(skin: SkinId): void {
    if (skin === this.skin) return;
    this.skin = skin;

    for (const m of this.body) {
      this.stanceGroup.remove(m);
      m.geometry.dispose();
    }
    this.body = [];
    if (this.appearance) {
      for (const g of this.appearance.gear) this.stanceGroup.remove(g);
      this.appearance.dispose();
    }

    this.appearance = buildSkinAppearance(skin);
    for (const cap of HITBOX_TEMPLATE) {
      const mat = this.appearance.materials.get(cap.part);
      if (!mat) continue;
      const inset = cap.part === HitboxPart.Head ? HEAD_INSET : LIMB_INSET;
      const mesh = this.buildCapsule(cap.a, cap.b, cap.radius, mat, inset);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.stanceGroup.add(mesh);
      this.body.push(mesh);
    }
    // Gear mounts under the stance group so it squashes and leans with the
    // body — a crouching diver's helmet crouches too.
    for (const g of this.appearance.gear) this.stanceGroup.add(g);
  }

  private setLoadout(loadout: Loadout): void {
    this.setSkin(loadout.skin ?? SkinId.Vanguard);

    const key = `${loadout.primary}:${loadout.camo}:${loadout.attachments.join(',')}`;
    if (key === this.weaponKey) return;
    this.weaponKey = key;

    if (this.weapon) {
      this.weaponAnchor.remove(this.weapon);
      disposeTree(this.weapon);
    }
    this.weapon = buildWeaponMesh(loadout.primary, loadout.camo, loadout.attachments);
    this.weaponAnchor.add(this.weapon);
  }

  /** Rebuilds the nameplate texture when the name or team colour changes. */
  private refreshPlate(name: string, color: number): void {
    const key = `${name}:${color}`;
    if (key === this.plateKey) return;
    this.plateKey = key;

    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 128;
    const g = c.getContext('2d');
    if (g) {
      g.font = '800 64px ui-sans-serif, system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 10;
      g.strokeStyle = 'rgba(0,0,0,0.9)';
      g.strokeText(name, 256, 64);
      g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      g.fillText(name, 256, 64);
    }
    this.plateTex?.dispose();
    this.plateTex = new THREE.CanvasTexture(c);
    this.plateTex.colorSpace = THREE.SRGBColorSpace;
    this.plateMat.map = this.plateTex;
    this.plateMat.needsUpdate = true;
  }

  update(s: AvatarState, ctx: AvatarViewContext): void {
    this.group.position.set(s.position.x, s.position.y, s.position.z);
    this.group.rotation.y = s.yaw;

    // Stance is a Y squash of the same capsules the server tests against, so
    // the silhouette and the hitboxes stay in lockstep.
    const squash = stanceScale(s.stance);
    this.stanceGroup.scale.y = squash;

    // The weapon tracks pitch so a player aiming up at you looks like it.
    this.weaponAnchor.rotation.x = -s.pitch;
    this.weaponAnchor.position.y = eyeHeightForStance(Stance.Stand) - 0.26;

    this.group.visible = s.alive;
    this.setLoadout(s.loadout);

    // --- teammate identity -------------------------------------------------
    // Nameplate + rim on TEAMMATES ONLY: enemies get nothing (an enemy plate
    // is a wallhack), and FFA/unplaced players get nothing either.
    const isTeammate =
      (s.team === TeamId.Alpha || s.team === TeamId.Bravo) && s.team === ctx.localTeam;
    if (isTeammate && s.alive) {
      const color = TEAM_COLORS[s.team];
      this.refreshPlate(s.name || 'TEAMMATE', color);
      const dx = s.position.x - ctx.cameraPos.x;
      const dy = s.position.y - ctx.cameraPos.y;
      const dz = s.position.z - ctx.cameraPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const fade = 1 - Math.min(1, Math.max(0, (dist - NAMEPLATE_FADE_START) / (NAMEPLATE_FADE_END - NAMEPLATE_FADE_START)));
      this.plate.visible = fade > 0.01;
      this.plateMat.opacity = NAMEPLATE_BASE_OPACITY * fade;
      // The plate rides above the (stance-squashed) head, outside stanceGroup
      // so the text never distorts.
      this.plate.position.y = squash * 1.95;
      this.rim.visible = true;
      this.rimMat.color.setHex(color);
    } else {
      this.plate.visible = false;
      this.rim.visible = false;
    }
  }

  dispose(): void {
    for (const m of this.body) m.geometry.dispose();
    if (this.weapon) disposeTree(this.weapon);
    this.appearance?.dispose();
    this.plateTex?.dispose();
    this.plateMat.dispose();
    this.rim.geometry.dispose();
    this.rimMat.dispose();
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

  sync(players: Iterable<[PlayerId, AvatarState]>, ctx: AvatarViewContext): void {
    this.seen.clear();

    for (const [id, state] of players) {
      this.seen.add(id);
      let avatar = this.avatars.get(id);
      if (!avatar) {
        avatar = new Avatar(state.loadout.skin ?? SkinId.Vanguard);
        this.avatars.set(id, avatar);
        this.scene.add(avatar.group);
      }
      avatar.update(state, ctx);
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
