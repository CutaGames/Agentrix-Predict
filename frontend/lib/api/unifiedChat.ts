/**
 * Unified chat streaming client (LSM Phase G · Req 24).
 *
 * Streams web chat through the SAME runtime as mobile/desktop:
 * `POST /openclaw/proxy/stream` (SSE). This gives the web `UnifiedAgentChat`:
 *  - server-side conversation memory keyed by the user's platform-hosted
 *    instance (shared across web / mobile / desktop),
 *  - the platform tool registry (incl. the LSM `lsm_*` tools),
 *  - server-synced model selection,
 *  - and auto-provisioning of a platform-hosted primary instance for web-only
 *    users (handled backend-side in resolveDefaultInstanceForUser).
 *
 * Gated by `NEXT_PUBLIC_UNIFIED_CHAT`; when disabled the caller falls back to
 * the legacy `/agent/chat` path (zero regression).
 *
 * SSE wire format mirrors backend `formatSSE()` (query-engine StreamEvent):
 * each frame is one or more `data: <json>` lines terminated by a blank line;
 * `data: [DONE]` ends the stream; `:`-prefixed lines are keep-alive pings.
 */
import { API_BASE_URL } from './client';

export interface UnifiedChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface UnifiedChatRequest {
  messages: UnifiedChatMessage[];
  sessionId?: string;
  agentId?: string;
  mode?: 'ask' | 'agent' | 'plan';
  tier?: 'local' | 'smart' | 'cloud';
  context?: Record<string, any>;
  options?: { model?: string; maxTokens?: number };
}

export interface UnifiedStreamHandlers {
  /** Incremental assistant text. */
  onChunk: (text: string) => void;
  /** meta event (auto-route / tier / sessionId). */
  onMeta?: (meta: any) => void;
  /** Any non-text structured event (tool_start/tool_result/approval_required…). */
  onEvent?: (event: any) => void;
  /** Server-authoritative sessionId, when surfaced. */
  onSession?: (sessionId: string) => void;
  onDone: () => void;
  onError: (err: string) => void;
}

/** Whether the web chat should use the unified `/openclaw/proxy/stream` runtime. */
export function isUnifiedChatEnabled(): boolean {
  return process.env.NEXT_PUBLIC_UNIFIED_CHAT === '1';
}

function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return (
    localStorage.getItem('access_token') ||
    localStorage.getItem('authToken') ||
    sessionStorage.getItem('authToken')
  );
}

/**
 * Stream a chat turn through the unified OpenClaw proxy runtime.
 * Resolves when the stream completes (onDone/onError already fired).
 */
export async function streamUnifiedChat(
  req: UnifiedChatRequest,
  handlers: UnifiedStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const token = getAuthToken();
  const url = `${API_BASE_URL}/openclaw/proxy/stream`;

  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    handlers.onDone();
  };
  const fail = (msg: string) => {
    if (settled) return;
    settled = true;
    handlers.onError(msg);
  };

  const dispatch = (payload: string): boolean => {
    // returns true when the stream is terminated by this frame
    if (payload === '[DONE]') {
      done();
      return true;
    }
    let evt: any;
    try {
      evt = JSON.parse(payload);
    } catch {
      return false;
    }
    // claude-integration controller wraps some metas as { meta: {...} }
    if (evt && evt.meta && !evt.type) {
      if (evt.meta.sessionId) handlers.onSession?.(evt.meta.sessionId);
      handlers.onMeta?.(evt.meta);
      return false;
    }
    if (evt?.sessionId) handlers.onSession?.(evt.sessionId);
    switch (evt?.type) {
      case 'text_delta':
        handlers.onChunk(evt.text || '');
        return false;
      case 'meta':
        handlers.onMeta?.(evt);
        return false;
      case 'done':
        done();
        return true;
      case 'error':
        fail(evt.error || 'stream error');
        return true;
      default:
        handlers.onEvent?.(evt);
        return false;
    }
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({
        messages: req.messages,
        sessionId: req.sessionId,
        agentId: req.agentId,
        mode: req.mode ?? 'agent',
        platform: 'web',
        tier: req.tier,
        context: req.context ?? {},
        options: req.options ?? {},
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      let detail = `HTTP ${res.status}`;
      try {
        const t = await res.text();
        if (t) {
          const j = JSON.parse(t);
          detail = j.message || j.error || detail;
        }
      } catch {
        /* keep HTTP status */
      }
      fail(detail);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done: readerDone, value } = await reader.read();
      if (readerDone) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'));
        if (dataLines.length === 0) continue; // `:` ping / comment frame
        const payload = dataLines.map((l) => l.slice(5).replace(/^\s/, '')).join('\n');
        if (dispatch(payload)) return;
      }
    }
    done();
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      done();
      return;
    }
    fail(e?.message || String(e));
  }
}
