// The portal is also rendered on the server, where one process serves every
// user. Nothing the store holds may live in module state there.
import { describe, expect, it } from "vitest";
import { useAcademyStore } from "@/hooks/use-store-entry";
import { clearAcademyStore } from "@/lib/academy-store";

describe("useAcademyStore on the server", () => {
  const seed = (who: string) => ({
    key: "bootstrap",
    url: "/boot",
    tags: ["bootstrap"],
    data: { who },
  });
  it("runs without a window, as it does during server rendering", () => {
    expect(typeof window).toBe("undefined");
  });
  it("gives every call its own store, so one user's data never reaches another's", () => {
    const first = useAcademyStore("academy-1", seed("first viewer")),
      second = useAcademyStore("academy-1", seed("second viewer")),
      third = useAcademyStore("academy-1");
    expect(second).not.toBe(first);
    expect(third).not.toBe(first);
    expect(first.state("bootstrap").data).toEqual({ who: "first viewer" });
    expect(second.state("bootstrap").data).toEqual({ who: "second viewer" });
    // A render with nothing to seed sees nothing, not an earlier user's data.
    expect(third.state("bootstrap")).toEqual({ status: "idle" });
    clearAcademyStore();
  });
});
