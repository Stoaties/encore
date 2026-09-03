import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useContextMenu } from '../state/contextMenu';

export function ContextMenu() {
  const { open, x, y, items, close } = useContextMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // clamp to viewport once the menu has a measured size, so it doesn't clip
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 4);
    const top = Math.min(y, window.innerHeight - rect.height - 4);
    setPos({ left: Math.max(4, left), top: Math.max(4, top) });
  }, [open, x, y]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const onScroll = () => close();
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, close]);

  if (!open) return null;

  return (
    <>
      {/* full-screen click catcher — one click anywhere closes the menu */}
      <div
        className="fixed inset-0 z-40"
        onClick={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <div
        ref={ref}
        role="menu"
        style={{ left: pos.left, top: pos.top }}
        className="fixed z-50 min-w-40 overflow-hidden rounded-md border border-zinc-700 bg-panel py-1 text-sm shadow-xl"
      >
        {items.map((item, i) => {
          const Icon = item.icon;
          return (
            <button
              key={i}
              role="menuitem"
              onClick={() => {
                close();
                item.onClick();
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel-hover ${
                item.danger ? 'text-red-400' : 'text-zinc-200'
              }`}
            >
              {Icon && <Icon className="size-4 shrink-0" />}
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
