/* ════════════════════════════════════════════════════════════════
   Consomni — jsonl.ts
   Parser READ-ONLY de un transcript de Claude Code → Session.
   - Lee head+tail para no cargar archivos de varios MB enteros.
   - Deriva: name, cwd, branch, mode, model, tokens, ctx%, actividad,
     últimas tool calls y un estado heurístico (los hooks lo refinan en Fase 3).
   NUNCA escribe/mueve/borra nada (Hard Rule 3).
   ════════════════════════════════════════════════════════════════ */
import * as fs from 'fs';
import * as path from 'path';
import type {
  Session, SessionMode, SessionState, ToolCall, LocalSessionState,
} from './types';

/* ── lectura eficiente: archivos chicos enteros; grandes, head+tail ── */
const MAX_FULL = 1_500_000; // 1.5MB
const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 384 * 1024;

interface Chunks { head: string[]; tail: string[]; }

function readChunks(filePath: string): Chunks {
  const size = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, 'r');
  try {
    if (size <= MAX_FULL) {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
      return { head: lines, tail: lines };
    }
    const hbuf = Buffer.alloc(HEAD_BYTES);
    fs.readSync(fd, hbuf, 0, HEAD_BYTES, 0);
    const tbuf = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, tbuf, 0, TAIL_BYTES, size - TAIL_BYTES);
    const head = hbuf.toString('utf8').split(/\r?\n/).filter(Boolean);
    const tailRaw = tbuf.toString('utf8').split(/\r?\n/);
    tailRaw.shift(); // descartar primera línea (posiblemente cortada)
    return { head, tail: tailRaw.filter(Boolean) };
  } finally {
    fs.closeSync(fd);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = any;

function parseLines(lines: string[]): Rec[] {
  const out: Rec[] = [];
  for (const ln of lines) {
    try { out.push(JSON.parse(ln)); } catch { /* línea parcial/corrupta: saltar */ }
  }
  return out;
}

function lastWhere(recs: Rec[], pred: (r: Rec) => boolean): Rec | undefined {
  for (let i = recs.length - 1; i >= 0; i--) if (pred(recs[i])) return recs[i];
  return undefined;
}

/* ── helpers de formato/mapeo ── */
export function formatTokens(n: number): string {
  if (!n || n < 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

export function prettyModel(m: string | undefined): string {
  if (!m) return '';
  let s = m.replace(/^claude-/, '').replace(/\[1m\]/i, '');
  s = s.replace(/-(\d{6,})$/, '');                 // strip fecha ej -20251001
  const mm = s.match(/^([a-z]+)-(\d+)-(\d+)/);     // opus-4-8 → opus 4.8
  if (mm) return mm[1] + ' ' + mm[2] + '.' + mm[3];
  return s.replace(/-/g, ' ');
}

function modeFromPermission(pm: string | undefined): SessionMode {
  switch (pm) {
    case 'plan': return 'plan';
    case 'acceptEdits': return 'edit';
    case 'bypassPermissions': return 'auto';
    default: return 'ask'; // 'default' u otros
  }
}

function windowForModel(model: string | undefined): number {
  if (!model) return 200_000;
  if (/\[1m\]|1m\b/i.test(model)) return 1_000_000;
  return 200_000;
}

export function lvlFor(ctxPct: number, state: SessionState): 'green' | 'amber' | 'red' | 'dim' {
  if (state === 'standby') return 'dim';
  if (ctxPct > 90) return 'red';
  if (ctxPct >= 75) return 'amber';
  return 'green';
}

export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
    if (t) return t.text;
  }
  return '';
}

function deriveName(headRecs: Rec[]): string {
  const first = headRecs.find(
    (r) => r.type === 'user' && r.parentUuid == null && !r.isMeta && !r.isCompactSummary,
  );
  let txt = first ? textFromContent(first.message?.content) : '';
  txt = (txt || '').split(/\r?\n/).find((l) => l.trim()) || txt;
  txt = txt.replace(/^[#>\s*-]+/, '').trim();
  if (!txt) return 'sesión';
  return txt.length > 58 ? txt.slice(0, 58).trimEnd() + '…' : txt;
}

function firstArgOf(name: string, input: Rec): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (input.command) return String(input.command);
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return String(input.pattern);
  if (input.path) return String(input.path);
  if (input.description) return String(input.description);
  if (input.prompt) return String(input.prompt).slice(0, 60);
  return undefined;
}

function collectToolCalls(recs: Rec[], max: number): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const r of recs) {
    if (r.type !== 'assistant') continue;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    const ts = Date.parse(r.timestamp || '') || 0;
    for (const b of content) {
      if (b && b.type === 'tool_use') {
        calls.push({ tool: String(b.name || '?'), arg: firstArgOf(b.name, b.input), ts });
      }
    }
  }
  return calls.slice(-max);
}

