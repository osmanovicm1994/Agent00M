import type { ReactNode } from "react";

// A small Markdown renderer for the built-in guide: headings, paragraphs, bullet / numbered / checkbox lists,
// tables, fenced code, blockquotes (they can hold code), rules, **bold** and `code`. It builds React elements
// (never raw HTML), so the text can not inject markup. Links and images are not supported on purpose.

function inline(text: string, keyBase: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code key={key} className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[0.85em] text-teal-200">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={key} className="font-semibold text-slate-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

const isTableRow = (l: string) => l.trim().startsWith("|") && l.trim().endsWith("|");
const isTableSeparator = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function blocks(src: string, keyBase: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = () => `${keyBase}-b${n++}`;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    // fenced code
    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i++; // closing fence
      out.push(
        <pre key={key()} className="my-3 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs leading-relaxed text-slate-200">
          <code className="font-mono whitespace-pre">{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // horizontal rule
    if (/^-{3,}\s*$/.test(line.trim())) {
      out.push(<hr key={key()} className="my-6 border-slate-800" />);
      i++;
      continue;
    }

    // headings
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const cls =
        level === 1
          ? "mb-3 mt-2 text-2xl font-semibold tracking-tight text-slate-50"
          : level === 2
            ? "mb-2 mt-8 text-xl font-semibold text-teal-200"
            : "mb-1 mt-5 text-base font-semibold text-slate-100";
      const k = key();
      const kids = inline(h[2], k);
      out.push(level === 1 ? <h1 key={k} className={cls}>{kids}</h1> : level === 2 ? <h2 key={k} className={cls}>{kids}</h2> : <h3 key={k} className={cls}>{kids}</h3>);
      i++;
      continue;
    }

    // blockquote: strip the "> " and render the inside as Markdown (so code fences inside work)
    if (line.startsWith(">")) {
      const inner: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) inner.push(lines[i++].replace(/^>\s?/, ""));
      const k = key();
      out.push(
        <blockquote key={k} className="my-3 border-l-2 border-teal-300/60 bg-slate-900/60 py-1 pl-4 pr-2 text-sm text-slate-300">
          {blocks(inner.join("\n"), k)}
        </blockquote>,
      );
      continue;
    }

    // table
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      const k = key();
      out.push(
        <div key={k} className="my-3 overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
            <thead className="bg-slate-900 text-slate-300">
              <tr>
                {head.map((c, ci) => (
                  <th key={ci} className="px-3 py-2 font-medium">
                    {inline(c, `${k}-h${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map((r, ri) => (
                <tr key={ri} className="align-top">
                  {r.map((c, ci) => (
                    <td key={ci} className="px-3 py-2 text-slate-300">
                      {inline(c, `${k}-r${ri}c${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // lists (bullets, checkboxes, numbered)
    const bullet = /^\s*[-*]\s+(.*)$/;
    const numbered = /^\s*\d+\.\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) items.push(re.exec(lines[i++])![1]);
      const k = key();
      const li = items.map((t, ti) => {
        const box = /^\[( |x)\]\s+(.*)$/i.exec(t);
        return (
          <li key={ti} className="my-1">
            {box ? <span aria-hidden className="mr-2 text-teal-300">{box[1].trim() ? "☑" : "☐"}</span> : null}
            {inline(box ? box[2] : t, `${k}-${ti}`)}
          </li>
        );
      });
      out.push(
        ordered ? (
          <ol key={k} className="my-3 list-decimal pl-6 text-sm leading-relaxed text-slate-300">{li}</ol>
        ) : (
          <ul key={k} className={`my-3 pl-6 text-sm leading-relaxed text-slate-300 ${items.every((t) => /^\[( |x)\]/i.test(t)) ? "list-none pl-2" : "list-disc"}`}>{li}</ul>
        ),
      );
      continue;
    }

    // paragraph: runs until a blank line or the start of another block
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trim().startsWith("```") &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !lines[i].startsWith(">") &&
      !bullet.test(lines[i]) &&
      !numbered.test(lines[i]) &&
      !(isTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      para.push(lines[i++]);
    }
    if (para.length === 0) {
      // Safety net: never loop forever on a line no rule accepts.
      para.push(lines[i++]);
    }
    const k = key();
    out.push(
      <p key={k} className="my-3 text-sm leading-relaxed text-slate-300">
        {inline(para.join(" "), k)}
      </p>,
    );
  }
  return out;
}

export function Markdown({ source }: { source: string }) {
  return <div>{blocks(source, "md")}</div>;
}
