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
    this.open = false;
    this.listeners = {};
    this._value = "";
  }

  // A <select> can only hold a value one of its options offers. Assigning it
  // anything else sets selectedIndex to -1 and reads back as "". Modelling
  // that is the whole point: a plain property would hide the bug where an
  // off-list category is silently blanked when a row is edited.
  get value() {
    return this._value;
  }
  set value(v) {
    if (this.innerHTML.includes("<option")) {
      const allowed = [...this.innerHTML.matchAll(/<option value="([^"]*)"/g)].map(
        (m) => m[1]
      );
      this._value = allowed.includes(v) ? v : "";
      return;
    }
    this._value = v;
  }

  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  async dispatch(type, event = {}) {
    if (!this.listeners[type]) throw new Error(`no ${type} listener on #${this.id}`);
    return this.listeners[type]({ preventDefault() {}, ...event });
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

// Counts selects, so a test can prove a code path did NOT load the table.
let selectCount = 0;
globalThis.__selects = () => selectCount;

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
    selectCount += 1;
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
      // Captured so tests can fire real auth events; a no-op stub would
      // leave the whole handler unexecuted.
      onAuthStateChange(cb) {
        globalThis.__authCb = cb;
      },
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
globalThis.__setQuery({ data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } });
await app.loadAssets();
check("a non-auth query error shows a banner", banner.textContent, "Could not load assets: canceling statement due to statement timeout");

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
globalThis.__setQuery({ data: null, error: { code: "23502", message: 'null value in column "name" violates not-null constraint' } });
const denied = await app.saveAsset({ id: null, asset_tag: "X", name: "" });
check("non-duplicate save failure reports failure", denied, false);
check("non-duplicate save failure shows its own message", banner.textContent, 'Could not save: null value in column "name" violates not-null constraint');

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

// --- Task 5: search and filter ------------------------------------------

const search = document.getElementById("search-input");
const catFilter = document.getElementById("filter-category");
const statusFilter = document.getElementById("filter-status");

globalThis.__setQuery({
  data: [
    { id: "1", asset_tag: "CKP-LT-0001", name: "ThinkPad T14", category: "Laptop", status: "In use", assigned_to: "Somchai", location: "HQ 4F", note: null, updated_at: "2026-10-14T03:00:00Z" },
    { id: "2", asset_tag: "CKP-LT-0002", name: "MacBook Air", category: "Laptop", status: "Spare", assigned_to: "Nattapong", location: "HQ 4F", note: null, updated_at: "2026-10-13T03:00:00Z" },
    { id: "3", asset_tag: "CKP-MN-0001", name: "Dell U2419", category: "Monitor", status: "In use", assigned_to: "Somchai", location: "HQ 5F", note: null, updated_at: "2026-10-12T03:00:00Z" },
    { id: "4", asset_tag: "CKP-PH-0001", name: "iPhone 14", category: "Phone", status: "Retired", assigned_to: null, location: "Store", note: null, updated_at: "2026-10-11T03:00:00Z" },
  ],
  error: null,
});
await app.loadAssets();

// The empty state is itself a <tr>, so it must not be counted as a result.
const shown = () =>
  tbody.innerHTML.includes('class="empty"')
    ? 0
    : (tbody.innerHTML.match(/<tr>/g) || []).length;
const reset = () => {
  search.value = "";
  catFilter.value = "";
  statusFilter.value = "";
  app.applyFilters();
};

check("no filters shows every row", shown(), 4);

search.value = "MN-0001";
app.applyFilters();
check("search matches an asset tag", shown(), 1);

reset();
search.value = "MacBook";
app.applyFilters();
check("search matches a name", shown(), 1);

reset();
search.value = "Somchai";
app.applyFilters();
check("search matches an assigned person", shown(), 2);

reset();
search.value = "thinkpad";
app.applyFilters();
check("search is case-insensitive", shown(), 1);

reset();
search.value = "  ThinkPad  ";
app.applyFilters();
check("search ignores surrounding whitespace", shown(), 1);

reset();
catFilter.value = "Laptop";
app.applyFilters();
check("category filter narrows the list", shown(), 2);

statusFilter.value = "Spare";
app.applyFilters();
check("category and status filters combine", shown(), 1);

reset();
catFilter.value = "Laptop";
search.value = "Somchai";
app.applyFilters();
check("category and search combine", shown(), 1);

reset();
search.value = "Store";
app.applyFilters();
check("search does not match the location column", shown(), 0);

// Review Focus 5: no matches must look deliberate, not like a failed load.
reset();
search.value = "zzzzzz";
app.applyFilters();
check("no matches shows the empty state", tbody.innerHTML.includes("No assets match."), true);

reset();
check("clearing every filter restores the full list", shown(), 4);

// A row whose assigned_to is null must not break the search.
search.value = "iPhone";
app.applyFilters();
check("search works on a row with a null assigned person", shown(), 1);

// --- Review findings: auth handler, event wiring, off-list values -------

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const authCb = globalThis.__authCb;

check("the auth state handler was actually registered", typeof authCb, "function");

