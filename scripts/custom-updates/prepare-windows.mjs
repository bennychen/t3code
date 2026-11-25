import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const upstream = "https://github.com/pingdotgg/t3code.git";
const fork = "https://github.com/bennychen/t3code.git";
const releaseUrl = "https://api.github.com/repos/pingdotgg/t3code/releases/latest";
const executableName = "T3 Code (Beta).exe";
const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const { values } = NodeUtil.parseArgs({
  options: { current: { type: "string" }, root: { type: "string" } },
});

function parseVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) {
    throw new Error("Expected a stable T3 Code version.");
  }
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error("T3 Code version component exceeds the supported range.");
  }
  return parts;
}

function isNewer(version, current) {
  const parts = parseVersion(version);
  const installed = parseVersion(current);
  const difference = parts.findIndex((part, index) => part !== installed[index]);
  return difference !== -1 && parts[difference] > installed[difference];
}

function readJson(filename) {
  return JSON.parse(NodeFS.readFileSync(filename, "utf8").replace(/^\uFEFF/u, ""));
}

function writeJson(filename, value) {
  const temporary = filename + "." + NodeCrypto.randomUUID() + ".tmp";
  try {
    NodeFS.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    NodeFS.renameSync(temporary, filename);
  } finally {
    NodeFS.rmSync(temporary, { force: true });
  }
}

function acquireLock(filename) {
  try {
    NodeFS.writeFileSync(filename, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = Number(NodeFS.readFileSync(filename, "utf8"));
    if (!Number.isSafeInteger(previous) || previous <= 0) return false;
    try {
      process.kill(previous, 0);
      return false;
    } catch (signalError) {
      if (signalError.code !== "ESRCH") return false;
      NodeFS.unlinkSync(filename);
      return acquireLock(filename);
    }
  }
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !NodePath.isAbsolute(value)) {
    throw new Error(label + " must be an absolute local path.");
  }
  return NodePath.resolve(value);
}

function loadConfig() {
  const settings = readJson(NodePath.join(scriptDirectory, "config.json"));
  const configuration = {
    checkout: absolutePath(settings.checkout, "T3 Code checkout"),
    patchBaseTag: settings.patchBaseTag,
    patchBranch: settings.patchBranch,
    asarModule: absolutePath(settings.asarModule, "ASAR module"),
    fusesCli: absolutePath(settings.fusesCli, "Electron fuses CLI"),
    sevenZip: absolutePath(settings.sevenZip, "7-Zip"),
    ...(settings.installerCache === undefined
      ? {}
      : { installerCache: absolutePath(settings.installerCache, "Installer cache") }),
  };
  if (
    configuration.patchBaseTag !== "v" + values.current ||
    configuration.patchBranch !== "codex/remote-save-file-" + configuration.patchBaseTag
  ) {
    throw new Error("The patch source does not match the installed T3 Code version.");
  }
  return configuration;
}

async function sha256(filename) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const bytes of NodeFS.createReadStream(filename)) hash.update(bytes);
  return hash.digest("hex");
}

function run(command, args, cwd, label, log, environment = process.env) {
  const descriptor = log === undefined ? undefined : NodeFS.openSync(log, "a");
  try {
    const result = NodeChildProcess.spawnSync(command, args, {
      cwd,
      env: environment,
      windowsHide: true,
      timeout: 30 * 60_000,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio:
        descriptor === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", descriptor, descriptor],
    });
    if (result.status !== 0) {
      const detail = result.error?.message ?? result.stderr?.trim();
      throw new Error(label + " failed." + (log ? " See " + log : detail ? " " + detail : ""));
    }
    return result.stdout?.trim() ?? "";
  } finally {
    if (descriptor !== undefined) NodeFS.closeSync(descriptor);
  }
}

