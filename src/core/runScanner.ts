/**
 * Finds qaas job submissions in Python source so their billed time can be shown inline.
 * Static heuristics only: literal values and simple `name = value` assignments.
 */

export const DEFAULT_SHOTS = 1024; // QBackend default option

export interface RunCall {
  /** 0-based line of the call within the scanned text. */
  line: number;
  kind: "run" | "playlist";
  shots: number;
  shotsKnown: boolean;
  /** Number of circuits, when it can be read from a list literal. */
  circuits?: number;
}

const EXCLUDED_RECEIVERS = new Set(["subprocess", "asyncio", "trio", "anyio", "app", "uvicorn", "self", "loop"]);

export function mentionsQaas(text: string): boolean {
  return /\b(qheappe_client|qaas)\b/.test(text);
}

/** Text between the opening paren at `open` and its matching close; skips strings. */
function callArgs(text: string, open: number): string | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(open + 1, i);
      }
    }
  }
  return undefined;
}

/** Split on top-level commas. */
export function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if ("([{".includes(ch)) {
      depth++;
    } else if (")]}".includes(ch)) {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function parseInt10(s: string): number | undefined {
  const t = s.replace(/_/g, "").trim();
  if (/^\d+$/.test(t)) {
    return Number(t);
  }
  if (/^\d+(\.\d+)?e\d+$/i.test(t)) {
    const n = Number(t);
    return Number.isInteger(n) ? n : undefined;
  }
  return undefined;
}

/** Last `name = value` assignment in `scope`. */
function lastAssignment(scope: string, name: string): string | undefined {
  const re = new RegExp(`^[ \\t]*${name}[ \\t]*(?::[^=\\n]+)?=(?!=)[ \\t]*(.+)$`, "gm");
  let value: string | undefined;
  for (let m = re.exec(scope); m; m = re.exec(scope)) {
    value = m[1].trim();
  }
  return value;
}

function resolveInt(expr: string, scope: string): number | undefined {
  const direct = parseInt10(expr);
  if (direct !== undefined) {
    return direct;
  }
  if (/^[A-Za-z_]\w*$/.test(expr)) {
    const v = lastAssignment(scope, expr);
    return v === undefined ? undefined : parseInt10(v.replace(/#.*$/, ""));
  }
  return undefined;
}

/**
 * Circuits passed to run(): list literals are counted, transpile(x) keeps the count of x,
 * QuantumCircuit(...), qasm3.loads(...) and similar are one circuit.
 * Undefined when it can't be known statically (comprehensions, unresolved names).
 */
function countCircuits(expr: string, scope: string, depth = 0): number | undefined {
  const e = expr.replace(/#.*$/, "").trim();
  if (!e || depth > 5) {
    return undefined;
  }
  if (/^[A-Za-z_]\w*$/.test(e)) {
    const v = lastAssignment(scope, e);
    return v === undefined ? undefined : countCircuits(v, scope, depth + 1);
  }
  if (e.startsWith("[")) {
    return e.endsWith("]") && !/\bfor\b/.test(e) ? splitTopLevel(e.slice(1, -1)).length : undefined;
  }
  const t = /^[\w.]*transpile\((.*)\)$/s.exec(e);
  if (t) {
    const first = splitTopLevel(t[1])[0];
    return first ? countCircuits(first, scope, depth + 1) : undefined;
  }
  // Expressions known to build one circuit; anything else (e.g. make_circuits()) is unknown.
  if (
    /^(QuantumCircuit|[\w.]*qasm[23]?\.loads?|QuantumCircuit\.from_qasm_(str|file)|random_circuit)\(|\.copy\(\)$|\.assign_parameters\(/.test(
      e,
    )
  ) {
    return 1;
  }
  return undefined;
}

function lineOf(text: string, index: number): number {
  let n = 0;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      n++;
    }
  }
  return n;
}

/**
 * @param text   source to scan (one file or one notebook cell)
 * @param prelude earlier code used to resolve names (e.g. previous notebook cells)
 */
export function scanRunCalls(text: string, prelude = ""): RunCall[] {
  const all = `${prelude}\n${text}`;
  const offset = prelude.length + 1;

  // Receivers created by get_backend(); when known, only their .run() counts.
  const backendVars = new Set<string>();
  for (const m of all.matchAll(/^[ \t]*([A-Za-z_]\w*)[ \t]*=[^\n]*\.get_backend\(/gm)) {
    backendVars.add(m[1]);
  }

  const calls: RunCall[] = [];
  for (const m of text.matchAll(/([A-Za-z_][\w.]*)\.(run|submit_playlist)\s*\(/g)) {
    const receiver = m[1];
    const kind = m[2] === "run" ? "run" : "playlist";
    const root = receiver.split(".")[0];
    const index = m.index ?? 0;
    if (/^[ \t]*#/.test(text.slice(text.lastIndexOf("\n", index) + 1, index))) {
      continue; // commented out
    }
    if (kind === "run") {
      if (EXCLUDED_RECEIVERS.has(root)) {
        continue;
      }
      if (backendVars.size > 0 && !backendVars.has(receiver)) {
        continue;
      }
    }
    const scope = all.slice(0, offset + index);
    const args = callArgs(text, index + m[0].length - 1);
    if (args === undefined) {
      continue;
    }
    const parts = splitTopLevel(args);
    const positional = parts.filter((p) => !/^[A-Za-z_]\w*\s*=(?!=)/.test(p));
    const kw = (name: string) => {
      const p = parts.find((x) => new RegExp(`^${name}\\s*=(?!=)`).test(x));
      return p?.slice(p.indexOf("=") + 1).trim();
    };

    let shots: number | undefined;
    let circuits: number | undefined;
    if (kind === "run") {
      const shotsExpr = kw("shots") ?? positional[1];
      shots = shotsExpr === undefined ? undefined : resolveInt(shotsExpr, scope);
      circuits = positional[0] ? countCircuits(positional[0], scope) : undefined;
    } else {
      const set = [...scope.matchAll(/\.set_shots\(\s*([^)]+?)\s*\)/g)].pop();
      shots = set ? resolveInt(set[1], scope) : undefined;
    }
    calls.push({
      line: lineOf(text, index),
      kind,
      shots: shots ?? DEFAULT_SHOTS,
      shotsKnown: shots !== undefined,
      circuits,
    });
  }
  return calls;
}
