import {
  parseFormula,
  formulaType,
  formulaPropertyType,
  FormulaError,
  type FormulaNode,
  type FormulaType,
  type Property,
} from "@orvyn/shared";
import { fail } from "../runtime.js";

export function formulaConfig(source: string, properties: Property[]) {
  try {
    const expression = parseFormula(source, properties),
      resultType = formulaType(expression, properties);
    if (resultType === "list")
      throw new FormulaError(
        "Formulas return numbers, text or booleans. Use length() or empty() for lists.",
      );
    return { formula: source, expression, resultType };
  } catch (e) {
    if (e instanceof FormulaError) fail(400, e.message);
    throw e;
  }
}

export const formulaSqlType = (type: FormulaType) =>
  type === "number"
    ? "double precision"
    : type === "boolean"
      ? "boolean"
      : type === "list"
        ? "jsonb"
        : "text";

// The parser owns the grammar. Only these operators/functions become SQL;
// literals and property IDs always use query parameters.
export function formulaSql(
  expression: FormulaNode,
  properties: Property[],
  bind: (value: unknown) => string,
  field: (property: Property) => string,
) {
  formulaType(expression, properties);
  type Value = { sql: string; type: FormulaType };
  let remaining = 512;
  const cast = (v: Value, type = v.type) =>
      `(${v.sql})::${formulaSqlType(type)}`,
    merge = (a: FormulaType, b: FormulaType) => (a === "null" ? b : a);
  function visit(n: FormulaNode, depth = 0): Value {
    if (--remaining < 0 || depth > 32)
      fail(400, "Formula dependencies are too complex.");
    if (n.kind === "literal") {
      const type =
        n.value === null
          ? "null"
          : typeof n.value === "string"
            ? "text"
            : (typeof n.value as "number" | "boolean");
      return {
        type,
        sql:
          n.value === null
            ? "NULL"
            : `${bind(n.value)}::${formulaSqlType(type)}`,
      };
    }
    if (n.kind === "property") {
      const property = properties.find((p) => p.id === n.id);
      if (!property)
        return {
          type: n.valueType,
          sql: `NULL::${formulaSqlType(n.valueType)}`,
        };
      if (property.type === "Formula")
        return visit(property.config.expression!, depth + 1);
      return { sql: field(property), type: formulaPropertyType(property) };
    }
    if (n.kind === "unary") {
      const a = visit(n.arg, depth + 1);
      if (n.op === "!")
        return { type: "boolean", sql: `(NOT ${cast(a, "boolean")})` };
      if (n.op === "+") return { type: "number", sql: cast(a, "number") };
      return {
        type: "number",
        sql: `orvyn_formula_number('neg',${cast(a, "number")},NULL)`,
      };
    }
    if (n.kind === "binary") {
      const a = visit(n.left, depth + 1),
        b = visit(n.right, depth + 1),
        type = merge(a.type, b.type);
      if (["&&", "||"].includes(n.op))
        return {
          type: "boolean",
          sql: `(${cast(a, "boolean")} ${n.op === "&&" ? "AND" : "OR"} ${cast(b, "boolean")})`,
        };
      if (["==", "!=", ">", ">=", "<", "<="].includes(n.op))
        return {
          type: "boolean",
          sql: `(${cast(a, type)} ${n.op === "==" ? "IS NOT DISTINCT FROM" : n.op === "!=" ? "IS DISTINCT FROM" : n.op} ${cast(b, type)})`,
        };
      if (n.op === "+" && type === "text")
        return {
          type: "text",
          sql: `left(coalesce(${cast(a, "text")},'')||coalesce(${cast(b, "text")},''),10000)`,
        };
      const operators: Record<string, string> = {
          "+": "add",
          "-": "sub",
          "*": "mul",
          "/": "div",
          "%": "mod",
        },
        op = operators[n.op]!;
      return {
        type: "number",
        sql: `orvyn_formula_number('${op}',${cast(a, "number")},${cast(b, "number")})`,
      };
    }
    const args = n.args.map((a) => visit(a, depth + 1)),
      a = args[0]!;
    if (n.name === "if") {
      const type = merge(args[1]!.type, args[2]!.type);
      return {
        type,
        sql: `(CASE WHEN ${cast(a, "boolean")} THEN ${cast(args[1]!, type)} ELSE ${cast(args[2]!, type)} END)`,
      };
    }
    if (n.name === "coalesce") {
      const type = args.map((a) => a.type).reduce(merge);
      return {
        type,
        sql: `coalesce(${args.map((a) => cast(a, type)).join(",")})`,
      };
    }
    if (n.name === "empty")
      return {
        type: "boolean",
        sql:
          a.type === "list"
            ? `(coalesce(${cast(a)},'[]'::jsonb)='[]'::jsonb)`
            : a.type === "text"
              ? `(coalesce(${cast(a)},'')='')`
              : `(${a.sql} IS NULL)`,
      };
    if (n.name === "length")
      return {
        type: "number",
        sql:
          a.type === "list"
            ? `jsonb_array_length(coalesce(${cast(a)},'[]'::jsonb))::double precision`
            : `length(coalesce(${cast(a, "text")},''))::double precision`,
      };
    if (["abs", "ceil", "floor", "round"].includes(n.name))
      return {
        type: "number",
        sql: `orvyn_formula_number('${n.name}',${cast(a, "number")},NULL)`,
      };
    if (["min", "max"].includes(n.name))
      return {
        type: "number",
        sql: `${n.name === "min" ? "least" : "greatest"}(${args.map((a) => cast(a, "number")).join(",")})`,
      };
    if (["lower", "upper", "trim"].includes(n.name))
      return { type: "text", sql: `${n.name}(${cast(a, "text")})` };
    if (n.name === "concat")
      return {
        type: "text",
        sql: `left(${args.map((a) => `coalesce(${cast(a, "text")},'')`).join("||")},10000)`,
      };
    if (n.name === "contains")
      return {
        type: "boolean",
        sql: `(strpos(coalesce(${cast(a, "text")},''),${cast(args[1]!, "text")})>0)`,
      };
    if (n.name === "format")
      return { type: "text", sql: `coalesce(${cast(a, "text")},'')` };
    return fail(400, "Unknown formula function.");
  }
  const result = visit(expression);
  return { type: result.type, sql: cast(result) };
}
