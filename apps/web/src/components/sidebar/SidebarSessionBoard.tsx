import { useGT } from "gt-react";
import { CircleCheckIcon, CircleDotIcon, LoaderCircleIcon } from "lucide-react";
import { type DragEvent, useId, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";

type SessionStatus = "active" | "working" | "settled";
type MoveDestination = Exclude<SessionStatus, "working">;

export interface SessionBoardCard {
  readonly id: string;
  readonly title: string;
  readonly projectName: string | null;
  readonly environmentName: string | null;
  readonly status: SessionStatus;
  readonly canMove: boolean;
}

interface SidebarSessionBoardProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly cards: readonly SessionBoardCard[];
  readonly onOpenSession: (id: string) => void;
  readonly onMoveSession: (id: string, status: MoveDestination) => void;
  readonly olderSettled?:
    | {
        readonly loading: boolean;
        readonly failed: boolean;
        readonly onShowMore: () => void;
      }
    | undefined;
}

const BOARD_DRAG_TYPE = "application/x-t3-session-board";

function moveDestination(card: SessionBoardCard): MoveDestination | null {
  if (!card.canMove || card.status === "working") return null;
  return card.status === "active" ? "settled" : "active";
}

export function SidebarSessionBoard({
  open,
  onOpenChange,
  cards,
  onOpenSession,
  onMoveSession,
  olderSettled,
}: SidebarSessionBoardProps) {
  const gt = useGT();
  const boardId = useId();
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null);
  const restoreFocus = useRef<{ id: string; destination: MoveDestination } | null>(null);
  const cardsByStatus: Record<SessionStatus, SessionBoardCard[]> = {
    active: [],
    working: [],
    settled: [],
  };
  for (const card of cards) cardsByStatus[card.status].push(card);
  const draggedCard = draggedCardId ? cards.find((card) => card.id === draggedCardId) : undefined;
  const dropDestination = draggedCard ? moveDestination(draggedCard) : null;

  const lanes = [
    {
      status: "working",
      name: gt("Working", { $context: "session board column" }),
      icon: LoaderCircleIcon,
      tone: "text-info-foreground",
    },
    {
      status: "active",
      name: gt("Active", { $context: "session board column" }),
      icon: CircleDotIcon,
      tone: "text-muted-foreground",
    },
    {
      status: "settled",
      name: gt("Settled", { $context: "session board column" }),
      icon: CircleCheckIcon,
      tone: "text-success-foreground",
    },
  ] as const;

  function dropCard(event: DragEvent<HTMLElement>, status: SessionStatus) {
    if (!draggedCard || status !== dropDestination) return;
    event.preventDefault();
    if (event.dataTransfer.getData(BOARD_DRAG_TYPE) === draggedCard.id) {
      onMoveSession(draggedCard.id, status);
    }
    setDraggedCardId(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setDraggedCardId(null);
          restoreFocus.current = null;
        }
        onOpenChange(next);
      }}
    >
      <DialogPopup className="sm:h-[min(74dvh,52rem)] sm:max-w-6xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{gt("Session board")}</DialogTitle>
          <DialogDescription>
            {gt("Move sessions between Active and Settled. Working updates as agents run.")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 overflow-y-auto px-4 pb-4 md:grid-cols-3 md:grid-rows-[minmax(0,1fr)] md:overflow-y-hidden md:px-6 md:pb-6">
          {lanes.map((lane) => {
            const headingId = `${boardId}-${lane.status}`;
            const laneCards = cardsByStatus[lane.status];
            const acceptsDrop = dropDestination === lane.status;

            return (
              <section
                key={lane.status}
                aria-labelledby={headingId}
                className={cn(
                  "flex min-w-0 flex-col rounded-xl border border-border/75 bg-muted/40 md:min-h-0",
                  acceptsDrop && "border-ring/60 bg-accent/60 ring-1 ring-inset ring-ring/25",
                )}
                onDragOver={(event) => {
                  if (!acceptsDrop) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => dropCard(event, lane.status)}
              >
                <header className="flex shrink-0 items-center gap-2 border-b border-border/65 px-3.5 py-3">
                  <lane.icon aria-hidden className={cn("size-4", lane.tone)} />
                  <h2 id={headingId} className="text-sm font-semibold">
                    {lane.name}
                  </h2>
                  <span className="ms-auto min-w-6 rounded-md bg-background/65 px-1.5 py-0.5 text-center text-xs text-muted-foreground tabular-nums">
                    {laneCards.length}
                  </span>
                </header>
                <div className="space-y-2 p-2.5 md:min-h-0 md:flex-1 md:overflow-y-auto">
                  {laneCards.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border/80 px-3 py-6 text-center text-sm text-muted-foreground">
                      {gt("No sessions", { $context: "empty session board column" })}
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {laneCards.map((card) => {
                        const destination = moveDestination(card);
                        const context = [card.projectName, card.environmentName].filter(Boolean);
                        const contextId = `${boardId}-context-${card.id}`;

                        return (
                          <li
                            key={card.id}
                            className={cn(
                              "min-w-0 rounded-lg border border-border/75 bg-popover shadow-xs transition-colors hover:border-border hover:bg-accent/55 focus-within:border-ring/60 focus-within:bg-accent/55 has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-inset has-[>button:focus-visible]:ring-ring",
                              draggedCardId === card.id && "opacity-50",
                            )}
                            draggable={destination !== null}
                            onDragStart={(event) => {
                              if (!destination) return;
                              event.dataTransfer.setData(BOARD_DRAG_TYPE, card.id);
                              event.dataTransfer.effectAllowed = "move";
                              setDraggedCardId(card.id);
                            }}
                            onDragEnd={() => setDraggedCardId(null)}
                          >
                            <button
                              type="button"
                              aria-label={card.title}
                              aria-describedby={context.length > 0 ? contextId : undefined}
                              className="block w-full p-3 text-start outline-none"
                              onClick={() => onOpenSession(card.id)}
                            >
                              <span className="block text-sm leading-snug font-medium wrap-anywhere">
                                {card.title}
                              </span>
                              {context.length > 0 && (
                                <span
                                  id={contextId}
                                  className="mt-1.5 block text-xs wrap-anywhere text-muted-foreground"
                                >
                                  {context.join(" · ")}
                                </span>
                              )}
                            </button>
                            {destination && (
                              <div className="flex justify-end px-1.5 pb-1.5">
                                <Button
                                  size="compact"
                                  variant="ghost-muted"
                                  aria-label={
                                    destination === "settled"
                                      ? gt("Settle {title}", { title: card.title })
                                      : gt("Return {title} to Active", { title: card.title })
                                  }
                                  ref={(button) => {
                                    const pending = restoreFocus.current;
                                    if (
                                      !button ||
                                      pending?.id !== card.id ||
                                      pending.destination !== card.status
                                    )
                                      return;
                                    restoreFocus.current = null;
                                    if (
                                      button.ownerDocument.activeElement ===
                                      button.ownerDocument.body
                                    ) {
                                      button.focus();
                                    }
                                  }}
                                  onClick={(event) => {
                                    if (event.detail === 0)
                                      restoreFocus.current = { id: card.id, destination };
                                    onMoveSession(card.id, destination);
                                  }}
                                >
                                  {destination === "settled"
                                    ? gt("Settle")
                                    : gt("Return to Active")}
                                </Button>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {lane.status === "settled" && olderSettled && (
                    <Button
                      className="w-full"
                      size="sm"
                      variant="ghost-muted"
                      disabled={olderSettled.loading}
                      onClick={olderSettled.onShowMore}
                    >
                      {olderSettled.loading
                        ? gt("Loading older sessions…")
                        : olderSettled.failed
                          ? gt("Retry loading older sessions")
                          : gt("Show older sessions")}
                    </Button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
