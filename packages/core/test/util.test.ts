import { expect, it } from "vitest";
import { base64url, publicUrl, required } from "../src";

it("publicUrl strips trailing slashes and insists on being set", () => {
  expect(publicUrl({ PUBLIC_URL: "https://b.test//" })).toBe("https://b.test");
  expect(() => publicUrl({})).toThrow("PUBLIC_URL is not set");
});

it("required returns a non-empty string setting or names the missing key", () => {
  expect(required({ A: "x" }, "A")).toBe("x");
  expect(() => required({ A: "" }, "A")).toThrow("A is not set");
});

it("base64url is unpadded and URL-safe, for bytes and strings", () => {
  expect(base64url(new Uint8Array([251, 255, 254]))).toBe("-__-");
  expect(base64url("{}")).toBe("e30");
});
