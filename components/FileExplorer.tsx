"use client";

import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { AtSign, Check, ChevronDown, ChevronRight, Copy, Download, File, FolderClosed, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/client/api";
import {
  cacheListing, cachedListing, loadExplorerState, saveExplorerState, toggleExpanded,
  type ExplorerItem, type ExplorerState,
} from "@/lib/client/explorerState";

type Item = ExplorerItem;

export default function FileExplorer({ cwd, sessionId }: { cwd: string; sessionId?: string }) {
  const [state, setState] = useState<ExplorerState>(() => loadExplorerState(cwd));
  const [openFile, setOpenFile] = useState<string | null>(null);
  const scrollTopRef = useRef(state.scrollTop);

  useEffect(() => {
    saveExplorerState(cwd, { ...state, scrollTop: scrollTopRef.current });
  }, [cwd, state]);
  // leaving the tab unmounts us — remember where the tree was scrolled
  useEffect(() => {
    const top = scrollTopRef;
    return () => saveExplorerState(cwd, { ...loadExplorerState(cwd), scrollTop: top.current });
  }, [cwd]);

  return (
    <div className="flex-1 min-w-0 flex flex-col min-h-0">
      {openFile && <FileViewer path={openFile} onClose={() => setOpenFile(null)} />}
      {/* the tree stays MOUNTED (only hidden) while a file is open, so its
          expanded folders and loaded listings survive "back" */}
      <Tree
        hidden={openFile != null}
        root={cwd}
        sessionId={sessionId}
        expanded={state.expanded}
        lastFile={state.lastFile}
        scrollTopRef={scrollTopRef}
        onToggle={(p) => setState((s) => toggleExpanded(s, p))}
        onOpen={(p) => {
          setState((s) => ({ ...s, lastFile: p }));
          setOpenFile(p);
        }}
      />
    </div>
  );
}

function Tree({ hidden, root, sessionId, expanded, lastFile, scrollTopRef, onToggle, onOpen }: {
  hidden: boolean;
  root: string;
  sessionId?: string;
  expanded: string[];
  lastFile: string | null;
  scrollTopRef: MutableRefObject<number>;
  onToggle: (dir: string) => void;
  onOpen: (file: string) => void;
}) {
  const [epoch, setEpoch] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  // display:none drops a scroll offset — put it back whenever the tree
  // (re)appears: after "back" from a file, or on a remount after a tab switch
  // (listings render from cache, so the height is already there)
  useLayoutEffect(() => {
    if (!hidden && boxRef.current) boxRef.current.scrollTop = scrollTopRef.current;
  }, [hidden, scrollTopRef]);
  return (
    <div
      ref={boxRef}
      onScroll={(e) => {
        scrollTopRef.current = e.currentTarget.scrollTop;
      }}
      className={`flex-1 overflow-y-auto py-2 text-sm ${hidden ? "hidden" : ""}`}
    >
      <div className="flex items-center gap-1 px-3 pb-2">
        <span className="text-xs text-(--color-dim) mono truncate flex-1" title={root}>
          {root.replace(/^\/home\/[^/]+/, "~")}
        </span>
        <button
          onClick={() => {
            setEpoch((e) => e + 1);
            setSpinning(true);
            setTimeout(() => setSpinning(false), 600);
          }}
          className="p-1 rounded text-(--color-dim) hover:text-white shrink-0"
          title="Refresh"
        >
          <RefreshCw size={12} className={spinning ? "animate-spin" : ""} />
        </button>
      </div>
      <DirNode
        path={root}
        depth={0}
        epoch={epoch}
        sessionId={sessionId}
        expanded={expanded}
        lastFile={lastFile}
        onToggle={onToggle}
        onOpen={onOpen}
        isRoot
      />
    </div>
  );
}

function DirNode({ path, depth, epoch, sessionId, expanded, lastFile, onToggle, onOpen, isRoot = false }: {
  path: string; depth: number; epoch: number; sessionId?: string;
  expanded: string[]; lastFile: string | null;
  onToggle: (dir: string) => void; onOpen: (p: string) => void; isRoot?: boolean;
}) {
  // the root is always open; every other folder follows the shared state
  const open = isRoot || expanded.includes(path);
  const [items, setItems] = useState<Item[] | null>(() => cachedListing(path));
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // epoch refreshes can overlap — an older response must not win
    let cancelled = false;
    api<{ items: Item[] }>(`/api/fs/list?path=${encodeURIComponent(path)}`)
      .then((r) => {
        if (cancelled) return;
        const list = r.items.filter((i) => i.name !== "node_modules" && !i.name.startsWith(".git"));
        cacheListing(path, list);
        setItems(list);
        setErr(null);
      })
      .catch((e) => {
        if (!cancelled) setErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, epoch, path]);

  const mention = (e: React.MouseEvent, p: string) => {
    e.stopPropagation();
    if (!sessionId) return;
    window.dispatchEvent(new CustomEvent("dw-mention", { detail: { sessionId, path: p } }));
  };

  const name = path.split("/").filter(Boolean).pop() || path;

  return (
    <div>
      <button
        onClick={() => {
          if (!isRoot) onToggle(path);
        }}
        className="w-full flex items-center gap-1 px-2 py-1 hover:bg-(--color-panel2) text-left"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {open ? <ChevronDown size={12} className="text-(--color-dim)" /> : <ChevronRight size={12} className="text-(--color-dim)" />}
        <FolderClosed size={13} className="text-(--color-folder)" />
        <span className="truncate">{name}</span>
      </button>
      {open && (
        <div>
          {err && <div className="text-(--color-red) text-xs px-4">{err}</div>}
          {!items && !err && (
            <div className="text-(--color-dim) text-xs px-4 flex items-center gap-1"><Loader2 size={11} className="animate-spin" />…</div>
          )}
          {items?.map((i) =>
            i.type === "dir" ? (
              <DirNode key={i.path} path={i.path} depth={depth + 1} epoch={epoch} sessionId={sessionId}
                expanded={expanded} lastFile={lastFile} onToggle={onToggle} onOpen={onOpen} />
            ) : (
              <div
                key={i.path}
                className={`group flex items-center hover:bg-(--color-panel2) ${i.path === lastFile ? "bg-(--color-accent)/15" : ""}`}
              >
                <button
                  onClick={() => onOpen(i.path)}
                  className="flex-1 min-w-0 flex items-center gap-1 py-1 text-left text-(--color-text)"
                  style={{ paddingLeft: `${8 + (depth + 1) * 14 + 12}px` }}
                >
                  <File size={12} className="text-(--color-dim) shrink-0" />
                  <span className="truncate">{i.name}</span>
                </button>
                {sessionId && (
                  <button
                    onClick={(e) => mention(e, i.path)}
                    className="p-1 mr-1 rounded text-(--color-faint) md:opacity-0 md:group-hover:opacity-100 hover:text-(--color-accent) shrink-0"
                    title={`Mention @${i.name} in the prompt`}
                  >
                    <AtSign size={12} />
                  </button>
                )}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function FileViewer({ path, onClose }: { path: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [encoding, setEncoding] = useState("utf8");
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // switching files clears the previous view during render (sanctioned
  // prop-change adjustment) so the fetch effect stays purely async
  const [prevPath, setPrevPath] = useState(path);
  if (prevPath !== path) {
    setPrevPath(path);
    setContent(null);
    setErr(null);
    setCopied(false);
  }

  useEffect(() => {
    // switching files quickly must not let an older response win
    let cancelled = false;
    api<{ content: string; encoding: string }>(`/api/fs/read?path=${encodeURIComponent(path)}`)
      .then((r) => {
        if (cancelled) return;
        setContent(r.content);
        setEncoding(r.encoding);
      })
      .catch((e) => {
        if (!cancelled) setErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const name = path.split("/").pop() || path;
  const isImage = encoding === "base64" && /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name);

  const copy = () => {
    if (content == null) return;
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  const download = () => {
    if (content == null) return;
    const blob =
      encoding === "base64"
        ? new Blob([Uint8Array.from(atob(content), (c) => c.charCodeAt(0))])
        : new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-(--color-border)">
        <span className="mono text-xs truncate flex-1" title={path}>{name}</span>
        {content != null && encoding !== "base64" && (
          <button onClick={copy} className="p-1.5 rounded text-(--color-dim) hover:text-white" title="Copy contents">
            {copied ? <Check size={13} className="text-(--color-green)" /> : <Copy size={13} />}
          </button>
        )}
        {content != null && (
          <button onClick={download} className="p-1.5 rounded text-(--color-dim) hover:text-white" title="Download">
            <Download size={13} />
          </button>
        )}
        <button onClick={onClose} className="text-(--color-dim) hover:text-white text-xs pl-1">back</button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {err && <div className="text-(--color-red) text-sm">{err}</div>}
        {content == null && !err && <Loader2 size={16} className="animate-spin text-(--color-dim)" />}
        {content != null && isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`data:${imageMime(name)};base64,${content}`} alt={name} className="max-w-full" />
        ) : content != null && encoding === "base64" ? (
          <div className="text-(--color-dim) text-sm">binary file ({content.length} b64 chars)</div>
        ) : content != null ? (
          <Numbered text={content} />
        ) : null}
      </div>
    </div>
  );
}

/** `data:image/*` isn't a real MIME — map the extension instead. */
function imageMime(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      bmp: "image/bmp",
      ico: "image/x-icon",
      avif: "image/avif",
    }[ext] ?? "image/png"
  );
}

/** Text with gutter line numbers; nowrap so numbering stays aligned. */
function Numbered({ text }: { text: string }) {
  if (!text) return <div className="text-(--color-dim) text-xs">(empty file)</div>;
  const lines = text.split("\n");
  // a gutter <div> per line is ~30k nodes for a 1MB file — on a phone that
  // stalls the tab. The text itself is already a single <pre>, so dropping
  // just the gutter keeps the content viewable
  if (lines.length > 2000) {
    return (
      <div>
        <div className="text-(--color-faint) text-tiny pb-1">line numbers hidden — {lines.length} lines</div>
        <pre className="mono text-xs whitespace-pre">{text}</pre>
      </div>
    );
  }
  const w = String(lines.length).length;
  return (
    <div className="mono text-xs flex">
      <div className="text-right text-(--color-faint) select-none pr-3 shrink-0 border-r border-(--color-border) mr-3">
        {lines.map((_, i) => (
          <div key={i}>{String(i + 1).padStart(w)}</div>
        ))}
      </div>
      <pre className="whitespace-pre flex-1 min-w-0">{text}</pre>
    </div>
  );
}