const ACTIVE_MS = 90 * 1000;       // < 90s sin hooks ⇒ "working"
const IDLE_MS = 24 * 60 * 60 * 1000; // > 24h ⇒ "closed" (a cerradas)

function deriveState(lastAssistant: Rec | undefined, lastRec: Rec | undefined, ageMs: number): SessionState {
  // Heurística sin hooks (los hooks la sobreescriben en Fase 3).
  if (ageMs > IDLE_MS) return 'closed';
  if (ageMs < ACTIVE_MS) {
    // 'working' SÓLO si claude está realmente en medio de algo:
    if (lastRec && lastRec.type === 'user') return 'working';                          // tool_result / prompt recién llegó → va a seguir
    if (lastAssistant && lastAssistant.message?.stop_reason === 'tool_use') return 'working'; // pidió una tool, espera resultado
    return 'idle';   // el último turno terminó (end_turn / texto) → esperando al usuario, NO trabajando
  }
  return 'idle';
}

export function parseSessionFile(
  filePath: string,
  local: LocalSessionState | undefined,
): Session | null {
  let chunks: Chunks;
  try { chunks = readChunks(filePath); } catch { return null; }

  const head = parseLines(chunks.head);
  const tail = parseLines(chunks.tail);
  if (head.length === 0 && tail.length === 0) return null;
  const all = chunks.head === chunks.tail ? head : head.concat(tail);

  const idFromName = path.basename(filePath).replace(/\.jsonl$/i, '');
  const anyRec = lastWhere(all, (r) => !!r.sessionId);
  const id = anyRec?.sessionId || idFromName;

  // cwd / branch / permissionMode (último válido)
  const cwd = lastWhere(tail, (r) => !!r.cwd)?.cwd
    || lastWhere(head, (r) => !!r.cwd)?.cwd || '';
  const branch = lastWhere(tail, (r) => typeof r.gitBranch === 'string')?.gitBranch
    ?? lastWhere(head, (r) => typeof r.gitBranch === 'string')?.gitBranch ?? '';
  const pmRec = lastWhere(all, (r) => typeof r.permissionMode === 'string');
  const mode = modeFromPermission(pmRec?.permissionMode);

  // modelo + usage del último turno real del assistant
  const lastAssistant = lastWhere(
    tail,
    (r) => r.type === 'assistant' && r.message?.model && r.message.model !== '<synthetic>',
  ) || lastWhere(all, (r) => r.type === 'assistant' && r.message?.usage);
  const model = prettyModel(lastAssistant?.message?.model);
  const usage = lastAssistant?.message?.usage || {};
  const tokensIn = usage.input_tokens || 0;
  const tokensOut = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const cache = cacheRead + cacheCreate;
  const ctxTokens = tokensIn + cacheRead + cacheCreate; // ocupación actual de contexto
  // El sufijo [1m] no siempre figura en message.model: si el contexto supera 200k,
  // la sesión es de ventana 1M. Inferimos la ventana efectiva.
  let windowSize = windowForModel(lastAssistant?.message?.model);
  if (ctxTokens > windowSize) windowSize = 1_000_000;
  const ctxPct = Math.max(0, Math.min(100, Math.round((ctxTokens / windowSize) * 100)));

  // actividad
  let lastActivity = 0;
  for (const r of tail) { const t = Date.parse(r.timestamp || ''); if (t > lastActivity) lastActivity = t; }
  if (!lastActivity) { try { lastActivity = fs.statSync(filePath).mtimeMs; } catch { lastActivity = Date.now(); } }
  const ageMs = Date.now() - lastActivity;

  const lastRec = tail[tail.length - 1];
  let state: SessionState = deriveState(lastAssistant, lastRec, ageMs);
  if (local?.archived) state = 'closed';

  const toolCalls = collectToolCalls(tail, 12);
  const lastTool = toolCalls[toolCalls.length - 1];

  // status text/em según estado
  let statusText = '';
  let statusEm: string | undefined;
  let statusKind: SessionState | 'green' = 'idle';
  if (state === 'working') {
    statusKind = 'green';
    statusText = 'trabajando…';
    if (lastTool) {
      const a = lastTool.arg || '';
      let short = (a.indexOf('/') > -1 || a.indexOf('\\') > -1) ? path.basename(a) : a;
      short = short.replace(/\s+/g, ' ').trim();
      if (short.length > 22) short = short.slice(0, 22) + '…';
      statusEm = lastTool.tool + (short ? ' ' + short : '');
    }
  } else if (state === 'idle') {
    statusKind = 'idle';
    statusText = 'idle · ' + formatAge(ageMs);
  } else if (state === 'closed') {
    statusKind = 'idle';
    statusText = 'cerrada · ' + formatAge(ageMs);
  }

  const session: Session = {
    id,
    name: deriveName(head),
    project: cwd ? path.basename(cwd) : (id.slice(0, 8)),
    projectPath: cwd || idFromName,
    cwd,
    branch: branch || '',
    mode,
    model,
    windowSize,
    tokensIn,
    tokensOut,
    tokensTotal: ctxTokens,
    cache,
    ctxPct,
    state,
    statusText,
    statusEm,
    lastActivity,
    lastToolCalls: toolCalls,
    fav: local?.fav,
    pinned: local?.pinned,
    stateSource: 'jsonl',
  };
  // adjuntamos el "kind" para que el renderer elija el lead del status sin recomputar
  (session as Session & { statusKind?: string }).statusKind = statusKind;
  return session;
}

