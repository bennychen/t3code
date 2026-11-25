import * as Schema from "effect/Schema";
import { msg, T, useGT } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { readLocalStorageValue, writeLocalStorageValue } from "../../hooks/useLocalStorage";
import { useStableCallback } from "../../hooks/useStableCallback";
import { m } from "../../i18n/messages";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { DesktopUpdateStatusIcon } from "./DesktopUpdateStatusIcon";

const STATUS_URL = "/__t3_custom_updates/status.json";
const REVEAL_URL = "/__t3_custom_updates/reveal.json";
const UPDATE_HEADERS = { "X-T3-Custom-Update": "1" };
const POLL_INTERVAL_MS = 15_000;
const NOTICE_HISTORY_KEY = "t3code.custom-update-notices";
const NoticeHistory = Schema.Array(Schema.String);

const CustomUpdateStatus = Schema.Struct({
  state: Schema.Literals(["checking", "up-to-date", "preparing", "ready", "error"]),
  currentVersion: Schema.String,
  latestTag: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  stagedPath: Schema.optionalKey(Schema.String),
});
type CustomUpdateStatus = typeof CustomUpdateStatus.Type;
const decodeStatus = Schema.decodeUnknownSync(CustomUpdateStatus);

function notifyStatus({ state, latestTag, message }: CustomUpdateStatus) {
  if (!latestTag || (state !== "preparing" && state !== "ready" && state !== "error")) return;

  const key = `${latestTag}:${state}`;
  const history = readLocalStorageValue(NOTICE_HISTORY_KEY, [], NoticeHistory);
  if (history.includes(key)) return;
  writeLocalStorageValue(NOTICE_HISTORY_KEY, [...history.slice(-31), key], [], NoticeHistory);

  if (state === "preparing") {
    toastManager.add({
      type: "info",
      title: m(msg("Preparing custom update {version}", { version: latestTag })),
    });
  } else if (state === "ready") {
    toastManager.add({
      type: "success",
      title: m(msg("Custom update {version} is ready to test", { version: latestTag })),
    });
  } else {
    toastManager.add({
      type: "error",
      title: m(msg("Could not prepare custom update {version}", { version: latestTag })),
      ...(message && { description: message }),
    });
  }
}

export function CustomDesktopUpdatePill() {
  const gt = useGT();
  const [status, setStatus] = useState<CustomUpdateStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [checkingNow, setCheckingNow] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useStableCallback(async (method: "GET" | "POST") => {
    if (method === "GET" && activeRequest.current) return;
    activeRequest.current?.abort();

    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const response = await fetch(STATUS_URL, {
        method,
        headers: UPDATE_HEADERS,
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error(`Custom update check failed (${response.status})`);

      const next = decodeStatus(await response.json());
      if (controller.signal.aborted) return;
      setUnavailable(false);
      setStatus(next);
      notifyStatus(next);
    } catch {
      if (!controller.signal.aborted) setUnavailable(true);
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
      }
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Poll the local desktop update service while the pill is mounted.
  useEffect(() => {
    void refresh("GET");
    const timer = window.setInterval(() => void refresh("GET"), POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [refresh]);

  const checkNow = async () => {
    setCheckingNow(true);
    try {
      await refresh("POST");
    } finally {
      setCheckingNow(false);
    }
  };

  const reveal = async () => {
    try {
      const response = await fetch(REVEAL_URL, { method: "POST", headers: UPDATE_HEADERS });
      if (response.status !== 204) throw new Error("The staged update could not be opened");
    } catch {
      toastManager.add({ type: "error", title: gt("Could not open the staged update") });
    }
  };

  const state = unavailable ? "unavailable" : (status?.state ?? "checking");
  const latestVersion = status?.latestTag ?? gt("new release");
  const label = (() => {
    switch (state) {
      case "unavailable":
        return gt("Custom update service is unavailable");
      case "checking":
        return gt("Checking for updates…");
      case "up-to-date":
        return gt("Up to date");
      case "preparing":
        return gt("Preparing custom update {version}", { version: latestVersion });
      case "ready":
        return gt("Custom update {version} is ready to test", { version: latestVersion });
      case "error":
        return gt("Custom update preparation failed");
    }
  })();
  const attentionNeeded = state === "error" || state === "unavailable";
  const checking = state === "checking" || state === "preparing";

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Popover>
        <PopoverTrigger
          aria-label={gt("Custom T3 Code updates")}
          title={label}
          render={<Button size="icon-sm-pill" variant="ghost-muted" />}
        >
          {attentionNeeded ? (
            <TriangleAlertIcon aria-hidden className="size-4 text-warning-foreground" />
          ) : (
            <DesktopUpdateStatusIcon
              status={state === "ready" ? "available" : checking ? "checking" : "idle"}
              isCheckAnimating={checking}
            />
          )}
        </PopoverTrigger>
        <PopoverPopup align="end" side="top" width="sm">
          <PopoverTitle>
            <T>Custom T3 Code updates</T>
          </PopoverTitle>
          <p className="mt-3 text-sm" role="status">
            {label}
          </p>
          {status?.currentVersion ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {gt("Installed version {version}", { version: status.currentVersion })}
            </p>
          ) : null}
          {state === "error" && status?.message ? (
            <p className="mt-1 text-xs wrap-break-word text-muted-foreground">{status.message}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              disabled={checkingNow || state === "preparing"}
              onClick={() => void checkNow()}
              size="sm"
              variant="outline"
            >
              <T>Check now</T>
            </Button>
            {state === "ready" ? (
              <Button onClick={() => void reveal()} size="sm">
                <T>Open staged build</T>
              </Button>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
}
