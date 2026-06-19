/* ════════════════════════════════════════════════════════════════
   Consomni — types.ts
   Modelo de sesión (unifica A=JSONL + B=hooks) + tipos compartidos.
   ════════════════════════════════════════════════════════════════ */

export type SessionState = 'working' | 'idle' | 'standby' | 'attn' | 'error' | 'closed';
export type SessionMode = 'ask' | 'plan' | 'edit' | 'auto';

export interface ToolCall {
  tool: string;
  arg?: string;
  ts: number;
}

export interface SubagentInfo {
  name: string;
  state: SessionState;
  agentType?: string;
}

export interface Session {
  id: string;
  name: string;
  project: string;        // basename del cwd (label del proyecto)
  projectPath: string;    // cwd completo (clave de agrupación / monorepo)
  cwd: string;
  branch: string;
  mode: SessionMode;
  model: string;          // ya "lindo": "opus 4.8"
  windowSize: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;    // tokens de contexto actuales (in+cache_read+cache_creation)
  cache: number;
  ctxPct: number;         // 0..100
  effort?: string;
  state: SessionState;
  statusText: string;
  statusEm?: string;
  attnReason?: string;
  lastActivity: number;   // epoch ms
  cost?: number;
  subagents?: SubagentInfo[];
  lastToolCalls?: ToolCall[];
  fav?: boolean;
  pinned?: boolean;
  selected?: boolean;
  /** origen del estado: 'jsonl' (heurístico) o 'hook' (autoritativo, Fase 3). */
  stateSource?: 'jsonl' | 'hook';
}

/** Estado local persistido por el usuario (pin/fav/archivar), no viene del JSONL. */
export interface LocalSessionState {
  pinned?: boolean;
  fav?: boolean;
  archived?: boolean;
}

/** Lo que el main empuja al renderer en cada actualización. */
export interface Snapshot {
  sessions: Session[];
  hooksConnected: boolean;
  tokensToday: number;
  generatedAt: number;
  watchedRoots: string[];
}
