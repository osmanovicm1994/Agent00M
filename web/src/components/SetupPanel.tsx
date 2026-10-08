import { useEffect, useState } from "react";
import type { ClientCommand } from "../protocol";
import type { DashboardState } from "../state";

interface Props {
  state: DashboardState;
  send: (command: ClientCommand) => boolean;
}

// The chat startup questions (existing project? path, auto-write, auto-run, Gemini triage).
// They can be answered here or in the terminal; the first answer wins.
export function SetupPanel({ state, send }: Props) {
  const question = state.pendingQuestion;
  const [text, setText] = useState("");

  // Each new question starts from its own default.
  useEffect(() => {
    setText(question?.defaultValue ?? "");
  }, [question?.id, question?.defaultValue]);

  if (!question) return null;

  const answer = (value: string) => {
    send({ kind: "answer_question", id: question.id, answer: value });
  };

  return (
    <section className="rounded-xl border border-sky-500/40 bg-sky-500/10 p-4 text-sm text-sky-100">
      <div className="mb-1 text-xs uppercase tracking-wide text-sky-300/80">Agent setup</div>
      <div className="font-medium">{question.question}</div>

      {!state.canControl && (
        <div className="mt-2 text-xs text-sky-200/70">
          Answer in the terminal, or open the URL printed there (it carries the control token) to answer here.
        </div>
      )}

      {state.canControl && question.kind === "confirm" && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => answer("yes")}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
          >
            Yes{question.defaultValue === "yes" ? " (default)" : ""}
          </button>
          <button
            type="button"
            onClick={() => answer("no")}
            className="rounded-lg border border-slate-600 px-4 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
          >
            No{question.defaultValue === "no" ? " (default)" : ""}
          </button>
        </div>
      )}

      {state.canControl && question.kind === "text" && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            answer(text);
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            spellCheck={false}
            className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
          />
          <button type="submit" className="rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500">
            Use this folder
          </button>
        </form>
      )}
    </section>
  );
}
