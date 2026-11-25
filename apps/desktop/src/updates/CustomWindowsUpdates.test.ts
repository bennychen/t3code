// @effect-diagnostics nodeBuiltinImport:off -- The protocol callback uses a temporary directory on the native filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";

import { makeCustomWindowsUpdateHandler } from "./CustomWindowsUpdates.ts";

it("reveals only a ready build inside the update directory from an app update request", async () => {
  const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-custom-update-"));
  try {
    const resourcesPath = NodePath.join(temporary, "resources");
    const root = NodePath.join(temporary, "updates");
    const build = NodePath.join(root, "v0.1.13");
    await NodeFSP.mkdir(NodePath.join(resourcesPath, "custom-updates"), { recursive: true });
    await NodeFSP.mkdir(build, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(resourcesPath, "custom-updates", "prepare-windows.mjs"),
      "",
    );
    const currentVersion = "0.1.12";
    const reveal = vi.fn();
    const handle = makeCustomWindowsUpdateHandler({
      resourcesPath,
      root,
      currentVersion,
      executable: process.execPath,
      env: process.env,
      reveal,
    })!;
    const endpoint = "t3code://app/__t3_custom_updates/reveal.json";
    const request = () =>
      new Request(endpoint, { method: "POST", headers: { "X-T3-Custom-Update": "1" } });
    const setStage = (stagedPath: string) =>
      NodeFSP.writeFile(
        NodePath.join(root, "status.json"),
        JSON.stringify({ state: "ready", currentVersion, stagedPath }),
      );

    await setStage(build);
    expect((await handle(new Request(endpoint, { method: "POST" })))?.status).toBe(403);
    await setStage(resourcesPath);
    expect((await handle(request()))?.status).toBe(404);
    expect(reveal).not.toHaveBeenCalled();

    await setStage(build);
    expect((await handle(request()))?.status).toBe(204);
    expect(reveal).toHaveBeenCalledOnce();
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
});
