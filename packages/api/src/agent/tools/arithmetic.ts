/**
 * A tiny arithmetic evaluator for the agent's `math` tool (FR-5.1: dilution and
 * vesting arithmetic is done deterministically, never in-token).
 *
 * Hand-rolled rather than `eval`/`new Function`/a dependency because the input
 * is model output crossing a trust boundary: this grammar can only produce a
 * number, so there is no code path to escape into. Supports + - * / ^ , unary
 * sign, parentheses, and decimal literals — enough for cap-table math.
 */

const MAX_EXPRESSION_CHARS = 500;

type Token =
  | { kind: "num"; value: number }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "^" }
  | { kind: "lparen" }
  | { kind: "rparen" };

class ExpressionError extends Error {}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/u.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i++;
    } else if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i++;
    } else if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "^") {
      tokens.push({ kind: "op", value: ch });
      i++;
    } else if (/[0-9.]/u.test(ch)) {
      const match = /^\d*\.?\d+(?:[eE][+-]?\d+)?/u.exec(input.slice(i));
      if (!match) throw new ExpressionError(`malformed number at position ${i}`);
      tokens.push({ kind: "num", value: Number(match[0]) });
      i += match[0].length;
    } else {
      // Underscores, thousands separators and currency symbols are rejected
      // rather than guessed at — a silently misparsed number is worse than
      // an error the model can correct.
      throw new ExpressionError(`unexpected character '${ch}' at position ${i}`);
    }
  }
  return tokens;
}

/**
 * Recursive descent: expr -> term (('+'|'-') term)*, term -> unary (('*'|'/') unary)*,
 * unary -> ('+'|'-') unary | power, power -> primary ('^' unary)? (right-associative).
 */
function parse(tokens: Token[]): number {
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];

  const expect = (kind: Token["kind"]): void => {
    if (tokens[pos]?.kind !== kind) throw new ExpressionError(`expected ${kind}`);
    pos++;
  };

  const primary = (): number => {
    const t = peek();
    if (!t) throw new ExpressionError("unexpected end of expression");
    if (t.kind === "num") {
      pos++;
      return t.value;
    }
    if (t.kind === "lparen") {
      pos++;
      const value = expr();
      expect("rparen");
      return value;
    }
    throw new ExpressionError("expected a number or '('");
  };

  const power = (): number => {
    const base = primary();
    const t = peek();
    if (t?.kind === "op" && t.value === "^") {
      pos++;
      return base ** unary();
    }
    return base;
  };

  const unary = (): number => {
    const t = peek();
    if (t?.kind === "op" && (t.value === "-" || t.value === "+")) {
      pos++;
      const value = unary();
      return t.value === "-" ? -value : value;
    }
    return power();
  };

  const term = (): number => {
    let left = unary();
    for (;;) {
      const t = peek();
      if (t?.kind !== "op" || (t.value !== "*" && t.value !== "/")) return left;
      pos++;
      const right = unary();
      if (t.value === "/" && right === 0) throw new ExpressionError("division by zero");
      left = t.value === "*" ? left * right : left / right;
    }
  };

  const expr = (): number => {
    let left = term();
    for (;;) {
      const t = peek();
      if (t?.kind !== "op" || (t.value !== "+" && t.value !== "-")) return left;
      pos++;
      const right = term();
      left = t.value === "+" ? left + right : left - right;
    }
  };

  const value = expr();
  if (pos !== tokens.length) throw new ExpressionError("trailing input after expression");
  return value;
}

export interface ArithmeticResult {
  ok: boolean;
  value?: number;
  error?: string;
}

/**
 * Evaluate an arithmetic expression. Never throws: a bad expression comes back
 * as `{ ok: false, error }` so the loop hands the model a correctable
 * tool_result instead of failing the whole turn.
 */
export function evaluateArithmetic(expression: string): ArithmeticResult {
  if (expression.length > MAX_EXPRESSION_CHARS) {
    return { ok: false, error: `expression exceeds ${MAX_EXPRESSION_CHARS} characters` };
  }
  try {
    const value = parse(tokenize(expression));
    if (!Number.isFinite(value)) return { ok: false, error: "result is not a finite number" };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
