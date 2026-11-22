import { describe, expect, it } from "vitest";
import { compile } from "./index";
import { asksQuestion } from "./questions";

function asks(source: string): boolean {
  const { program, diagnostics } = compile(source);
  if (program === null) throw new Error(diagnostics.map((d) => d.message).join("; "));
  return asksQuestion(program);
}

describe("asksQuestion", () => {
  it("finds a Form inside a Card", () => {
    expect(asks('$scope = ""\nCard("Before I plan", [Form([Radio($scope, [{value: "All"}, {value: "One"}], label: "What?")])])')).toBe(true);
  });

  it("finds Buttons without an action", () => {
    expect(asks('Card("Caching", [Button("Use in memory"), Button("Use Redis")])')).toBe(true);
  });

  it("finds a Plan and a Decision", () => {
    expect(asks('Card("Audit log", [Plan([{title: "Add the table"}])])')).toBe(true);
    expect(asks('Card("Queue", [Decision([{name: "A", scores: [4]}, {name: "B", scores: [2]}], ["Cost"])])')).toBe(true);
  });

  it("finds a question held in a named value", () => {
    expect(asks('choices = Row([Button("Yes"), Button("No")])\nCard("Go on?", [choices])')).toBe(true);
  });

  it("does not count a Button with an action, or inputs outside a Form", () => {
    expect(asks('$n = 3\nCard("Estimate", [Slider($n, 1, 9, label: "Seats"), Button("Reset", Set($n, 3)), Button("Copy", action: Copy("x"))])')).toBe(false);
  });

  it("does not count a report or FollowUps", () => {
    expect(asks('Card("Result", [Metric("Tests", "494"), FollowUps(["What is left?"])])')).toBe(false);
  });
});
