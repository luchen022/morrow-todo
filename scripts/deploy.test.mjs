import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "./deploy.mjs";

const source = { name: "morrow-todo", d1_databases: [{ binding: "DB" }], triggers: { crons: ["* * * * *"] } };
const options = (body, status = 200) => ({ accountId: "account", token: "secret", request: async () => Response.json(body, { status }) });

test("first deployment does not create a database or run cron", async () => {
  const { config, hasDatabase } = await resolveConfig(source, options({ success: false, errors: [{ code: 10007 }] }, 404));
  assert.equal(hasDatabase, false);
  assert.equal(config.d1_databases, undefined);
  assert.equal(config.triggers, undefined);
  assert.ok(source.d1_databases);
});

test("uses the selected dashboard database and preserves runtime variables", async () => {
  const { config, hasDatabase } = await resolveConfig(source, options({ success: true, result: { bindings: [{ name: "DB", type: "d1", id: "selected-id" }] } }));
  assert.equal(hasDatabase, true);
  assert.equal(config.d1_databases[0].database_id, "selected-id");
  assert.equal(config.keep_vars, true);
  assert.deepEqual(config.triggers, source.triggers);
});

test("permission errors stop deployment rather than detaching DB", async () => {
  await assert.rejects(resolveConfig(source, options({ success: false }, 403)), /Unable to read/);
});

test("a wrong binding type stops deployment", async () => {
  await assert.rejects(resolveConfig(source, options({ success: true, result: { bindings: [{ name: "DB", type: "kv_namespace", id: "wrong" }] } })), /must be a D1/);
});

test("missing credentials stop deployment", async () => {
  await assert.rejects(resolveConfig(source, {}), /requires CLOUDFLARE_ACCOUNT_ID/);
});
