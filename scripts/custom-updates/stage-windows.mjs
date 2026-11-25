import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const flagNames = [
  "repo",
  "version",
  "stock",
  "destination",
  "asar-module",
  "fuses-cli",
  "seven-zip",
];
const { values } = NodeUtil.parseArgs({
  options: Object.fromEntries(flagNames.map((name) => [name, { type: "string" }])),
});
for (const name of flagNames) {
  if (!values[name]) throw new Error("Missing --" + name);
  if (name !== "version" && !NodePath.isAbsolute(values[name])) {
    throw new Error("--" + name + " must be an absolute path");
  }
}
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone staging script has no Effect runtime.
if (NodeOS.platform() !== "win32" || !/^\d+\.\d+\.\d+$/u.test(values.version)) {
  throw new Error("Staging requires Windows and a stable MAJOR.MINOR.PATCH version");
}

const repo = NodeFS.realpathSync(values.repo);
const stock = NodeFS.realpathSync(values.stock);
const destination = NodePath.join(
  NodeFS.realpathSync(NodePath.dirname(values.destination)),
  NodePath.basename(values.destination),
);
function isInside(root, candidate) {
  const relative = NodePath.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(".." + NodePath.sep) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
}
if (
  NodeFS.existsSync(destination) ||
  isInside(stock, destination) ||
  isInside(repo, destination) ||
  (process.env.LOCALAPPDATA &&
    isInside(NodePath.join(process.env.LOCALAPPDATA, "Programs", "t3code"), destination))
) {
  throw new Error(
    "The destination must be a new staging directory outside stock, the repo, and the regular install",
  );
}
const pinnedNode = JSON.parse(NodeFS.readFileSync(NodePath.join(repo, "package.json"), "utf8"))
  .engines?.node;
if (process.versions.node !== pinnedNode) {
  throw new Error("Run staging with Node " + pinnedNode);
}
const asar = await import(NodeURL.pathToFileURL(NodeFS.realpathSync(values["asar-module"])));
const sha256 = (data) => NodeCrypto.createHash("sha256").update(data).digest("hex");
const mainEntry = "apps/desktop/dist-electron/main.cjs";
const rendererPrefix = "apps/server/dist/client/";
const rendererAssets = rendererPrefix + "assets/";
const appExe = NodePath.join(stock, "T3 Code (Beta).exe");
const stockResources = NodePath.join(stock, "resources");
const stockApp = NodePath.join(stockResources, "app.asar");
const stockServer = NodePath.join(stockResources, "server.asar");

function run(executable, args, options, label) {
  const result = NodeChildProcess.spawnSync(executable, args, { windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(
      label + " failed" + (result.error ? " to start" : " (exit " + result.status + ")"),
    );
  }
  return result.stdout;
}

const fuseState = run(
  process.execPath,
  [NodeFS.realpathSync(values["fuses-cli"]), "read", "--app", appExe],
  { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
  "Reading stock Electron fuses",
);
if (!/^\s*EnableEmbeddedAsarIntegrityValidation is Disabled\s*$/mu.test(fuseState)) {
  throw new Error(
    "Stock Electron ASAR integrity is enabled or could not be verified. The archive overlay is unsupported.",
  );
}

function verifyOfficialSignatures(files) {
  if (!files.length) return;
  const signatureScript =
    "foreach ($file in ($env:T3CODE_STAGE_SIGNATURE_FILES | ConvertFrom-Json)) { " +
    "$signature = Get-AuthenticodeSignature -LiteralPath $file; " +
    "if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\\s*)CN=T3 Tools Inc(,|$)') { exit 1 } }";
  const signatureEnvironment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"),
    ),
    T3CODE_STAGE_SIGNATURE_FILES: JSON.stringify(files),
  };
  run(
    NodePath.join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    ["-NoProfile", "-NonInteractive", "-Command", signatureScript],
    { env: signatureEnvironment },
    "Verifying the official Windows binary signatures",
  );
}
verifyOfficialSignatures([appExe]);

