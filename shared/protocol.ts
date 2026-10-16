import type { Emote, Social, TeamId } from './config';
import type { MatchSize } from './arena';
import type { Look } from './look';

export type { Look, Piece } from './look';

export interface PlayerInfo {
  id: number;
  name: string;
  team: TeamId;
  look: Look;
  bot?: boolean;
  role?: 'police'; // policial de patrulha (bot neutro, armado, não entra na contagem dos lados)
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
  | { t: 'queue'; mode: EventMode; size: MatchSize; rounds: number; bots: boolean } // rounds: 0 = livre (renasce)
  | { t: 'unqueue' }
  | { t: 'minput'; dx: number; dz: number; run: boolean; jump: boolean; ads: boolean; yaw: number; pitch: number; x: number; z: number; y: number }
  | { t: 'shoot'; yaw: number; pitch: number; ads: boolean }
  | { t: 'throw'; yaw: number; pitch: number } // granada
  | { t: 'reload' }
  | { t: 'use' } // abrir baú
  | { t: 'switch'; w: number }
  | { t: 'quitMatch' }
  // ----- Avenida: agressão, interações e lista de online -----
  | { t: 'attack'; kind: AttackKind; ambient?: boolean } // ambient: acertou alguém da multidão de fundo
  | { t: 'social'; kind: Social; target: number }
  | { t: 'socialReply'; from: number; accept: boolean }
  | { t: 'who' };

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
  | { t: 'queued'; mode: EventMode; size: MatchSize; rounds: number; teams: [number, number]; startsIn: number | null }
  | { t: 'unqueued' }
  | {
      t: 'match';
      mode: EventMode;
      size: MatchSize;
      rounds: number; // 0 = livre (3 min, renasce)
      round: number;
      seed: number;
      you: number;
      players: MatchPlayerInfo[];
      phase: MatchPhase;
      endsAt: number; // relógio do servidor (ms)
      now: number;
      opened: number[]; // baús já abertos
    }
  | { t: 'msnap'; s: number[] } // [id, x, z, y, yaw, pitch, moving, hp, weapon, armor] por jogador
  | { t: 'phase'; phase: MatchPhase; endsAt: number; now: number; round: number; wins: [number, number]; roundWinner?: TeamId | -1 }
  | { t: 'shot'; id: number; w: number; from: [number, number, number]; to: [number, number, number][] }
  | { t: 'proj'; rid: number; id: number; kind: ProjKind; pos: [number, number, number]; vel: [number, number, number] }
  | { t: 'boom'; rid: number; kind: ProjKind; pos: [number, number, number] }
  | { t: 'hit'; target: number; by: number; dmg: number; hp: number; head: boolean }
  | { t: 'kill'; killer: number; victim: number; w: number; head: boolean }
  | { t: 'respawn'; id: number; x: number; z: number }
  | { t: 'correct'; x: number; z: number; y: number } // posição recusada pelo servidor
  | { t: 'chest'; id: number; open: boolean; by?: number; w?: number; armor?: number; nades?: number }
  | { t: 'inv'; cur: number; ammo: number[]; reserve: number[]; reloading: boolean; armor: number; nades: number }
  | { t: 'score'; teams: [number, number]; stats: MatchStat[] }
  | { t: 'matchEnd'; teams: [number, number]; winner: TeamId | -1; stats: MatchStat[] }
  // ----- Avenida: agressão, interações e lista de online -----
  | { t: 'attack'; id: number; target: number; kind: AttackKind; knocked: boolean }
  | { t: 'moved'; x: number; z: number; yaw?: number } // o servidor reposicionou você
  | { t: 'slide'; vx: number; vz: number; ms: number } // deslize (empurrão/golpe/avanço do soco)
  | { t: 'jail'; until: number; now: number; where: 'cell' | 'outside'; reason: string }
  | { t: 'free' }
  | { t: 'socialAsk'; from: number; kind: Social }
  | { t: 'socialStart'; a: number; b: number; kind: Social; ayaw: number; byaw: number }
  | { t: 'socialEnd'; a: number; b: number }
  | { t: 'notice'; text: string }
  | { t: 'roster'; list: RosterEntry[] };

export type AttackKind = 'hit' | 'push';
export interface RosterEntry {
  name: string;
  team: TeamId;
  where: 'avenida' | 'evento' | 'fila' | 'preso';
}

export type EventMode = 'fps';
export type MatchPhase = 'countdown' | 'live' | 'roundEnd' | 'ended';
export const ROUND_OPTIONS = [0, 1, 3, 5, 7, 9] as const;

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
export const MSNAP_STRIDE = 10;
export type ProjKind = 'rocket' | 'nade';