/* ════════ detalle de sesión (para el panel E2) ════════ */
export interface ConvoTurn { role: 'user' | 'assistant'; text: string; ts: number; }
export interface SessionDetail {
  feed: ToolCall[];
  files: { name: string; edits: number }[];
  counts: { edits: number; bash: number; reads: number };
  convo: ConvoTurn[];
}

/** Extrae texto plano de message.content (string o array de bloques). */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/** Ruido de slash-commands / tool_result / interrupciones que NO es conversación real. */
function isConvoNoise(t: string): boolean {
  if (!t) return true;
  return /^<(command|local-command|system-reminder|user-prompt-submit)/i.test(t) ||
    t.startsWith('[Request interrupted') || t.startsWith('Caveat:');
}

export function parseSessionDetail(filePath: string): SessionDetail {
  const empty: SessionDetail = { feed: [], files: [], counts: { edits: 0, bash: 0, reads: 0 }, convo: [] };
  let chunks: Chunks;
  try { chunks = readChunks(filePath); } catch { return empty; }
  const recs = parseLines(chunks.head === chunks.tail ? chunks.head : chunks.head.concat(chunks.tail));
  const counts = { edits: 0, bash: 0, reads: 0 };
  const fileMap = new Map<string, number>();

  // conversación reciente (turnos user/assistant con texto real)
  const convo: ConvoTurn[] = [];
  const seenAsst = new Set<string>();
  for (const r of recs) {
    if (r.isMeta) continue;
    const ts = r.timestamp ? Date.parse(r.timestamp) : 0;
    if (r.type === 'user') {
      const t = textOfContent(r.message?.content).trim();
      if (t && !isConvoNoise(t)) convo.push({ role: 'user', text: t.slice(0, 6000), ts });
    } else if (r.type === 'assistant') {
      const id = r.message?.id;
      if (id) { if (seenAsst.has(id)) continue; seenAsst.add(id); }
      const t = textOfContent(r.message?.content).trim();
      if (t) convo.push({ role: 'assistant', text: t.slice(0, 6000), ts });
    }
  }
  const convoTail = convo.slice(-40);
  for (const r of recs) {
    if (r.type !== 'assistant') continue;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      const name = String(b.name || '');
      if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
        counts.edits++;
        const fp = b.input?.file_path;
        if (fp) { const bn = path.basename(String(fp)); fileMap.set(bn, (fileMap.get(bn) || 0) + 1); }
      } else if (name === 'Bash') counts.bash++;
      else if (name === 'Read' || name === 'Grep' || name === 'Glob') counts.reads++;
    }
  }
  const files = Array.from(fileMap.entries())
    .map(([name, edits]) => ({ name, edits }))
    .sort((a, b) => b.edits - a.edits)
    .slice(0, 8);
  return { feed: collectToolCalls(recs, 24), files, counts, convo: convoTail };
}
