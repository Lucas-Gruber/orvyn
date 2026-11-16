import type { Property } from "./index.js";

export type FormulaType = "number" | "text" | "boolean" | "list" | "null";
export type FormulaNode =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "property"; id: string; valueType: FormulaType }
  | { kind: "unary"; op: string; arg: FormulaNode }
  | { kind: "binary"; op: string; left: FormulaNode; right: FormulaNode }
  | { kind: "call"; name: string; args: FormulaNode[] };
export class FormulaError extends Error {}
function invalid(message: string): never {
  throw new FormulaError(message);
}
export function formulaPropertyType(property: Property): FormulaType {
  if (property.type === "Formula" || property.type === "Rollup")
    return property.config.resultType || "null";
  if (property.type === "Number") return "number";
  if (property.type === "Checkbox") return "boolean";
  if (["MultiSelect", "Person", "Files", "Relation"].includes(property.type))
    return "list";
  return "text";
}
const precedence: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  ">": 4,
  ">=": 4,
  "<": 4,
  "<=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

// A bounded expression language, with no JavaScript evaluation or user SQL.
// Property names are resolved once; stored expressions refer to stable IDs.
export function parseFormula(
  source: string,
  properties: Property[],
): FormulaNode {
  if (!source.trim() || source.length > 2000)
    invalid("Enter a formula with at most 2,000 characters.");
  const tokens: { value: string; at: number }[] = [];
  let at = 0;
  while (at < source.length) {
    if (/\s/.test(source[at]!)) {
      at++;
      continue;
    }
    const rest = source.slice(at),
      match =
        /^(?:"(?:[^"\\\r\n]|\\["\\/bfnrt]|\\u[\da-fA-F]{4})*"|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|==|!=|>=|<=|&&|\|\||[()+\-*/%,!<>])/.exec(
          rest,
        );
    if (!match) invalid(`Unexpected character at position ${at + 1}.`);
    tokens.push({ value: match[0], at });
    at += match[0].length;
    if (tokens.length > 512) invalid("This formula is too complex.");
  }
  let index = 0,
    nodes = 0;
  const peek = () => tokens[index]?.value,
    take = () => tokens[index++]?.value,
    expect = (value: string) => {
      if (take() !== value)
        invalid(
          `Expected ${value} near position ${tokens[index - 1]?.at ?? source.length}.`,
        );
    },
    node = <T extends FormulaNode>(value: T): T => {
      if (++nodes > 128) invalid("Use at most 128 formula expressions.");
      return value;
    };
  function expression(min = 0, depth = 0): FormulaNode {
    if (depth > 16) invalid("Formula nesting is limited to 16 levels.");
    const token = take();
    let left: FormulaNode;
    if (!token) return invalid("The formula ends before an expression.");
    if (["!", "-", "+"].includes(token))
      left = node({ kind: "unary", op: token, arg: expression(7, depth + 1) });
    else if (token === "(") {
      left = expression(0, depth + 1);
      expect(")");
    } else if (token.startsWith('"'))
      left = node({ kind: "literal", value: JSON.parse(token) });
    else if (/^[\d.]/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) invalid("Numbers must be finite.");
      left = node({ kind: "literal", value });
    } else if (["true", "false", "null"].includes(token))
      left = node({ kind: "literal", value: JSON.parse(token) });
    else if (/^[A-Za-z_]/.test(token)) {
      expect("(");
      if (token === "prop") {
        const name = take();
        if (!name?.startsWith('"')) invalid('Use prop("Property name").');
        expect(")");
        const label = JSON.parse(name),
          matches = properties.filter((p) => p.name === label);
        if (matches.length !== 1)
          invalid(
            matches.length
              ? `Property name ${label} is ambiguous.`
              : `Property ${label} does not exist.`,
          );
        left = node({
          kind: "property",
          id: matches[0]!.id,
          valueType: formulaPropertyType(matches[0]!),
        });
      } else {
        const args: FormulaNode[] = [];
        if (peek() !== ")") {
          do {
            args.push(expression(0, depth + 1));
            if (peek() !== ",") break;
            take();
          } while (true);
        }
        expect(")");
        left = node({ kind: "call", name: token, args });
      }
    } else return invalid(`Expected an expression near ${token}.`);
    while (
      peek() &&
      precedence[peek()!] !== undefined &&
      precedence[peek()!]! >= min
    ) {
      const op = take()!;
      left = node({
        kind: "binary",
        op,
        left,
        right: expression(precedence[op]! + 1, depth + 1),
      });
    }
    return left;
  }
  const ast = expression();
  if (index !== tokens.length)
    invalid(`Unexpected ${peek()} after the expression.`);
  formulaType(ast, properties);
  return ast;
}

