/**
 * The command palette's model: a flat list of commands and the matcher that
 * filters them. Universal and React-free, so matching is tested without a DOM.
 */

export type Command = {
  id: string;
  label: string;
  /** Heading the command is listed under. */
  group: string;
  hint?: string;
  keywords?: readonly string[];
  run: () => void;
};

/**
 * Commands matching `query`, best first. Every whitespace-separated term must
 * appear somewhere in the label, group or keywords; ranking prefers terms that
 * start the label, then any match in the label, then keyword-only matches. An
 * empty query returns every command in its original order.
 */
export function filterCommands<C extends Command>(commands: readonly C[], query: string): C[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...commands];

  const scored: { command: C; score: number; index: number }[] = [];
  commands.forEach((command, index) => {
    const label = command.label.toLowerCase();
    const rest = [command.group, ...(command.keywords ?? [])].join(' ').toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (label.startsWith(term) || label.includes(` ${term}`)) score += 3;
      else if (label.includes(term)) score += 2;
      else if (rest.includes(term)) score += 1;
      else return;
    }
    scored.push({ command, score, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.command);
}
