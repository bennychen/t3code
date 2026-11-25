import { useState } from "react";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { SidebarSessionBoard, type SessionBoardCard } from "./SidebarSessionBoard";

const cards: readonly SessionBoardCard[] = [
  {
    id: "active",
    title: "Review API design",
    projectName: "Battlecraft",
    environmentName: "yoko",
    status: "active",
    canMove: true,
  },
  {
    id: "working",
    title: "Run verification",
    projectName: "Battlecraft",
    environmentName: "yoko",
    status: "working",
    canMove: true,
  },
  {
    id: "settled",
    title: "Clean up tests",
    projectName: "Wonderia",
    environmentName: "This computer",
    status: "settled",
    canMove: true,
  },
  {
    id: "offline",
    title: "Read remote logs",
    projectName: null,
    environmentName: "Offline machine",
    status: "active",
    canMove: false,
  },
];

function BoardFixture({
  onOpenSession,
  onMoveSession,
}: {
  onOpenSession: (id: string) => void;
  onMoveSession: (id: string, status: "active" | "settled") => void;
}) {
  const [open, setOpen] = useState(false);
  const [visibleCards, setVisibleCards] = useState(cards);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open session board
      </button>
      <SidebarSessionBoard
        open={open}
        onOpenChange={setOpen}
        cards={visibleCards}
        onOpenSession={onOpenSession}
        onMoveSession={(id, status) => {
          onMoveSession(id, status);
          setVisibleCards((current) =>
            current.map((card) => (card.id === id ? { ...card, status } : card)),
          );
        }}
      />
    </>
  );
}

describe("SidebarSessionBoard", () => {
  it("shows live sessions and moves an idle session in either direction without leaving the board", async () => {
    const { innerWidth, innerHeight } = window;
    onTestFinished(() => page.viewport(innerWidth, innerHeight));
    await page.viewport(1280, 800);
    const onOpenSession = vi.fn();
    const onMoveSession = vi.fn();
    await using screen = await render(
      <BoardFixture onOpenSession={onOpenSession} onMoveSession={onMoveSession} />,
    );

    const opener = screen.getByRole("button", { name: "Open session board" });
    await userEvent.click(opener);
    const board = page.getByRole("dialog", { name: "Session board" });
    const active = board.getByRole("region", { name: "Active" });
    const working = board.getByRole("region", { name: "Working" });
    const settled = board.getByRole("region", { name: "Settled" });

    await expect.element(active.getByRole("button", { name: "Review API design" })).toBeVisible();
    await expect.element(working.getByRole("button", { name: "Run verification" })).toBeVisible();
    await expect.element(settled.getByRole("button", { name: "Clean up tests" })).toBeVisible();
    expect(screen.container.contains(board.element())).toBe(false);
    const activeBounds = active.element().getBoundingClientRect();
    const workingBounds = working.element().getBoundingClientRect();
    const settledBounds = settled.element().getBoundingClientRect();
    expect(workingBounds.top).toBe(activeBounds.top);
    expect(settledBounds.top).toBe(activeBounds.top);
    expect(workingBounds.left).toBeGreaterThan(activeBounds.right);
    expect(settledBounds.left).toBeGreaterThan(workingBounds.right);
    await expect
      .element(working.getByRole("button", { name: "Settle Run verification" }))
      .not.toBeInTheDocument();
    await expect
      .element(active.getByRole("button", { name: "Settle Read remote logs" }))
      .not.toBeInTheDocument();

    const settleButton = active.getByRole("button", { name: "Settle Review API design" });
    (settleButton.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(onMoveSession).toHaveBeenNthCalledWith(1, "active", "settled");
    await expect.element(settled.getByRole("button", { name: "Review API design" })).toBeVisible();

    const returnButton = settled.getByRole("button", {
      name: "Return Review API design to Active",
    });
    await expect.element(returnButton).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onMoveSession).toHaveBeenNthCalledWith(2, "active", "active");
    await expect.element(active.getByRole("button", { name: "Review API design" })).toBeVisible();
    await expect.element(settleButton).toHaveFocus();

    await userEvent.click(working.getByRole("button", { name: "Run verification" }));
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith("working");

    await userEvent.keyboard("{Escape}");
    await expect.element(board).not.toBeInTheDocument();
    await expect.element(opener).toHaveFocus();
  });

  it("accepts a session drop in Settled while Working stays tied to actual runs", async () => {
    const onMoveSession = vi.fn();
    await using screen = await render(
      <BoardFixture onOpenSession={vi.fn()} onMoveSession={onMoveSession} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Open session board" }));
    const board = page.getByRole("dialog", { name: "Session board" });
    const active = board.getByRole("region", { name: "Active" });
    const working = board.getByRole("region", { name: "Working" });
    const settled = board.getByRole("region", { name: "Settled" });
    const cardButton = active.getByRole("button", { name: "Review API design" });
    await expect.element(cardButton).toBeVisible();
    const card = cardButton.element().closest("li[draggable=true]")!;

    const dataTransfer = new DataTransfer();
    const drag = (type: string) =>
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
    await act(() => {
      card.dispatchEvent(drag("dragstart"));
    });

    expect(working.element().dispatchEvent(drag("dragover"))).toBe(true);
    expect(onMoveSession).not.toHaveBeenCalled();

    await act(() => {
      expect(settled.element().dispatchEvent(drag("dragover"))).toBe(false);
      settled.element().dispatchEvent(drag("drop"));
    });
    expect(onMoveSession).toHaveBeenCalledExactlyOnceWith("active", "settled");
    await expect.element(settled.getByRole("button", { name: "Review API design" })).toBeVisible();
  });
});
