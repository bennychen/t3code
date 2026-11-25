// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Electron's protocol callback starts an independent Windows update helper.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const MANUAL_CHECK_INTERVAL_MS = 30 * 1_000;
const STATUS_PATH = "/__t3_custom_updates/status.json";
const REVEAL_PATH = "/__t3_custom_updates/reveal.json";

type UpdateState = {
  readonly state: "checking" | "up-to-date" | "preparing" | "ready" | "error";
  readonly currentVersion: string;
  readonly latestTag?: string;
  readonly message?: string;
  readonly stagedPath?: string;
};

function decodeStatus(value: unknown, currentVersion: string): UpdateState | null {
  if (typeof value !== "object" || value === null || !("state" in value)) return null;
  if (!("currentVersion" in value) || value.currentVersion !== currentVersion) return null;
  const state = value.state;
  if (
    state !== "checking" &&
    state !== "up-to-date" &&
    state !== "preparing" &&
    state !== "ready" &&
    state !== "error"
  ) {
    return null;
  }
  return {
    state,
    currentVersion,
    ...("latestTag" in value && typeof value.latestTag === "string"
      ? { latestTag: value.latestTag }
      : {}),
    ...("message" in value && typeof value.message === "string" ? { message: value.message } : {}),
    ...("stagedPath" in value && typeof value.stagedPath === "string"
      ? { stagedPath: value.stagedPath }
      : {}),
  };
}

export function makeCustomWindowsUpdateHandler(options: {
  readonly resourcesPath: string;
  readonly root: string;
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  readonly currentVersion: string;
  readonly reveal: (path: string) => void;
}) {
  const script = NodePath.join(options.resourcesPath, "custom-updates", "prepare-windows.mjs");
  if (!NodeFS.existsSync(script)) return undefined;

  const statusPath = NodePath.join(options.root, "status.json");
  let lastCheck = 0;
  let running = false;
  let launchError: string | undefined;

  async function readStatus(): Promise<UpdateState> {
    const saved = await NodeFSP.readFile(statusPath, "utf8")
      .then((json) => decodeStatus(JSON.parse(json), options.currentVersion))
      .catch(() => null);
    if (saved?.state === "ready") return saved;
    if (launchError && saved?.state !== "error") {
      return { state: "error", currentVersion: options.currentVersion, message: launchError };
    }
    if (running && saved?.state !== "preparing") {
      return { state: "checking", currentVersion: options.currentVersion };
    }
    return saved ?? { state: "checking", currentVersion: options.currentVersion };
  }

  function check(interval: number): void {
    const now = Date.now();
    if (running || now - lastCheck < interval) return;
    lastCheck = now;
    running = true;
    launchError = undefined;
    const child = NodeChildProcess.spawn(
      options.executable,
      [script, "--current", options.currentVersion, "--root", options.root],
      {
        env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.once("error", () => {
      running = false;
      launchError = "Could not start the patched update check.";
    });
    child.once("exit", (code) => {
      running = false;
      if (code !== 0) launchError = "The patched update check failed.";
    });
    child.unref();
  }

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.host !== "app" || (url.pathname !== STATUS_PATH && url.pathname !== REVEAL_PATH)) {
      return undefined;
    }
    if (request.headers.get("X-T3-Custom-Update") !== "1") {
      return new Response(null, { status: 403 });
    }

    if (url.pathname === STATUS_PATH && (request.method === "GET" || request.method === "POST")) {
      check(request.method === "POST" ? MANUAL_CHECK_INTERVAL_MS : CHECK_INTERVAL_MS);
      return Response.json(await readStatus(), { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === REVEAL_PATH && request.method === "POST") {
      const status = await readStatus();
      if (status.state !== "ready" || !status.stagedPath) {
        return new Response(null, { status: 404 });
      }
      const paths = await Promise.all([
        NodeFSP.realpath(options.root),
        NodeFSP.realpath(status.stagedPath),
      ]).catch(() => null);
      if (!paths) return new Response(null, { status: 404 });
      const relative = NodePath.relative(paths[0], paths[1]);
      if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${NodePath.sep}`) ||
        NodePath.isAbsolute(relative)
      ) {
        return new Response(null, { status: 404 });
      }
      options.reveal(paths[1]);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  };
}
