import { describe, expect, it } from "vitest";
import { normalizeHost } from "./remote";

describe("normalizeHost", () => {
  it("accepts a tailnet host name and strips the trailing dot Tailscale reports", () => {
    expect(normalizeHost("My-Mac.tail1234.ts.net.")).toBe("my-mac.tail1234.ts.net");
  });

  it("strips scheme, path and query", () => {
    expect(normalizeHost("https://my-mac.tail1234.ts.net/?token=x")).toBe("my-mac.tail1234.ts.net");
  });

  it("rejects values that are not a dotted DNS name", () => {
    expect(normalizeHost(undefined)).toBeUndefined();
    expect(normalizeHost("")).toBeUndefined();
    expect(normalizeHost("localhost")).toBeUndefined();
    expect(normalizeHost("evil host.example.com")).toBeUndefined();
    expect(normalizeHost("a.b.ts.net:8080")).toBeUndefined();
  });
});