function git(args, cwd, label, log) {
  return run(
    "git.exe",
    ["-c", "core.longpaths=true", "-c", "credential.username=bennychen", ...args],
    cwd,
    label,
    log,
    { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
  );
}

function checkRemotes(checkout) {
  if (
    git(["remote", "get-url", "--all", "origin"], checkout, "Read upstream remote") !== upstream ||
    git(["remote", "get-url", "--all", "fork"], checkout, "Read fork remote") !== fork ||
    git(["remote", "get-url", "--push", "--all", "fork"], checkout, "Read fork push remote") !==
      fork
  ) {
    throw new Error(
      "The checkout must point to pingdotgg/t3code upstream and bennychen/t3code for pushes.",
    );
  }
}

async function latestStable() {
  const response = await fetch(releaseUrl, {
    headers: { accept: "application/vnd.github+json", "user-agent": "T3-Code-Custom-Updates" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error("GitHub release check failed with HTTP " + response.status + ".");
  const release = await response.json();
  const tag = release.tag_name;
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    typeof tag !== "string" ||
    !tag.startsWith("v")
  ) {
    throw new Error("GitHub did not return a published stable T3 Code release.");
  }
  const version = tag.slice(1);
  parseVersion(version);
  return { tag, version, assets: release.assets };
}

async function officialInstaller(release, configuration, releaseDirectory) {
  const filename = "T3-Code-" + release.version + "-x64.exe";
  const url =
    "https://github.com/pingdotgg/t3code/releases/download/" + release.tag + "/" + filename;
  const matchingAssets = release.assets?.filter((asset) => asset.name === filename);
  const asset = matchingAssets?.length === 1 ? matchingAssets[0] : undefined;
  if (asset?.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest)) {
    throw new Error("The official Windows x64 installer or its SHA-256 digest is missing.");
  }

  const expected = asset.digest.slice("sha256:".length);
  const installer = NodePath.join(releaseDirectory, filename);
  if (NodeFS.existsSync(installer)) {
    if ((await sha256(installer)) !== expected)
      throw new Error("The stored installer has an unexpected digest.");
    return installer;
  }
  let cache = configuration.installerCache;
  if (cache && NodeFS.existsSync(cache) && NodeFS.statSync(cache).isDirectory())
    cache = NodePath.join(cache, filename);
  if (
    cache &&
    NodePath.basename(cache) === filename &&
    NodeFS.existsSync(cache) &&
    (await sha256(cache)) === expected
  ) {
    return cache;
  }

  const temporary = installer + "." + NodeCrypto.randomUUID() + ".partial";
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "T3-Code-Custom-Updates" },
      signal: AbortSignal.timeout(20 * 60_000),
    });
    if (!response.ok || response.body === null) {
      throw new Error(
        "Downloading the official Windows installer failed with HTTP " + response.status + ".",
      );
    }
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(response.body),
      NodeFS.createWriteStream(temporary, { flags: "wx" }),
    );
    if ((await sha256(temporary)) !== expected)
      throw new Error("The official installer digest did not match.");
    NodeFS.renameSync(temporary, installer);
    return installer;
  } finally {
    NodeFS.rmSync(temporary, { force: true });
  }
}

function verifyPublisher(file, reference, cwd) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$reference = Get-AuthenticodeSignature -LiteralPath $env:T3_UPDATE_REFERENCE",
    "$candidate = Get-AuthenticodeSignature -LiteralPath $env:T3_UPDATE_CANDIDATE",
    "if ($reference.Status -ne 'Valid' -or $candidate.Status -ne 'Valid' -or",
    "    -not $reference.SignerCertificate -or -not $candidate.SignerCertificate -or",
    "    $candidate.SignerCertificate.Subject -cne $reference.SignerCertificate.Subject) {",
    "  throw 'The file does not have the installed T3 Code publisher signature.'",
    "}",
  ].join("\n");
  run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64"),
    ],
    cwd,
    "Verify the T3 Code Authenticode publisher",
    undefined,
    {
      ...process.env,
      PSModulePath: undefined,
      T3_UPDATE_REFERENCE: reference,
      T3_UPDATE_CANDIDATE: file,
    },
  );
}

function extractStock(configuration, installer, reference, attempt, log) {
  verifyPublisher(installer, reference, attempt);
  run(
    configuration.sevenZip,
    ["e", installer, "$PLUGINSDIR\\app-64.7z", "-o" + attempt, "-y"],
    attempt,
    "Extract the Windows x64 installer payload",
    log,
  );
  const stock = NodePath.join(attempt, "stock");
  run(
    configuration.sevenZip,
    ["x", NodePath.join(attempt, "app-64.7z"), "-o" + stock, "-y"],
    attempt,
    "Extract the stock T3 Code app",
    log,
  );
  verifyPublisher(NodePath.join(stock, executableName), reference, attempt);
  const stockResources = NodePath.join(stock, "resources");
  if (!NodeFS.statSync(NodePath.join(stockResources, "server.asar")).isFile()) {
    throw new Error("The stock installer does not use the expected Windows renderer archive.");
  }
  return stock;
}

