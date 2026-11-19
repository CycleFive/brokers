import { expect, it } from "vitest";
import { truncate, validateArgs, type JsonSchema } from "../src";

it("validates required keys, types, enums and unknown keys", () => {
  const s: JsonSchema = {
    type: "object",
    properties: {
      repo: { type: "string" },
      state: { type: "string", enum: ["open", "closed", "all"] },
      per_page: { type: "integer" },
    },
    required: ["repo"],
    additionalProperties: false,
  };
  expect(validateArgs(s, {})).toMatch(/missing required argument "repo"/);
  expect(validateArgs(s, { repo: 1 })).toMatch(/must be string/);
  expect(validateArgs(s, { repo: "a/b", state: "merged" })).toMatch(/one of/);
  expect(validateArgs(s, { repo: "a/b", nope: 1 })).toMatch(/unknown argument/);
  expect(validateArgs(s, { repo: "a/b", state: "all", per_page: 5 })).toBeNull();
});

it("enforces integer bounds", () => {
  const s = { type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 5 } }, additionalProperties: false } as const;
  expect(validateArgs(s as unknown as JsonSchema, { n: 0 })).toBe('argument "n" must be at least 1');
  expect(validateArgs(s as unknown as JsonSchema, { n: 6 })).toBe('argument "n" must be at most 5');
  expect(validateArgs(s as unknown as JsonSchema, { n: 3 })).toBeNull();
});

it("truncates with a note saying how much was cut", () => {
  expect(truncate("abc", 3)).toBe("abc");
  expect(truncate("abcdef", 3)).toMatch(/^abc\n\n\[truncated: 3 more characters/);
});