export function formulaType(
  ast: FormulaNode,
  properties: Property[],
): FormulaType {
  let budget = 512;
  const path = new Set<string>();
  function visit(n: FormulaNode, depth = 0): FormulaType {
    if (--budget < 0 || depth > 32)
      invalid("Formula dependencies are too complex.");
    const same = (a: FormulaType, b: FormulaType) =>
        a === b || a === "null" || b === "null",
      requireType = (actual: FormulaType, expected: FormulaType) => {
        if (!same(actual, expected))
          invalid(`Expected ${expected}, received ${actual}.`);
      },
      merge = (a: FormulaType, b: FormulaType) => {
        if (!same(a, b)) invalid("Both branches must return the same type.");
        return a === "null" ? b : a;
      };
    if (n.kind === "literal")
      return n.value === null
        ? "null"
        : typeof n.value === "string"
          ? "text"
          : (typeof n.value as "number" | "boolean");
    if (n.kind === "property") {
      const p = properties.find((p) => p.id === n.id);
      if (!p) return n.valueType;
      if (p.type !== "Formula") return formulaPropertyType(p);
      if (!p.config.expression || path.has(p.id))
        invalid("Formula dependencies contain a cycle.");
      path.add(p.id);
      const result = visit(p.config.expression, depth + 1);
      path.delete(p.id);
      return result;
    }
    if (n.kind === "unary") {
      const result = n.op === "!" ? "boolean" : "number";
      if (!["!", "+", "-"].includes(n.op)) invalid("Unknown formula operator.");
      requireType(visit(n.arg, depth + 1), result);
      return result;
    }
    if (n.kind === "binary") {
      const a = visit(n.left, depth + 1),
        b = visit(n.right, depth + 1);
      if (["&&", "||"].includes(n.op)) {
        requireType(a, "boolean");
        requireType(b, "boolean");
        return "boolean";
      }
      if (["==", "!=", ">", ">=", "<", "<="].includes(n.op)) {
        merge(a, b);
        if (a === "list" || b === "list")
          invalid("Lists support length() and empty(), not comparisons.");
        return "boolean";
      }
      if (n.op === "+" && (a === "text" || b === "text")) {
        requireType(a, "text");
        requireType(b, "text");
        return "text";
      }
      if (!["+", "-", "*", "/", "%"].includes(n.op))
        invalid("Unknown formula operator.");
      requireType(a, "number");
      requireType(b, "number");
      return "number";
    }
    const types = n.args.map((a) => visit(a, depth + 1)),
      count = types.length,
      arity = (min: number, max = min) => {
        if (count < min || count > max)
          invalid(
            `${n.name}() expects ${min === max ? min : `${min}–${max}`} arguments.`,
          );
      };
    if (n.name === "if") {
      arity(3);
      requireType(types[0]!, "boolean");
      return merge(types[1]!, types[2]!);
    }
    if (n.name === "coalesce") {
      arity(2, 10);
      return types.reduce(merge);
    }
    if (n.name === "empty") {
      arity(1);
      return "boolean";
    }
    if (n.name === "length") {
      arity(1);
      if (!["text", "list", "null"].includes(types[0]!))
        invalid("length() expects text or a list.");
      return "number";
    }
    if (["abs", "ceil", "floor", "round", "min", "max"].includes(n.name)) {
      arity(
        ["min", "max"].includes(n.name) ? 2 : 1,
        ["min", "max"].includes(n.name) ? 10 : 1,
      );
      types.forEach((t) => requireType(t, "number"));
      return "number";
    }
    if (["lower", "upper", "trim", "concat", "contains"].includes(n.name)) {
      arity(
        n.name === "concat" ? 2 : n.name === "contains" ? 2 : 1,
        n.name === "concat" ? 10 : n.name === "contains" ? 2 : 1,
      );
      types.forEach((t) => requireType(t, "text"));
      return n.name === "contains" ? "boolean" : "text";
    }
    if (n.name === "format") {
      arity(1);
      if (types[0] === "list")
        invalid("Use length() for a list before format().");
      return "text";
    }
    return invalid(`Unknown function ${n.name}().`);
  }
  return visit(ast);
}

export function formatFormula(n: FormulaNode, properties: Property[]): string {
  if (n.kind === "literal") return JSON.stringify(n.value);
  if (n.kind === "property")
    return `prop(${JSON.stringify(properties.find((p) => p.id === n.id)?.name || "Missing property")})`;
  if (n.kind === "unary") return `${n.op}(${formatFormula(n.arg, properties)})`;
  if (n.kind === "binary")
    return `(${formatFormula(n.left, properties)} ${n.op} ${formatFormula(n.right, properties)})`;
  return `${n.name}(${n.args.map((a) => formatFormula(a, properties)).join(", ")})`;
}

export function relationWatchProperties(
  visible: Property[],
  properties: Property[],
) {
  const ids = new Set<string>(),
    seen = new Set<string>();
  function property(p: Property) {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    if (p.type === "Relation") ids.add(p.id);
    if (p.type === "Rollup" && p.config.rollup)
      ids.add(p.config.rollup.relationId);
    if (p.type === "Formula" && p.config.expression) visit(p.config.expression);
  }
  function visit(n: FormulaNode) {
    if (n.kind === "property") {
      const p = properties.find((p) => p.id === n.id);
      if (p) property(p);
    } else if (n.kind === "binary") {
      visit(n.left);
      visit(n.right);
    } else if (n.kind === "unary") visit(n.arg);
    else if (n.kind === "call") n.args.forEach(visit);
  }
  visible.forEach(property);
  return [...ids].sort();
}
