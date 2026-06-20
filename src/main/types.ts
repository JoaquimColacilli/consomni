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

/* ── planes / specs detectados desde el transcript (read-only) ──
   ExitPlanMode = "se presentó un plan"; TodoWrite/Task* = checklist
   pendiente/en curso/hecho. Todo sale de los .jsonl que ya leemos. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export interface PlanTodo {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}
/** Documento de plan/spec (markdown) hallado en el repo (glob, read-only). */
export interface PlanDoc {
  path: string;
  name: string;
  mtime: number;
}
export interface SessionPlan {
  hasPlan: boolean;        // se vio ExitPlanMode (plan presentado)
  planAt?: number;         // ts del último ExitPlanMode
  todos: PlanTodo[];       // último snapshot de TodoWrite / Task*
  pending: number;
  inProgress: number;
  completed: number;
  todoAt?: number;         // ts de la última actualización de tareas
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
  plan?: SessionPlan;     // planes/tareas detectados (sólo si hay alguno)
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

/* ── Biblioteca de prompts/skills/rules (100% local, ~/.consomni/library.json) ──
   El usuario guarda y reutiliza los prompts que usa seguido. No sale de la máquina. */
export type LibKind = 'prompt' | 'skill' | 'rule';
export interface LibEntry {
  id: string;          // 'lib_' + base36(ts)+rand — generado en el renderer
  kind: LibKind;
  title: string;
  content: string;
  tags: string[];      // normalizados: trim + lowercase, sin vacíos
  createdAt: number;
  updatedAt: number;
  seed?: boolean;      // ejemplo sembrado de fábrica (no se re-siembra si lo borrás)
}
export interface LibraryFile {
  entries: LibEntry[];
  seeded: boolean;     // ya se sembraron los ejemplos iniciales (idempotente)
}

/** Lo que el main empuja al renderer en cada actualización. */
export interface Snapshot {
  sessions: Session[];
  hooksConnected: boolean;
  tokensToday: number;
  generatedAt: number;
  watchedRoots: string[];
  appVersion: string;
}