function verifyBundledWsl() {
  const archive = NodePath.join(stockResources, "wsl-runtime.tar.gz");
  const checksum = archive + ".sha256";
  if (!NodeFS.existsSync(archive) && !NodeFS.existsSync(checksum)) return;
  const expected = NodeFS.readFileSync(checksum, "utf8").trim();
  if (
    !/^[a-f0-9]{64}$/iu.test(expected) ||
    sha256(NodeFS.readFileSync(archive)) !== expected.toLowerCase()
  ) {
    throw new Error("The bundled WSL runtime failed its stock SHA-256 check");
  }
  run(
    NodeFS.realpathSync(values["seven-zip"]),
    ["t", archive],
    {},
    "Checking the stock WSL runtime archive",
  );
}
verifyBundledWsl();

function archiveFiles(archive) {
  const files = new Map();
  function visit(parent, prefix) {
    for (const [name, entry] of Object.entries(parent.files ?? {})) {
      if (name === "." || name === ".." || /[<>:"/\\|?*\x00-\x1F]/u.test(name) || entry.link) {
        throw new Error("Unsupported stock ASAR entry " + prefix + name);
      }
      if (entry.files) visit(entry, prefix + name + "/");
      else files.set(prefix + name, entry);
    }
  }
  visit(asar.getRawHeader(archive).header, "");
  return files;
}

function readEntry(archive, name) {
  return asar.extractFile(archive, name.replaceAll("/", NodePath.sep));
}

function verifyEntry(archive, name, entry, signaturesToVerify) {
  const content = readEntry(archive, name);
  if (
    content.length !== entry.size ||
    (entry.integrity &&
      (entry.integrity.algorithm !== "SHA256" || entry.integrity.hash !== sha256(content)))
  ) {
    // Electron Builder may sign unpacked PE binaries after creating the stock archive.
    if (
      signaturesToVerify &&
      entry.unpacked === true &&
      content.length > entry.size &&
      content.subarray(0, 2).equals(Buffer.from("MZ")) &&
      /\.(node|dll|exe)$/iu.test(name)
    ) {
      signaturesToVerify.push(NodePath.join(archive + ".unpacked", ...name.split("/")));
    } else {
      throw new Error("ASAR entry integrity mismatch: " + name);
    }
  }
  return content;
}

const stockAppFiles = archiveFiles(stockApp);
const stockServerFiles = archiveFiles(stockServer);
const stockMetadata = JSON.parse(
  verifyEntry(stockApp, "package.json", stockAppFiles.get("package.json")),
);
if (
  stockMetadata.version !== values.version ||
  stockMetadata.main !== "apps/desktop/dist-electron/boot.cjs"
) {
  throw new Error(
    "The stock executable's app archive does not match the requested release and layout",
  );
}

function uniqueAsset(read, filenames, pattern) {
  const matches = filenames.filter((name) => pattern.test(name));
  if (matches.length !== 1) throw new Error("Expected one desktop asset matching " + pattern);
  return read(matches[0]).toString("utf8");
}

function rendererConfig(read, filenames) {
  const publicConfig = uniqueAsset(read, filenames, /^publicConfig-[\w-]+\.js$/u);
  const main = uniqueAsset(read, filenames, /^main-[\w-]+\.js$/u);
  function capture(source, expression, name) {
    const value = source.match(expression)?.groups?.value;
    if (!value) throw new Error("Could not verify the release renderer configuration for " + name);
    return value;
  }
  const valueFor = (name) =>
    capture(
      publicConfig,
      new RegExp("\\b" + name + ":[$\\w]+\\(\\x60(?<value>[^\\x60]+)\\x60\\)", "u"),
      name,
    );
  const config = {
    VITE_CLERK_PUBLISHABLE_KEY: valueFor("clerkPublishableKey"),
    VITE_CLERK_JWT_TEMPLATE: valueFor("clerkJwtTemplate"),
    VITE_T3CODE_RELAY_URL: valueFor("relayUrl"),
    VITE_CLERK_CLI_OAUTH_CLIENT_ID: capture(
      main,
      /function (?<name>[$\w]+)\(\)\{return [$\w]+\(\x60(?<value>[^\x60]+)\x60\)\}function [$\w]+\(\)\{return!!\([$\w]+\(\)\.clerkPublishableKey&&\k<name>\(\)\)\}/u,
      "Clerk CLI OAuth client ID",
    ),
    VITE_RELAY_OTLP_TRACES_URL: valueFor("tracesUrl"),
    VITE_RELAY_OTLP_TRACES_DATASET: valueFor("tracesDataset"),
    VITE_RELAY_OTLP_TRACES_TOKEN: valueFor("tracesToken"),
  };
  if (
    !/^pk_live_[A-Za-z0-9+/_=-]+$/u.test(config.VITE_CLERK_PUBLISHABLE_KEY) ||
    new URL(config.VITE_T3CODE_RELAY_URL).protocol !== "https:" ||
    new URL(config.VITE_RELAY_OTLP_TRACES_URL).protocol !== "https:"
  ) {
    throw new Error("Release renderer configuration failed format checks");
  }
  return config;
}

const originalConfig = rendererConfig(
  (name) =>
    verifyEntry(stockServer, rendererAssets + name, stockServerFiles.get(rendererAssets + name)),
  [...stockServerFiles.keys()]
    .filter((name) => name.startsWith(rendererAssets))
    .map((name) => name.slice(rendererAssets.length)),
);
const originalMain = verifyEntry(stockApp, mainEntry, stockAppFiles.get(mainEntry));
const environment = {
  ...process.env,
  ...originalConfig,
  APP_VERSION: values.version,
  T3CODE_WEB_SOURCEMAP: "false",
  T3CODE_DESKTOP_UPDATE_REPOSITORY: "bennychen/t3code",
};
for (const name of [
  "VITE_DEV_SERVER_URL",
  "VITE_HTTP_URL",
  "VITE_WS_URL",
  "VITE_HOSTED_APP_URL",
  "VITE_HOSTED_APP_CHANNEL",
  "VITE_RELEASE_CHANNEL",
  "T3CODE_BUILT_DEV",
  "T3CODE_BUNDLED_DEV",
  "T3CODE_DESKTOP_DEV",
  "T3CODE_CLERK_JWT_TEMPLATE",
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  "T3CODE_RELAY_URL",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
]) {
  delete environment[name];
}
environment.T3CODE_CLERK_PUBLISHABLE_KEY = originalConfig.VITE_CLERK_PUBLISHABLE_KEY;
if (!originalMain.toString("utf8").includes(environment.T3CODE_CLERK_PUBLISHABLE_KEY)) {
  throw new Error("Stock native and renderer Clerk configuration differ");
}

const tempParent = NodeFS.realpathSync(NodeOS.tmpdir());
const stage = NodeFS.mkdtempSync(NodePath.join(tempParent, "t3code-update-"));
const renderer = NodePath.join(stage, "renderer");
const native = NodePath.join(stage, "native");
const vp = NodePath.join(repo, "node_modules", "vite-plus", "bin", "vp");
const logFile = NodePath.join(stage, "build.log");
console.log("Building Windows update artifacts for " + values.version);

function build() {
  const web = NodePath.join(repo, "apps", "web");
  const desktop = NodePath.join(repo, "apps", "desktop");
  const log = NodeFS.openSync(logFile, "wx");
  try {
    for (const [cwd, args, label] of [
      [web, [vp, "build", "--outDir", renderer], "Building the renderer"],
      [desktop, ["scripts/build-preview-annotation-css.mjs"], "Generating preview CSS"],
      [desktop, [vp, "pack", "--out-dir", native], "Building the Electron main bundle"],
    ]) {
      run(process.execPath, args, { cwd, env: environment, stdio: ["ignore", log, log] }, label);
    }
  } finally {
    NodeFS.closeSync(log);
  }
  const compiledMain = NodePath.join(native, "main.cjs");
  run(
    process.execPath,
    ["--check", compiledMain],
    {},
    "Checking the compiled Electron main bundle",
  );
  const bytes = NodeFS.readFileSync(compiledMain);
  if (!bytes.toString("utf8").includes(environment.T3CODE_CLERK_PUBLISHABLE_KEY)) {
    throw new Error("The rebuilt Electron main bundle lost the release Clerk configuration");
  }
  const assetsDir = NodePath.join(renderer, "assets");
  const builtConfig = rendererConfig(
    (name) => NodeFS.readFileSync(NodePath.join(assetsDir, name)),
    NodeFS.readdirSync(assetsDir),
  );
  for (const key of Object.keys(originalConfig)) {
    if (builtConfig[key] !== originalConfig[key]) {
      throw new Error("The rebuilt renderer changed the release configuration for " + key);
    }
  }
  NodeFS.statSync(NodePath.join(renderer, "index.html"));
  return bytes;
}

function rendererFiles() {
  const files = new Map();
  for (const entry of NodeFS.readdirSync(renderer, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) throw new Error("The renderer build contains a non-file entry");
    const file = NodePath.join(entry.parentPath, entry.name);
    const relative = NodePath.relative(renderer, file).split(NodePath.sep).join("/");
    files.set(rendererPrefix + relative, NodeFS.readFileSync(file));
  }
  return files;
}

async function overlay(arc, stockFiles, replacementFiles, replaces, archiveName) {
  const source = NodePath.join(stage, archiveName + "-tree");
  const output = NodePath.join(stage, archiveName);
  const expected = new Map();
  const signaturesToVerify = [];
  function write(name, bytes, unpacked) {
    const file = NodePath.join(source, ...name.split("/"));
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, bytes);
    expected.set(name, { sha256: sha256(bytes), unpacked });
  }
  for (const [name, entry] of stockFiles) {
    const bytes = verifyEntry(arc, name, entry, signaturesToVerify);
    if (replaces(name)) {
      if (entry.unpacked) throw new Error("Refusing to replace an unpacked file: " + name);
    } else {
      write(name, bytes, entry.unpacked === true);
    }
  }
  verifyOfficialSignatures(signaturesToVerify);
  for (const [name, bytes] of replacementFiles) write(name, bytes, false);
  const unpacked = [...expected].filter(([, entry]) => entry.unpacked).map(([name]) => name);
  if (!unpacked.length || unpacked.some((name) => /[\\*?[\]{}(),]/u.test(name))) {
    throw new Error("Unsafe or missing native unpack manifest in " + archiveName);
  }
  await asar.createPackageWithOptions(source, output, {
    dot: true,
    unpack: "{" + unpacked.map((name) => "**/" + name).join(",") + "}",
  });
  verifyOverlay(output, expected);
  return { output, expected };
}

