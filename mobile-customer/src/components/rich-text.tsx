"use client";

import React from "react";

/**
 * Tiny markdown-ish renderer used inside chat bubbles + preset event
 * cards. Supports the subset the backend's preset templates actually
 * emit — `*bold*`, `_italic_`, `\n` line breaks, and "• " bullet lines.
 * Anything else is rendered as plain text. We deliberately avoid a full
 * markdown parser to keep the bundle tiny and prevent XSS.
 */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  // Token matcher for *bold* and _italic_. Greedy enough for one-line
  // chat copy; we don't need nested formatting.
  const regex = /\*([^*\n]+)\*|_([^_\n]+)_/g;
  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    if (m[1] != null) {
      out.push(
        <strong key={`${keyBase}-b-${i++}`} className="font-semibold">
          {m[1]}
        </strong>
      );
    } else if (m[2] != null) {
      out.push(
        <em key={`${keyBase}-i-${i++}`} className="italic opacity-90">
          {m[2]}
        </em>
      );
    }
    lastIdx = regex.lastIndex;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

export function RichText({ text, className = "" }: { text: string; className?: string }) {
  const lines = text.split("\n");
  return (
    <div className={`whitespace-pre-wrap break-words ${className}`}>
      {lines.map((raw, idx) => {
        const isBullet = /^\s*•\s+/.test(raw);
        const content = isBullet ? raw.replace(/^\s*•\s+/, "") : raw;
        if (isBullet) {
          return (
            <div key={idx} className="flex gap-1.5">
              <span className="select-none opacity-70">•</span>
              <span className="flex-1">{renderInline(content, `${idx}`)}</span>
            </div>
          );
        }
        return (
          <div key={idx}>
            {renderInline(raw, `${idx}`)}
            {raw === "" ? <br /> : null}
          </div>
        );
      })}
    </div>
  );
}
