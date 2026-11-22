// Whether a ```ui block asks the user something: what decides if it is kept
// in front of them until they answer (ui/OpenQuestions.tsx).
import type { Expr, Program } from "./ast";

/** Components whose pick or submit goes into the user's message as an answer. */
const QUESTION_COMPONENTS: ReadonlySet<string> = new Set(["Form", "Plan", "Decision"]);

/** A Button without an action is a choice: its label is the answer. */
function isChoiceButton(call: Extract<Expr, { type: "call" }>): boolean {
  return call.name === "Button" && call.args.length < 2 && !call.named.some((arg) => arg.name === "action");
}

function asks(expr: Expr): boolean {
  switch (expr.type) {
    case "literal":
    case "state":
    case "ident":
      return false;
    case "template":
      return expr.parts.some(asks);
    case "list":
      return expr.items.some(asks);
    case "object":
      return expr.entries.some((entry) => asks(entry.value));
    case "unary":
      return asks(expr.operand);
    case "binary":
      return asks(expr.left) || asks(expr.right);
    case "conditional":
      return asks(expr.test) || asks(expr.then) || asks(expr.else);
    case "member":
      return asks(expr.object);
    case "index":
      return asks(expr.object) || asks(expr.index);
    case "call":
      return QUESTION_COMPONENTS.has(expr.name) || isChoiceButton(expr) || expr.args.some(asks) || expr.named.some((arg) => asks(arg.value));
    case "method":
      return asks(expr.object) || expr.args.some(asks) || expr.named.some((arg) => asks(arg.value));
    case "arrow":
      return asks(expr.body);
  }
}

/**
 * True when the program holds a Form, a Plan, a Decision or a Button without
 * an action, anywhere in what it renders or names. Inputs outside a Form
 * (a calculator's Slider) and FollowUps (suggestions) are not questions.
 */
export function asksQuestion(program: Program): boolean {
  return program.roots.some(asks) || [...program.named.values()].some((decl) => asks(decl.value));
}