function verifyOverlay(archive, expected) {
  const actual = archiveFiles(archive);
  if (actual.size !== expected.size) throw new Error("Unexpected ASAR entry count in " + archive);
  for (const [name, entry] of actual) {
    const match = expected.get(name);
    if (
      !match ||
      match.unpacked !== (entry.unpacked === true) ||
      match.sha256 !== sha256(verifyEntry(archive, name, entry))
    ) {
      throw new Error("Archive byte or unpack integrity mismatch: " + name);
    }
  }
}

try {
  const app = await overlay(
    stockApp,
    stockAppFiles,
    new Map([[mainEntry, build()]]),
    (name) => name === mainEntry,
    "app.asar",
  );
  const server = await overlay(
    stockServer,
    stockServerFiles,
    rendererFiles(),
    (name) => name.startsWith(rendererPrefix),
    "server.asar",
  );
  const stockArchives = new Set([
    stockApp,
    stockServer,
    NodePath.join(stockResources, "app-update.yml"),
  ]);
  NodeFS.mkdirSync(destination);
  for (const name of NodeFS.readdirSync(stock)) {
    NodeFS.cpSync(NodePath.join(stock, name), NodePath.join(destination, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (filename) => !stockArchives.has(filename),
    });
  }
  const appArchive = NodePath.join(destination, "resources", "app.asar");
  const serverArchive = NodePath.join(destination, "resources", "server.asar");
  NodeFS.copyFileSync(app.output, appArchive, NodeFS.constants.COPYFILE_EXCL);
  NodeFS.copyFileSync(server.output, serverArchive, NodeFS.constants.COPYFILE_EXCL);
  // Check against the copied stock native files, not the scratch packer's sidecars.
  verifyOverlay(appArchive, app.expected);
  verifyOverlay(serverArchive, server.expected);
  const exeSha256 = sha256(
    NodeFS.readFileSync(NodePath.join(destination, NodePath.basename(appExe))),
  );
  if (exeSha256 !== sha256(NodeFS.readFileSync(appExe)))
    throw new Error("The packaged executable changed");
  NodeFS.writeFileSync(
    NodePath.join(destination, "verified.json"),
    JSON.stringify(
      {
        version: values.version,
        exeSha256,
        appAsarSha256: sha256(NodeFS.readFileSync(appArchive)),
        serverAsarSha256: sha256(NodeFS.readFileSync(serverArchive)),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  if (NodePath.dirname(NodeFS.realpathSync(stage)) === tempParent) {
    NodeFS.rmSync(stage, { recursive: true, force: true });
  }
  console.log("Verified staged Windows app at " + destination);
} catch (error) {
  console.error("Staging diagnostics: " + stage);
  throw error;
}
