import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { toastManager } from "../ui/toast";
import { CustomDesktopUpdatePill } from "./CustomDesktopUpdatePill";

const STATUS_URL = "/__t3_custom_updates/status.json";
const REVEAL_URL = "/__t3_custom_updates/reveal.json";
const updateHeaders = { "X-T3-Custom-Update": "1" };
const currentVersion = "0.1.12";

function resetNoticeHistory() {
  const key = "t3code.custom-update-notices";
  const previous = localStorage.getItem(key);
  localStorage.removeItem(key);
  return {
    [Symbol.dispose]() {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    },
  };
}

describe("CustomDesktopUpdatePill", () => {
  it("checks again and opens only the staged custom build", async () => {
    using _history = resetNoticeHistory();
    const fetch = globalThis.fetch;
    using fetchUpdate = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (url === REVEAL_URL) return new Response(null, { status: 204 });
      if (url !== STATUS_URL) return fetch(url, init);
      return Response.json(
        init?.method === "POST"
          ? { state: "ready", currentVersion, latestTag: "v0.1.13" }
          : { state: "up-to-date", currentVersion },
      );
    });
    using toast = vi.spyOn(toastManager, "add");
    await using _screen = await render(<CustomDesktopUpdatePill />);

    await userEvent.click(page.getByRole("button", { name: "Custom T3 Code updates" }));
    await expect.element(page.getByRole("status")).toHaveTextContent("Up to date");
    await expect
      .element(page.getByRole("button", { name: "Open staged build" }))
      .not.toBeInTheDocument();
    expect(fetchUpdate).toHaveBeenCalledWith(
      STATUS_URL,
      expect.objectContaining({ method: "GET", headers: updateHeaders }),
    );

    const check = page.getByRole("button", { name: "Check now" });
    await userEvent.click(check);
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Custom update v0.1.13 is ready to test");
    expect(fetchUpdate).toHaveBeenCalledWith(
      STATUS_URL,
      expect.objectContaining({ method: "POST", headers: updateHeaders }),
    );
    await userEvent.click(check);
    await expect.element(check).toBeEnabled();
    expect(toast).toHaveBeenCalledTimes(1);

    await userEvent.click(page.getByRole("button", { name: "Open staged build" }));
    expect(fetchUpdate).toHaveBeenCalledWith(REVEAL_URL, {
      method: "POST",
      headers: updateHeaders,
    });
  });

  it("handles a missing endpoint and shows a specific preparation error after retry", async () => {
    const fetch = globalThis.fetch;
    using _fetchUpdate = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (url !== STATUS_URL) return fetch(url, init);
      if (init?.method === "GET") return new Response(null, { status: 404 });
      return Response.json({ state: "error", currentVersion, message: "Patch conflict" });
    });
    await using _screen = await render(<CustomDesktopUpdatePill />);

    await userEvent.click(page.getByRole("button", { name: "Custom T3 Code updates" }));
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Custom update service is unavailable");
    await userEvent.click(page.getByRole("button", { name: "Check now" }));
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Custom update preparation failed");
    await expect.element(page.getByText("Patch conflict")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Open staged build" }))
      .not.toBeInTheDocument();
  });
});
