// Loads the real app.js top to bottom with stubbed DOM and Supabase, so the
// module's own statement order and pure logic are exercised, not a copy.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

const APP = process.argv[2] ?? fileURLToPath(new URL("../app.js", import.meta.url));
const OUT = process.argv[3] ?? fileURLToPath(new URL("./.app.instrumented.mjs", import.meta.url));

let src = readFileSync(APP, "utf8");

// Replace only the two import lines; everything else is the shipped source.
src = src.replace(
  /^import \{ createClient \}.*$/m,
  "const { createClient } = globalThis.__stubs;"
);
src = src.replace(
  /^import \{ SUPABASE_URL, SUPABASE_ANON_KEY \}.*$/m,
  "const SUPABASE_URL = 'stub', SUPABASE_ANON_KEY = 'stub';"
);
// Expose the internals the harness drives. Appended after the real body, so
// anything reachable here was also reachable to the real code.
src += "\nglobalThis.__app = { loadAssets, renderAssets, escapeHtml, applyFilters, showBanner, saveAsset, deleteAsset, openDialog, get allAssets() { return allAssets; } };\n";

writeFileSync(OUT, src);

// --- Stubs --------------------------------------------------------------

class FakeEl {
  constructor(id) {
    this.id = id;
    this.innerHTML = "";
    this.textContent = "";
    this.className = "";
    this.hidden = true;
    this.value = "";
    this.open = false;
    this.listeners = {};
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}

let confirmAnswer = true;
globalThis.__setConfirm = (answer) => {
  confirmAnswer = answer;
};
globalThis.window = {
  confirm: () => confirmAnswer,
};

const els = new Map();
globalThis.document = {
  getElementById(id) {
    if (!els.has(id)) els.set(id, new FakeEl(id));
    return els.get(id);
  },
};
globalThis.__els = els;

let queryResult = { data: [], error: null };
let queryThrows = null;
globalThis.__setQuery = (result, throws = null) => {
  queryResult = result;
  queryThrows = throws;
};

// Records what the last write sent, so tests can assert on the payload.
let lastWrite = null;
globalThis.__lastWrite = () => lastWrite;

function settle() {
  if (queryThrows) return Promise.reject(queryThrows);
  return Promise.resolve(queryResult);
}

const builder = {
  select() {
    return this;
  },
  order() {
    return settle();
  },
  // insert/update/delete are awaited directly, so each returns a thenable
  // that also carries .eq() for the chained forms.
  insert(values) {
    lastWrite = { op: "insert", values };
    return makeThenable();
  },
  update(values) {
    lastWrite = { op: "update", values };
    return makeThenable();
  },
  delete() {
    lastWrite = { op: "delete" };
    return makeThenable();
  },
};

function makeThenable() {
  const t = {
    eq(column, value) {
      if (lastWrite) lastWrite.eq = { column, value };
      return t;
    },
    then(resolve, reject) {
      return settle().then(resolve, reject);
    },
  };
  return t;
}

globalThis.__stubs = {
  createClient: () => ({
    auth: {
      onAuthStateChange() {},
      // A restored session, so the bootstrap actually runs loadAssets — that
      // is the path where a mis-ordered `let allAssets` throws.
      getSession: async () => ({
        data: { session: { user: { email: "tester@example.com" } } },
      }),
      signInWithPassword: async () => ({ error: null }),
      signOut: async () => ({ error: null }),
    },
    from: () => builder,
  }),
};

await import(pathToFileURL(OUT).href);

// --- Checks -------------------------------------------------------------

const app = globalThis.__app;
const tbody = document.getElementById("asset-tbody");
const banner = document.getElementById("banner");
let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}\n      expected: ${expected}\n      actual:   ${actual}`);
  }
}

// 1. The module loaded at all — this is the TDZ check. If `allAssets` were
//    declared after the bootstrap that reads it, the import above would have
//    thrown "Cannot access 'allAssets' before initialization".
check("module evaluates without a temporal-dead-zone error", typeof app.loadAssets, "function");

// 2. Review Focus 4: HTML in a text field renders as text, never as markup.
const hostile = '<img src=x onerror="alert(1)">';
check(
  "escapeHtml neutralises angle brackets and quotes",
  app.escapeHtml(hostile),
  "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"
);
app.renderAssets([{ id: "1", asset_tag: "A", name: hostile, updated_at: null }]);
check("rendered row contains no live img tag", tbody.innerHTML.includes("<img"), false);
check("rendered row contains the escaped text", tbody.innerHTML.includes("&lt;img"), true);

// 3. Review Focus 5: an empty result set shows an explicit empty state.
app.renderAssets([]);
check("empty result renders the empty-state row", tbody.innerHTML.includes("No assets match."), true);

// 4. Review Focus 3: a rejected fetch is caught and surfaced, not thrown.
globalThis.__setQuery(null, new Error("Failed to fetch"));
await app.loadAssets();
check("network failure shows a banner", banner.hidden, false);
check("network failure banner names the cause", banner.textContent, "Could not reach the database: Failed to fetch");

// 5. A Supabase-reported error surfaces too.
globalThis.__setQuery({ data: null, error: { message: "permission denied", code: "42501" } });
await app.loadAssets();
check("query error shows a banner", banner.textContent, "Could not load assets: permission denied");

// 6. Review Focus 2: a dead session returns the user to the login form.
globalThis.__setQuery({ data: null, error: { message: "JWT expired" } });
await app.loadAssets();
check("expired session shows the login view", document.getElementById("login-view").hidden, false);
check("expired session hides the app view", document.getElementById("app-view").hidden, true);
check("expired session explains itself", banner.textContent, "Session expired. Please sign in again.");

// 7. The happy path loads rows into memory and renders them.
globalThis.__setQuery({
  data: [
    { id: "1", asset_tag: "CKP-LT-0001", name: "ThinkPad T14", category: "Laptop", status: "In use", assigned_to: "Somchai", location: "HQ 4F", note: null, updated_at: "2026-10-14T03:00:00Z" },
  ],
  error: null,
});
await app.loadAssets();
check("successful load stores the rows", app.allAssets.length, 1);
check("successful load renders the asset tag", tbody.innerHTML.includes("CKP-LT-0001"), true);
check("successful load clears any previous banner", banner.hidden, true);
check("a null field renders as empty, not the string null", tbody.innerHTML.includes("null"), false);

// --- Task 4: writes -----------------------------------------------------

const dialog = document.getElementById("asset-dialog");

// 8. Review Focus 1: a duplicate asset tag gets a readable message, and the
//    dialog is left open so the entered values can be corrected.
dialog.showModal();
globalThis.__setQuery({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "assets_asset_tag_key"' } });
const dupSaved = await app.saveAsset({ id: null, asset_tag: "CKP-LT-0001", name: "Another" });
check("duplicate tag save reports failure", dupSaved, false);
check("duplicate tag message is readable", banner.textContent, 'Asset tag "CKP-LT-0001" already exists.');
check("duplicate tag message hides the constraint name", banner.textContent.includes("assets_asset_tag_key"), false);
check("dialog stays open after a failed save", dialog.open, true);

// 9. An insert sends no id column; an update targets one row by id.
globalThis.__setQuery({ data: null, error: null });
await app.saveAsset({ id: null, asset_tag: "CKP-LT-0002", name: "Dell U2419", category: null });
check("new asset uses insert", globalThis.__lastWrite().op, "insert");
check("insert payload carries no id", "id" in globalThis.__lastWrite().values, false);

await app.saveAsset({ id: "abc", asset_tag: "CKP-LT-0002", name: "Dell U2419" });
check("existing asset uses update", globalThis.__lastWrite().op, "update");
check("update targets the row by id", globalThis.__lastWrite().eq.value, "abc");

// 10. A save that fails for another reason says so without the 23505 wording.
globalThis.__setQuery({ data: null, error: { code: "42501", message: "permission denied" } });
const denied = await app.saveAsset({ id: null, asset_tag: "X", name: "Y" });
check("non-duplicate save failure reports failure", denied, false);
check("non-duplicate save failure shows its own message", banner.textContent, "Could not save: permission denied");

// 11. Delete asks first: answering no must not issue a delete.
globalThis.__setQuery({ data: null, error: null });
await app.saveAsset({ id: null, asset_tag: "marker", name: "marker" });
globalThis.__setConfirm(false);
await app.deleteAsset("abc", "CKP-LT-0001");
check("declining the confirm issues no delete", globalThis.__lastWrite().op, "insert");

globalThis.__setConfirm(true);
await app.deleteAsset("abc", "CKP-LT-0001");
check("accepting the confirm issues a delete", globalThis.__lastWrite().op, "delete");
check("delete targets the row by id", globalThis.__lastWrite().eq.value, "abc");

// 12. Editing pre-fills the dialog from the row.
app.openDialog({ id: "7", asset_tag: "CKP-MN-0003", name: "Dell U2419", category: "Monitor", status: "Spare", assigned_to: null, location: "Store", note: null });
check("edit dialog is titled Edit asset", document.getElementById("dialog-title").textContent, "Edit asset");
check("edit dialog pre-fills the tag", document.getElementById("field-asset-tag").value, "CKP-MN-0003");
check("edit dialog pre-fills the category", document.getElementById("field-category").value, "Monitor");
check("edit dialog leaves a null field blank", document.getElementById("field-assigned-to").value, "");

app.openDialog(null);
check("add dialog is titled Add asset", document.getElementById("dialog-title").textContent, "Add asset");
check("add dialog clears the tag", document.getElementById("field-asset-tag").value, "");

// 13. Both dropdowns offer exactly the spec's values.
check("category filter lists the six categories", (document.getElementById("filter-category").innerHTML.match(/<option/g) || []).length, 7);
check("status filter lists the four statuses", (document.getElementById("filter-status").innerHTML.match(/<option/g) || []).length, 5);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