function prepareWorktree(configuration, release, branch, attempt, log) {
  const checkout = configuration.checkout;
  git(
    [
      "fetch",
      "--no-tags",
      "--depth=1",
      "origin",
      "refs/tags/" + release.tag + ":refs/tags/" + release.tag,
    ],
    checkout,
    "Fetch the official stable release tag",
    log,
  );
  const sourceRef = "refs/remotes/fork/" + configuration.patchBranch;
  git(
    ["fetch", "--no-tags", "fork", "refs/heads/" + configuration.patchBranch + ":" + sourceRef],
    checkout,
    "Fetch the installed release’s custom patch branch",
    log,
  );
  const base = "refs/tags/" + configuration.patchBaseTag;
  git(["merge-base", "--is-ancestor", base, sourceRef], checkout, "Validate the patch branch base");
  const range = base + ".." + sourceRef;
  if (git(["rev-list", "--merges", range], checkout, "Check the custom patch history")) {
    throw new Error("The installed release’s custom patch branch must be linear.");
  }
  const patches = git(["rev-list", "--reverse", range], checkout, "Read custom patches")
    .split(/\r?\n/u)
    .filter(Boolean);
  if (patches.length === 0) throw new Error("The patch branch has no commits to port.");
  const worktree = NodePath.join(attempt, "source");
  git(
    ["worktree", "add", "--detach", worktree, "refs/tags/" + release.tag],
    checkout,
    "Create an isolated stable-release checkout",
    log,
  );
  git(
    [
      "-c",
      "user.name=Benny Chen",
      "-c",
      "user.email=887747+bennychen@users.noreply.github.com",
      "cherry-pick",
      "--empty=drop",
      ...patches,
    ],
    worktree,
    "Apply the custom patch stack for " + release.tag,
    log,
  );

  const publishedRef = "refs/heads/" + branch;
  const published = git(
    ["ls-remote", "--heads", "fork", publishedRef],
    checkout,
    "Check for an existing fork release branch",
  );
  if (published) {
    git(
      ["fetch", "--no-tags", "fork", publishedRef + ":refs/remotes/fork/" + branch],
      checkout,
      "Fetch the existing fork branch",
      log,
    );
    const remoteRef = "refs/remotes/fork/" + branch;
    git(
      ["merge-base", "--is-ancestor", "refs/tags/" + release.tag, remoteRef],
      worktree,
      "Verify the existing release branch is based on the official tag",
    );
    git(
      ["diff", "--exit-code", "HEAD", remoteRef],
      worktree,
      "Verify the existing release branch matches the prepared source",
      log,
    );
    git(
      ["checkout", "--detach", remoteRef],
      worktree,
      "Reuse the existing fork release commit",
      log,
    );
  }
  return worktree;
}

function pinnedToolchain(worktree, log) {
  const metadata = readJson(NodePath.join(worktree, "package.json"));
  const node = metadata.engines?.node;
  const pnpm = metadata.packageManager;
  parseVersion(node);
  if (typeof pnpm !== "string" || !/^pnpm@\d+\.\d+\.\d+$/u.test(pnpm)) {
    throw new Error("The official release does not pin pnpm in the expected format.");
  }
  const search = [
    NodePath.dirname(process.execPath),
    ...(process.env.PATH ?? "").split(NodePath.delimiter),
  ];
  const nodeHome = search
    .filter((entry) => NodePath.isAbsolute(entry))
    .find(
      (entry) =>
        NodeFS.existsSync(NodePath.join(entry, "node.exe")) &&
        NodeFS.existsSync(NodePath.join(entry, "node_modules", "npm", "bin", "npm-cli.js")),
    );
  if (nodeHome === undefined) {
    throw new Error("Install Node.js with npm on this computer to prepare T3 Code updates.");
  }
  const npm = NodePath.join(nodeHome, "node_modules", "npm", "bin", "npm-cli.js");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;

  return (packages, executable, arguments_, cwd, label) => {
    run(
      NodePath.join(nodeHome, "node.exe"),
      [
        npm,
        "exec",
        "--yes",
        "--package=node@" + node,
        ...packages.map((item) => "--package=" + item),
        "--",
        executable,
        ...arguments_,
      ],
      cwd,
      label,
      log,
      environment,
    );
  };
}

