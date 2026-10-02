import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";

// Keep the selected dashboard database out of the repository. Resolve it anew
// before each deployment so changing the dashboard binding takes effect.
export async function resolveConfig(config, { accountId, token, request = fetch }) {
  if (!accountId || !token) {
    throw new Error("Deployment requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the build environment (not Worker runtime secrets).");
  }
  const response = await request(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(config.name)}/settings`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) }
  );
  const body = await response.json();
  // Cloudflare reports a missing Worker as error 10007. Do not treat permission
  // or network failures as an empty binding: that could detach a live database.
  const missingWorker = response.status === 404 && body.errors?.some((item) => item.code === 10007);
  if (!missingWorker && (!response.ok || !body.success)) {
    throw new Error(`Unable to read Worker bindings (HTTP ${response.status}). Check Workers Scripts read/edit permission.`);
  }
  const bindings = missingWorker ? [] : body.result?.bindings;
  if (!Array.isArray(bindings)) throw new Error("Cloudflare returned invalid Worker bindings; deployment stopped.");
  const database = bindings.find((binding) => binding.name === "DB");
  if (database && (database.type !== "d1" || !database.id)) {
    throw new Error("The dashboard DB binding must be a D1 database.");
  }
  const resolved = structuredClone(config);
  delete resolved.d1_databases;
  resolved.keep_vars = true;
  if (database) {
    resolved.d1_databases = [{ binding: "DB", database_name: "dashboard-db", database_id: database.id, migrations_dir: "migrations" }];
  } else {
    // Initial deployment only serves the setup/login screen, until DB is bound.
    delete resolved.triggers;
  }
  return { config: resolved, hasDatabase: Boolean(database) };
}

async function main() {
  const source = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  const { config, hasDatabase } = await resolveConfig(source, {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN
  });
  const configPath = ".wrangler.deploy.json";
  const run = (args) => {
    const result = spawnSync("pnpm", ["exec", "wrangler", ...args, "--config", configPath], { stdio: "inherit", env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Wrangler failed with exit status ${result.status}.`);
  };
  try {
    await writeFile(configPath, JSON.stringify(config, null, 2));
    if (hasDatabase) run(["d1", "migrations", "apply", "DB", "--remote"]);
    else console.log("Setup deployment: add a D1 binding named DB in the Worker dashboard, then retry this build.");
    run(["deploy"]);
  } finally {
    await unlink(configPath).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