// Finding 5: the auth handler had never been executed by any check.
globalThis.__setQuery({ data: [], error: null });
let before = globalThis.__selects();
await authCb("INITIAL_SESSION", { user: { email: "tester@example.com" } });
check("INITIAL_SESSION does not load the table a second time", globalThis.__selects(), before);

before = globalThis.__selects();
await authCb("SIGNED_IN", { user: { email: "tester@example.com" } });
check("SIGNED_IN shows the app view", appView.hidden, false);
check("SIGNED_IN names the signed-in user", document.getElementById("user-email").textContent, "tester@example.com");
check("SIGNED_IN loads the table", globalThis.__selects(), before + 1);

await authCb("SIGNED_OUT", null);
check("SIGNED_OUT shows the login view", loginView.hidden, false);
check("SIGNED_OUT hides the app view", appView.hidden, true);
// Finding 10: the previous user's rows must not linger behind the login form.
check("SIGNED_OUT clears the rendered rows", tbody.innerHTML, "");

before = globalThis.__selects();
await authCb("TOKEN_REFRESHED", { user: { email: "tester@example.com" } });
check("an hourly token refresh does not reload the table", globalThis.__selects(), before);

// Finding 2: an off-list category must survive an edit, not be blanked.
globalThis.__setQuery({
  data: [{ id: "9", asset_tag: "CKP-SV-0001", name: "PowerEdge R650", category: "Server", status: "In use", assigned_to: null, location: "DC", note: null, updated_at: "2026-10-14T03:00:00Z" }],
  error: null,
});
await app.loadAssets();
app.openDialog(app.allAssets[0]);
check("editing keeps a category that is not in the fixed list", document.getElementById("field-category").value, "Server");

globalThis.__setQuery({ data: null, error: null });
await document.getElementById("asset-form").dispatch("submit");
check("saving an off-list category does not erase it", globalThis.__lastWrite().values.category, "Server");

// Finding 5: the submit handler and the row click delegation were unexecuted.
app.openDialog(null);
document.getElementById("field-asset-tag").value = "CKP-LT-0009";
document.getElementById("field-name").value = "New laptop";
globalThis.__setQuery({ data: null, error: null });
await document.getElementById("asset-form").dispatch("submit");
check("a successful submit closes the dialog", dialog.open, false);

app.openDialog(null);
document.getElementById("field-asset-tag").value = "CKP-LT-0001";
document.getElementById("field-name").value = "Duplicate";
globalThis.__setQuery({ data: null, error: { code: "23505", message: "duplicate key" } });
await document.getElementById("asset-form").dispatch("submit");
check("a rejected submit leaves the dialog open", dialog.open, true);
check("a rejected submit keeps the typed tag", document.getElementById("field-asset-tag").value, "CKP-LT-0001");
dialog.close();

globalThis.__setQuery({
  data: [{ id: "9", asset_tag: "CKP-SV-0001", name: "PowerEdge R650", category: "Server", status: "In use", assigned_to: null, location: "DC", note: null, updated_at: "2026-10-14T03:00:00Z" }],
  error: null,
});
await app.loadAssets();
await tbody.dispatch("click", { target: { dataset: { edit: "9" } } });
check("clicking Edit on a row opens the dialog", dialog.open, true);
check("clicking Edit loads that row's tag", document.getElementById("field-asset-tag").value, "CKP-SV-0001");
dialog.close();

globalThis.__setConfirm(true);
globalThis.__setQuery({ data: null, error: null });
await tbody.dispatch("click", { target: { dataset: { delete: "9" } } });
check("clicking Delete on a row issues a delete", globalThis.__lastWrite().op, "delete");

await tbody.dispatch("click", { target: { dataset: {} } });
check("clicking a non-button cell does nothing", globalThis.__lastWrite().op, "delete");

// Finding 3: a dead session that arrives as a thrown error, or as an error
// code rather than a recognisable message, must still reach the login form.
globalThis.__setQuery({ data: [], error: null });
await authCb("SIGNED_IN", { user: { email: "tester@example.com" } });
globalThis.__setQuery(null, Object.assign(new Error("Invalid Refresh Token"), { __auth: true }));
await app.loadAssets();
check("a thrown auth error returns the user to the login form", loginView.hidden, false);

await authCb("SIGNED_IN", { user: { email: "tester@example.com" } });
globalThis.__setQuery({ data: null, error: { code: "PGRST301", message: "no details" } });
await app.loadAssets();
check("PGRST301 is treated as a dead session whatever the message says", loginView.hidden, false);

await authCb("SIGNED_IN", { user: { email: "tester@example.com" } });
globalThis.__setQuery({ data: null, error: { code: "42501", message: "permission denied for table assets" } });
await app.loadAssets();
check("a permission error is treated as a dead session", loginView.hidden, false);

// A genuine network failure must still read as a network failure.
globalThis.__setQuery({ data: [], error: null });
await authCb("SIGNED_IN", { user: { email: "tester@example.com" } });
globalThis.__setQuery(null, new TypeError("Failed to fetch"));
await app.loadAssets();
check("a real network failure still says so", banner.textContent, "Could not reach the database: Failed to fetch");
check("a real network failure leaves the user on the app view", appView.hidden, false);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