function buildCandidate(configuration, release, branch, stock, attempt, log, worktree) {
  const runPinned = pinnedToolchain(worktree, log);
  const metadata = readJson(NodePath.join(worktree, "package.json"));
  runPinned(
    [metadata.packageManager],
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--filter",
      "@t3tools/web...",
      "--filter",
      "@t3tools/desktop...",
    ],
    worktree,
    "Install the release’s pinned dependencies",
  );
  const vite = NodePath.join(worktree, "node_modules", "vite-plus", "bin", "vp");
  const web = NodePath.join(worktree, "apps", "web");
  runPinned(
    [],
    "node",
    [vite, "run", "--filter", "@t3tools/web", "typecheck"],
    worktree,
    "Typecheck the patched file preview",
  );
  runPinned(
    [],
    "node",
    ["node_modules/playwright/cli.js", "install", "--only-shell", "chromium"],
    web,
    "Prepare headless Chromium",
  );
  runPinned(
    [],
    "node",
    [
      vite,
      "test",
      "run",
      "--project",
      "browser",
      "src/components/files/FilePreviewPanel.browser.test.tsx",
      "-t",
      "downloads the original bytes",
    ],
    web,
    "Test the patched Save file action",
  );

  const stagedPath = NodePath.join(attempt, "app");
  runPinned(
    [],
    "node",
    [
      NodePath.join(worktree, "scripts", "custom-updates", "stage-windows.mjs"),
      "--repo",
      worktree,
      "--version",
      release.version,
      "--stock",
      stock,
      "--destination",
      stagedPath,
      "--asar-module",
      configuration.asarModule,
      "--fuses-cli",
      configuration.fusesCli,
      "--seven-zip",
      configuration.sevenZip,
    ],
    worktree,
    "Build the patched Windows app",
  );

  const resources = NodePath.join(stagedPath, "resources");
  if (NodeFS.existsSync(NodePath.join(resources, "app-update.yml"))) {
    throw new Error("The staged build would use the stock updater feed.");
  }
  const updateScripts = NodePath.join(resources, "custom-updates");
  NodeFS.mkdirSync(updateScripts, { recursive: true });
  const sourceScripts = NodePath.join(worktree, "scripts", "custom-updates");
  for (const name of ["prepare-windows.mjs", "stage-windows.mjs"]) {
    NodeFS.copyFileSync(NodePath.join(sourceScripts, name), NodePath.join(updateScripts, name));
  }
  writeJson(NodePath.join(updateScripts, "config.json"), {
    ...configuration,
    patchBaseTag: release.tag,
    patchBranch: branch,
  });
  return stagedPath;
}

async function validateCandidate(candidate, releaseDirectory, tag, branch, checkout) {
  if (
    candidate.tag !== tag ||
    candidate.branch !== branch ||
    !/^[a-f0-9]{40,64}$/u.test(candidate.revision)
  ) {
    throw new Error("The saved update candidate has invalid source metadata.");
  }
  const stagedPath = NodePath.resolve(releaseDirectory, candidate.directory);
  const relative = NodePath.relative(releaseDirectory, NodeFS.realpathSync(stagedPath));
  if (!/^attempt-[\w-]+[\\/]app$/u.test(relative)) {
    throw new Error("The saved update candidate points outside its staging directory.");
  }
  const resources = NodePath.join(stagedPath, "resources");
  if (NodeFS.existsSync(NodePath.join(resources, "app-update.yml"))) {
    throw new Error("The saved update candidate has the stock updater enabled.");
  }
  for (const [name, filename] of [
    ["executable", NodePath.join(stagedPath, executableName)],
    ["serverArchive", NodePath.join(resources, "server.asar")],
    ["desktopArchive", NodePath.join(resources, "app.asar")],
  ]) {
    if ((await sha256(filename)) !== candidate.hashes[name]) {
      throw new Error("The saved update candidate no longer matches its verified " + name + ".");
    }
  }
  git(
    ["merge-base", "--is-ancestor", "refs/tags/" + tag, candidate.revision],
    checkout,
    "Verify the saved candidate’s release tag",
  );
  return stagedPath;
}

