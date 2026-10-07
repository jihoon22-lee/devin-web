"use client";

import { useEffect, useState } from "react";
import { FolderOpen, ArrowUp, X, Check, GitBranch } from "lucide-react";
import { api } from "@/lib/client/api";
import { isImeComposing } from "@/lib/client/keys";
import Modal from "./Modal";

interface DirList {
  path: string;
  parent: string;
  items: { name: string; path: string; type: string }[];
}

export default function DirectoryPicker({
  onPick,
  onClose,
  initialCwd,
}: {
  onPick: (cwd: string, opts?: { worktree?: boolean }) => void;
  onClose: () => void;
  initialCwd?: string;
}) {
  // cwd drives the listing; input is the editable text field. Typing must not
  // refetch — cwd only moves via explicit navigation (click / parent / Enter),
  // and the resolved path is mirrored back into the input.
  const [cwd, setCwd] = useState(initialCwd || "~");
  const [input, setInput] = useState(initialCwd || "~");
  const [list, setList] = useState<DirList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [worktree, setWorktree] = useState(false);
  const pick = (path: string) =>
    worktree ? onPick(path, { worktree: true }) : onPick(path);

  useEffect(() => {
    let cancelled = false;
    api<DirList>(`/api/fs/list?path=${encodeURIComponent(cwd)}`)
      .then((r) => {
        if (!cancelled) {
          setList(r);
          setInput(r.path);
          setErr(null);
        }
      })
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const nav = (path: string) => {
    setInput(path);
    setCwd(path);
  };

  return (
    <Modal
      onClose={onClose}
      label="Choose working directory"
      panelClassName="w-[92vw] max-w-[560px] max-h-[70vh] bg-(--color-panel) border border-(--color-border2) rounded-2xl flex flex-col shadow-2xl dw-pop"
    >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-(--color-border)">
          <span className="font-medium text-sm flex-1">New session — choose working directory</span>
          <button onClick={onClose} className="text-(--color-dim) hover:text-white"><X size={16} /></button>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 border-b border-(--color-border)">
          <button
            onClick={() => list && nav(list.parent)}
            className="p-1 rounded hover:bg-(--color-panel2) text-(--color-dim) hover:text-white"
          >
            <ArrowUp size={14} />
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === "Enter" && input.trim()) nav(input.trim());
            }}
            className="flex-1 bg-(--color-panel2) border border-(--color-border) rounded px-2 py-1 text-sm mono outline-none focus:border-(--color-accent)"
          />
          <button
            onClick={() => {
              const want = input.trim();
              if (!want) return;
              if (list && want === list.path) {
                pick(list.path);
                return;
              }
              // a typed path may contain ~ or not exist — let the server
              // resolve it; only a real directory becomes the session cwd
              api<DirList>(`/api/fs/list?path=${encodeURIComponent(want)}`)
                .then((r) => pick(r.path))
                .catch((e) => setErr(`Cannot use ${want}: ${(e as Error).message}`));
            }}
            className="flex items-center gap-1 px-3 py-1 rounded bg-(--color-accent) text-black text-sm font-medium hover:brightness-110"
          >
            <Check size={14} /> Select
          </button>
        </div>
        <label className="flex items-center gap-2 px-4 py-2 border-b border-(--color-border) text-sm text-(--color-dim) cursor-pointer select-none">
          <input
            type="checkbox"
            checked={worktree}
            onChange={(e) => setWorktree(e.target.checked)}
            className="accent-(--color-accent)"
          />
          <GitBranch size={13} />
          Start in isolated worktree (git worktree — own branch, own files)
        </label>
        <div className="flex-1 overflow-y-auto p-2">
          {err && <div className="text-(--color-red) text-sm px-2 py-1">{err}</div>}
          {list?.items
            .filter((i) => i.type === "dir")
            .map((i) => (
              <button
                key={i.path}
                onClick={() => nav(i.path)}
                onDoubleClick={() => pick(i.path)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-(--color-panel2) text-left text-sm"
              >
                <FolderOpen size={14} className="text-(--color-dim)" />
                {i.name}
              </button>
            ))}
          {list && list.items.filter((i) => i.type === "dir").length === 0 && (
            <div className="text-(--color-dim) text-sm px-2 py-4 text-center">No subdirectories</div>
          )}
        </div>
    </Modal>
  );
}
