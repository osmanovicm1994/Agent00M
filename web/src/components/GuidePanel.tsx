import { Markdown } from "./Markdown";
// One source of truth: the same file is the tutorial in docs/ and the Guide screen in the dashboard.
import guide from "../../../docs/PROMPTING.md?raw";

interface Props {
  // Mobile: a way back to the settings screen. Hidden on a wide screen where the tabs are visible.
  onBack?: () => void;
}

export function GuidePanel({ onBack }: Props) {
  return (
    <article aria-label="Prompting guide" className="mx-auto w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-3 min-h-11 rounded-lg border border-slate-700 px-3 text-xs font-medium text-teal-300 hover:bg-slate-800 lg:hidden"
        >
          ← Back
        </button>
      )}
      <Markdown source={guide} />
    </article>
  );
}
