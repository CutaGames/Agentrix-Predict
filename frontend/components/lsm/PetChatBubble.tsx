/**
 * PetChatBubble — floating pet-bubble chat entry for the LSM "Predict" web app.
 *
 * Analogous to the mobile / desktop pet bubble: a fixed bottom-right circular
 * button (Agentrix logo art + subtle pulse) that toggles a slide-up drawer
 * panel rendering the shared `<UnifiedAgentChat standalone compact mode="user" />`.
 *
 * Behavior:
 *  - When closed it only renders the small button — page interaction is never
 *    blocked (no overlay, the button is the sole fixed element).
 *  - Clicking opens a ~380px panel (full-width on mobile) with a close button
 *    and click-outside-to-dismiss (a transparent backdrop).
 *  - The chat is lazily imported and only mounted while the panel is open, so
 *    initial page load stays light.
 *  - `UnifiedAgentChat` calls `useWorkbench()`, whose provider is NOT global in
 *    `_app.tsx`; we wrap the chat in a local `WorkbenchProvider` so it renders
 *    without crashing on /lsm pages (the other providers — UserContext,
 *    Payment, Web3, AgentMode — are already global).
 */
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { MessageCircle, X, Maximize2 } from 'lucide-react';
import { WorkbenchProvider } from '../../contexts/WorkbenchContext';

// Lazy-load the (heavy) chat surface only when the panel opens.
const UnifiedAgentChat = dynamic(
  () => import('../agent/UnifiedAgentChat').then((m) => m.UnifiedAgentChat),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        正在加载助手…
      </div>
    ),
  },
);

export default function PetChatBubble() {
  const [open, setOpen] = useState(false);
  // Track whether the chat was ever opened so we keep its session mounted while
  // toggling visibility (avoids losing in-progress chat on accidental close).
  const [mounted, setMounted] = useState(false);
  // Desktop panel size presets (LSM Phase G · Req 24.7 — resizable on desktop;
  // mobile stays full-width). Cycles sm → md → lg.
  const SIZES = ['sm', 'md', 'lg'] as const;
  type PanelSize = (typeof SIZES)[number];
  const SIZE_PX: Record<PanelSize, { width: number; height: number }> = {
    sm: { width: 380, height: 600 },
    md: { width: 520, height: 720 },
    lg: { width: 680, height: 820 },
  };
  const [size, setSize] = useState<PanelSize>('sm');
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 640px)');
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const cycleSize = () => setSize((s) => SIZES[(SIZES.indexOf(s) + 1) % SIZES.length]);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  // Close on Escape for accessibility.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {/* Floating button — sole fixed element when closed (never blocks page). */}
      {!open && (
        <button
          type="button"
          aria-label="打开 AI 助手"
          onClick={() => setOpen(true)}
          className="group fixed bottom-5 right-5 z-[60] grid h-14 w-14 place-items-center rounded-full border border-violet-400/40 bg-slate-900/90 shadow-lg shadow-violet-900/40 backdrop-blur transition-transform hover:scale-105 sm:bottom-6 sm:right-6"
        >
          {/* subtle pulse ring */}
          <span className="absolute inset-0 animate-ping rounded-full bg-violet-500/30" />
          <span className="absolute inset-0 rounded-full ring-1 ring-violet-500/30" />
          <img
            src="/brand/logo-icon.png"
            alt="Agentrix"
            className="relative h-9 w-9 rounded-full"
          />
          {/* tiny chat glyph badge */}
          <span className="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full bg-violet-600 text-white shadow">
            <MessageCircle size={12} />
          </span>
        </button>
      )}

      {open && (
        <>
          {/* Click-outside backdrop (transparent; only present while open). */}
          <div
            className="fixed inset-0 z-[60] bg-black/30 sm:bg-transparent"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />

          {/* Slide-up / drawer panel */}
          <div
            role="dialog"
            aria-label="AI 助手"
            style={isDesktop ? { width: SIZE_PX[size].width, height: SIZE_PX[size].height } : undefined}
            className="fixed bottom-0 right-0 z-[61] flex h-[80vh] w-full flex-col overflow-hidden rounded-t-2xl border border-slate-800 bg-slate-950 shadow-2xl shadow-black/50 animate-[slideUp_0.18s_ease-out] sm:bottom-6 sm:right-6 sm:max-h-[90vh] sm:rounded-2xl"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900/80 px-4 py-3">
              <div className="flex items-center gap-2">
                <img src="/brand/logo-icon.png" alt="Agentrix" className="h-6 w-6 rounded-md" />
                <span className="text-sm font-bold text-white">Agentrix 助手</span>
              </div>
              <div className="flex items-center gap-1">
                {isDesktop && (
                  <button
                    type="button"
                    aria-label={`调整大小（当前 ${size.toUpperCase()}）`}
                    title={`调整大小（当前 ${size.toUpperCase()}）`}
                    onClick={cycleSize}
                    className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
                  >
                    <Maximize2 size={16} />
                  </button>
                )}
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={() => setOpen(false)}
                  className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {mounted && (
                <WorkbenchProvider>
                  <UnifiedAgentChat standalone compact mode="user" />
                </WorkbenchProvider>
              )}
            </div>
          </div>

          <style jsx global>{`
            @keyframes slideUp {
              from {
                transform: translateY(16px);
                opacity: 0;
              }
              to {
                transform: translateY(0);
                opacity: 1;
              }
            }
          `}</style>
        </>
      )}
    </>
  );
}
