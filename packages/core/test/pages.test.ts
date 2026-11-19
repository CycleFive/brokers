import { describe, expect, it } from "vitest";
import { consentPage, errorPage, escapeHtml } from "../src/pages";

describe("pages", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });

  it("errorPage carries the status, the CSP and no-store", () => {
    const r = errorPage("x", 418);
    expect(r.status).toBe(418);
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("consentPage names the broker, the grant and the upstream service", async () => {
    const r = consentPage(
      { clientName: "C", redirectHost: "claude.ai", redirectIsLoopback: false } as any,
      "h",
      new Headers(),
      { title: "Fake broker", label: "Fake", grants: "wants to test." },
    );
    const html = await r.text();
    expect(html).toContain("Connect Fake broker");
    expect(html).toContain("wants to test.");
    expect(html).toContain("Continue to Fake");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});
