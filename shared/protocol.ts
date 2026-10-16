import type { Emote, TeamId } from './config';
import type { MatchSize } from './arena';
import type { Look } from './look';

export type { Look, Piece } from './look';

export interface PlayerInfo {
  id: number;
  name: string;
  team: TeamId;
  look: Look;
  bot?: boolean;
}

// Cliente -> servidor
export type ClientMsg =
  | { t: 'join'; name: string; team: TeamId; look: Look }
  | { t: 'input'; dx: number; dz: number; run: boolean; yaw: number }
  | { t: 'chat'; text: string }
  | { t: 'emote'; e: Emote }
  | { t: 'look'; look: Look } // troca o visual sem sair da avenida
  | { t: 'leave' } // volta ao menu principal mantendo a conexão
  | { t: 'ping'; ts: number }
  // ----- Eventos -----
  | { t: 'queue'; mode: EventMode; size: MatchSize; bots: boolean }
  | { t: 'unqueue' }
  | { t: 'minput'; dx: number; dz: number; run: boolean; yaw: number; pitch: number }
  | { t: 'shoot'; yaw: number; pitch: number }
  | { t: 'reload' }
  | { t: 'use' } // abrir baú
  | { t: 'switch'; w: number }
  | { t: 'quitMatch' };

// Servidor -> cliente
// snap.s é uma lista achatada: [id, x, z, yaw, moving, id, x, z, yaw, moving, ...]
export type ServerMsg =
  | { t: 'welcome'; id: number; x: number; z: number; players: PlayerInfo[] }
  | { t: 'add'; p: PlayerInfo }
  | { t: 'remove'; id: number }
  | { t: 'snap'; s: number[] }
  | { t: 'chat'; id: number; text: string }
  | { t: 'emote'; id: number; e: Emote }
  | { t: 'look'; id: number; look: Look }
  | { t: 'stats'; teams: [number, number]; online: number }
  | { t: 'pong'; ts: number }
  | { t: 'error'; msg: string }
  // ----- Eventos -----
  | { t: 'queued'; mode: EventMode; size: MatchSize; teams: [number, number]; startsIn: number | null }
  | { t: 'unqueued' }
  | {
      t: 'match';
      mode: EventMode;
      size: MatchSize;
      seed: number;
      you: number;
      players: MatchPlayerInfo[];
      phase: MatchPhase;
      endsAt: number; // relógio do servidor (ms)
      now: number;
      opened: number[]; // baús já abertos
    }
  | { t: 'msnap'; s: number[] } // [id, x, z, yaw, pitch, moving, hp, weapon] por jogador
  | { t: 'phase'; phase: MatchPhase; endsAt: number; now: number }
  | { t: 'shot'; id: number; w: number; from: [number, number, number]; to: [number, number, number][] }
  | { t: 'rocket'; rid: number; id: number; pos: [number, number, number]; vel: [number, number, number] }
  | { t: 'boom'; rid: number; pos: [number, number, number] }
  | { t: 'hit'; target: number; by: number; dmg: number; hp: number; head: boolean }
  | { t: 'kill'; killer: number; victim: number; w: number; head: boolean }
  | { t: 'respawn'; id: number; x: number; z: number }
  | { t: 'chest'; id: number; open: boolean; by?: number; w?: number }
  | { t: 'inv'; cur: number; ammo: number[]; reserve: number[]; reloading: boolean }
  | { t: 'score'; teams: [number, number]; stats: MatchStat[] }
  | { t: 'matchEnd'; teams: [number, number]; winner: TeamId | -1; stats: MatchStat[] };

export type EventMode = 'fps' | 'brawl';
export type MatchPhase = 'countdown' | 'live' | 'ended';

export interface MatchPlayerInfo extends PlayerInfo {
  team: TeamId;
}

export interface MatchStat {
  id: number;
  kills: number;
  deaths: number;
  score: number;
}

export const SNAP_STRIDE = 5;
export const MSNAP_STRIDE = 8;
