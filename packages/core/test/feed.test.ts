import { beforeEach, expect, it, vi } from "vitest";
import { auditedFeed, json } from "../src/feed";

const log = vi.spyOn(console, "log").mockImplementation(() => {});
beforeEach(() => log.mockClear());

const fail = () => ({ status: 500, error: "internal error" });

it("writes the audit line with these keys in this order, without the query", async () => {
  await auditedFeed(new Request("https://x/api/a?secret=1"), async () => json({ ok: 1 }), fail);
  const line = JSON.parse(log.mock.calls[0][0] as string);
  expect(Object.keys(line)).toEqual(["event", "method", "path", "status", "ms"]);
  expect(line).toMatchObject({ event: "feed", method: "GET", path: "/api/a", status: 200 });
});

it("keeps an exception's message out of the body and in the log", async () => {
  const res = await auditedFeed(
    new Request("https://x/identity"),
    async () => {
      throw new Error("token abc123 rejected");
    },
    () => ({ status: 502, error: "upstream unavailable" }),
  );
  expect(res.status).toBe(502);
  expect(await res.text()).toBe('{"error":"upstream unavailable"}');
  expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ status: 502, message: "token abc123 rejected" });
});

it("sends no body with 204, 205 and 304", () => {
  for (const s of [204, 205, 304]) expect(json({}, s).body).toBeNull();
});

it("answers JSON with a charset", async () => {
  const res = json({ a: 1 }, 201);
  expect(res.status).toBe(201);
  expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
});