async function prepareUpdate(root, configuration, release, updateStatus) {
  const branch = "codex/remote-save-file-" + release.tag;
  const releaseDirectory = NodePath.join(root, "releases", release.tag);
  const marker = NodePath.join(releaseDirectory, "candidate.json");
  NodeFS.mkdirSync(releaseDirectory, { recursive: true });
  checkRemotes(configuration.checkout);

  let candidate;
  if (NodeFS.existsSync(marker)) {
    candidate = readJson(marker);
  } else {
    const attempt = NodeFS.mkdtempSync(NodePath.join(releaseDirectory, "attempt-"));
    const log = NodePath.join(attempt, "prepare.log");
    const reference = NodePath.join(
      absolutePath(process.env.LOCALAPPDATA, "Local app data"),
      "Programs",
      "t3code",
      executableName,
    );
    const worktree = prepareWorktree(configuration, release, branch, attempt, log);
    updateStatus("preparing", "Downloading and verifying the official Windows installer.");
    const installer = await officialInstaller(release, configuration, releaseDirectory);
    const stock = extractStock(configuration, installer, reference, attempt, log);
    updateStatus("preparing", "Testing and building the patched Windows update.");
    const stagedPath = buildCandidate(
      configuration,
      release,
      branch,
      stock,
      attempt,
      log,
      worktree,
    );
    const resources = NodePath.join(stagedPath, "resources");
    candidate = {
      tag: release.tag,
      branch,
      revision: git(["rev-parse", "HEAD"], worktree, "Read the tested Git commit"),
      directory: NodePath.relative(releaseDirectory, stagedPath),
      hashes: {
        executable: await sha256(NodePath.join(stagedPath, executableName)),
        serverArchive: await sha256(NodePath.join(resources, "server.asar")),
        desktopArchive: await sha256(NodePath.join(resources, "app.asar")),
      },
      published: false,
    };
    writeJson(marker, candidate);
  }

  const stagedPath = await validateCandidate(
    candidate,
    releaseDirectory,
    release.tag,
    branch,
    configuration.checkout,
  );
  if (!candidate.published) {
    updateStatus("preparing", "Pushing the tested release branch to Benny’s fork.");
    git(
      ["push", "fork", candidate.revision + ":refs/heads/" + branch],
      configuration.checkout,
      "Publish the tested branch to bennychen/t3code",
    );
    writeJson(marker, { ...candidate, published: true });
  }
  updateStatus(
    "ready",
    "The patched Windows build is staged for the live yoko download check.",
    stagedPath,
  );
}

async function main() {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone update worker has no Effect runtime.
  if (NodeOS.platform() !== "win32")
    throw new Error("This updater prepares Windows x64 builds only.");
  parseVersion(values.current);
  const root = absolutePath(values.root, "Update data directory");
  NodeFS.mkdirSync(root, { recursive: true });
  const lock = NodePath.join(root, "prepare.lock");
  if (!acquireLock(lock)) return;
  let latestTag;
  const updateStatus = (state, message, stagedPath) =>
    writeJson(NodePath.join(root, "status.json"), {
      state,
      currentVersion: values.current,
      ...(latestTag === undefined ? {} : { latestTag }),
      ...(message === undefined ? {} : { message }),
      ...(stagedPath === undefined ? {} : { stagedPath }),
    });
  try {
    updateStatus("checking");
    const release = await latestStable();
    latestTag = release.tag;
    if (!isNewer(release.version, values.current)) {
      updateStatus("up-to-date", "No newer stable release is available.");
      return;
    }
    updateStatus("preparing", "Fetching the stable release and applying the custom patches.");
    const configuration = loadConfig();
    await prepareUpdate(root, configuration, release, updateStatus);
  } catch (error) {
    updateStatus("error", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    NodeFS.unlinkSync(lock);
  }
}

await main();
