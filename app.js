import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CATEGORIES = ["Laptop", "Desktop", "Monitor", "Phone", "Network", "Other"];
const STATUSES = ["In use", "Spare", "Repair", "Retired"];

const el = (id) => document.getElementById(id);

// --- Banner -------------------------------------------------------------

function showBanner(message, kind = "error") {
  const banner = el("banner");
  banner.textContent = message;
  banner.className = `banner ${kind}`;
  banner.hidden = false;
}

function clearBanner() {
  el("banner").hidden = true;
}

el("banner").addEventListener("click", clearBanner);

// --- Views --------------------------------------------------------------

function showView(name) {
  el("login-view").hidden = name !== "login";
  el("app-view").hidden = name !== "app";
}

// --- Escaping -----------------------------------------------------------

// Asset text is user-supplied and goes into innerHTML, so it must be escaped.
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// --- Auth ---------------------------------------------------------------

el("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearBanner();
  const { error } = await supabase.auth.signInWithPassword({
    email: el("login-email").value.trim(),
    password: el("login-password").value,
  });
  if (error) {
    showBanner(error.message);
    return;
  }
  el("login-password").value = "";
});

el("logout-button").addEventListener("click", async () => {
  const { error } = await supabase.auth.signOut();
  if (error) showBanner(error.message);
});

// A dead session must land the user on the login form, not an empty table or
// a raw Postgres string.
//
// Codes and HTTP status are checked before the message, because PostgREST
// does not promise its wording is stable. PGRST301/302 are its own
// JWT-rejected codes; 42501 is Postgres "permission denied", which is what an
// RLS policy returns once auth.uid() is null. The message test stays as a
// fallback for GoTrue errors, which carry no code.
const AUTH_ERROR_CODES = new Set(["PGRST301", "PGRST302", "42501"]);

function isAuthFailure(error) {
  if (!error) return false;
  if (AUTH_ERROR_CODES.has(error.code)) return true;
  if (error.status === 401 || error.status === 403) return true;
  return /jwt|session|token|not authenticated|authentication/i.test(error.message ?? "");
}

// Returns false when the caller should stop: the session is gone and the user
// is already back on the login form.
function requireSession(error) {
  if (!isAuthFailure(error)) return true;
  signedOut();
  showBanner("Session expired. Please sign in again.");
  return false;
}

// 42501 is ambiguous on its own. Reading assets is allowed for anyone signed
// in, so a denied select means the session is gone. Writing is allowed only
// for admins, so a denied write means the role is wrong — and signing a
// viewer out for being a viewer would be both wrong and baffling. The write
// paths therefore test this before requireSession.
function isWriteDenied(error) {
  if (!error) return false;
  if (error.code === "42501") return true;
  return /row-level security|permission denied/i.test(error.message ?? "");
}

const READ_ONLY_MESSAGE =
  "You have read-only access. Ask an admin to make this change.";

// An RLS `using` clause that excludes the row is not an error: the statement
// matches nothing and PostgREST returns an empty array. Reporting success
// there would tell a viewer their edit was saved when nothing happened.
const NOTHING_CHANGED_MESSAGE =
  "Nothing changed. The asset may have been deleted, or you may not have permission.";

function touchedNoRow(data) {
  return Array.isArray(data) && data.length === 0;
}

// Everything that must be true when no one is signed in. Clearing the rows is
// part of it: otherwise the previous user's inventory sits in memory and in
// the DOM, and flashes on screen before the next user's data arrives.
function signedOut() {
  allAssets = [];
  isAdmin = false;
  el("asset-tbody").innerHTML = "";
  el("user-email").textContent = "";
  el("user-role").textContent = "";
  showView("login");
}

// --- Roles --------------------------------------------------------------
//
// Every signed-in user reads the whole inventory; only admins write. The
// flag below drives the buttons, and the RLS policies enforce the same rule
// in the database — hiding a button stops a mistake, not an attacker.
let isAdmin = false;

// Fails closed. A profile row that is missing, unreadable, or malformed
// leaves the user read-only rather than handing out write access on an
// error path.
async function loadRole() {
  try {
    const { data, error } = await supabase.from("profiles").select("role");
    isAdmin = !error && data?.[0]?.role === "admin";
  } catch {
    isAdmin = false;
  }
  el("user-role").textContent = isAdmin ? "admin" : "read-only";
  el("add-button").hidden = !isAdmin;
}

supabase.auth.onAuthStateChange((event, session) => {
  // INITIAL_SESSION fires once when the client finishes restoring a stored
  // session. The bootstrap at the end of this file already covers that case,
  // so handling it here too would load the table twice on every page load.
  if (event === "INITIAL_SESSION") return;
  if (!session) {
    signedOut();
    return;
  }
  el("user-email").textContent = session.user.email;
  showView("app");
  // TOKEN_REFRESHED fires roughly hourly on a session that never changed.
  // Reloading there would redraw the table underneath an open edit dialog.
  // The role is re-read on sign-in only, for the same reason.
  //
  // Deliberately not awaited. supabase-js runs this callback while it holds
  // its auth lock, and a query awaited here would wait for a lock the
  // callback itself is holding. Kicking the work off and returning lets the
  // lock go. `pendingSignIn` exists so a test can wait for that work.
  if (event === "SIGNED_IN") {
    pendingSignIn = loadRole().then(loadAssets);
  }
});

let pendingSignIn = Promise.resolve();

// --- Data ---------------------------------------------------------------

let allAssets = [];

async function loadAssets() {
  clearBanner();
  let result;
  try {
    result = await supabase
      .from("assets")
      .select("*")
      .order("updated_at", { ascending: false });
  } catch (networkError) {
    // fetch rejects outright when the network is down; there is no error field.
    // supabase-js throws, rather than returning an error, when a token
    // refresh fails — so a dead session often arrives here, not below.
    if (!requireSession(networkError)) return;
    showBanner(`Could not reach the database: ${networkError.message}`);
    return;
  }
  const { data, error } = result;
  if (error) {
    if (!requireSession(error)) return;
    showBanner(`Could not load assets: ${error.message}`);
    return;
  }
  allAssets = data ?? [];
  applyFilters();
}

// --- Rendering ----------------------------------------------------------

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function renderAssets(rows) {
  const tbody = el("asset-tbody");
  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td class="empty" colspan="9">No assets match.</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.asset_tag)}</td>
        <td>${escapeHtml(row.name)}</td>
        <td>${escapeHtml(row.category)}</td>
        <td>${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.assigned_to)}</td>
        <td>${escapeHtml(row.location)}</td>
        <td>${escapeHtml(row.note)}</td>
        <td>${escapeHtml(formatDate(row.updated_at))}</td>
        <td class="row-actions">${
          isAdmin
            ? `<button type="button" data-edit="${escapeHtml(row.id)}">Edit</button>
          <button type="button" data-delete="${escapeHtml(row.id)}">Delete</button>`
            : ""
        }</td>
      </tr>`
    )
    .join("");
}

// --- Search and filter --------------------------------------------------

// Filters the rows already in memory. Fine up to a few thousand assets;
// past that, move this to a server-side ilike query in loadAssets.
function applyFilters() {
  const term = el("search-input").value.trim().toLowerCase();
  const category = el("filter-category").value;
  const status = el("filter-status").value;

  const rows = allAssets.filter((asset) => {
    if (category && asset.category !== category) return false;
    if (status && asset.status !== status) return false;
    if (!term) return true;
    const haystack = [asset.asset_tag, asset.name, asset.assigned_to]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(term);
  });

  renderAssets(rows);
}

el("search-input").addEventListener("input", applyFilters);
el("filter-category").addEventListener("change", applyFilters);
el("filter-status").addEventListener("change", applyFilters);

// --- Dropdowns ----------------------------------------------------------

function populateSelect(select, values, blankLabel, extraValue = null) {
  // extraValue keeps a value the database already holds but this list does
  // not offer. Without it, assigning an off-list value to a <select> sets
  // selectedIndex to -1, the field reads back as "", and saving would quietly
  // erase a category or status that came from an import or an older list.
  const all =
    extraValue && !values.includes(extraValue) ? [...values, extraValue] : values;
  select.innerHTML =
    `<option value="">${escapeHtml(blankLabel)}</option>` +
    all
      .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
      .join("");
}

populateSelect(el("filter-category"), CATEGORIES, "All categories");
populateSelect(el("filter-status"), STATUSES, "All statuses");
populateSelect(el("field-category"), CATEGORIES, "—");
populateSelect(el("field-status"), STATUSES, "—");

// --- Add / edit dialog --------------------------------------------------

function openDialog(asset) {
  el("dialog-title").textContent = asset ? "Edit asset" : "Add asset";
  // Rebuild both dropdowns first, carrying this row's own value in case it
  // predates the current list. Saving must never silently drop a field the
  // user did not touch.
  populateSelect(el("field-category"), CATEGORIES, "—", asset?.category ?? null);
  populateSelect(el("field-status"), STATUSES, "—", asset?.status ?? null);
  el("field-id").value = asset?.id ?? "";
  el("field-asset-tag").value = asset?.asset_tag ?? "";
  el("field-name").value = asset?.name ?? "";
  el("field-category").value = asset?.category ?? "";
  el("field-status").value = asset?.status ?? "";
  el("field-assigned-to").value = asset?.assigned_to ?? "";
  el("field-location").value = asset?.location ?? "";
  el("field-note").value = asset?.note ?? "";
  el("asset-dialog").showModal();
}

el("add-button").addEventListener("click", () => openDialog(null));
el("dialog-cancel").addEventListener("click", () => el("asset-dialog").close());

// --- Writes -------------------------------------------------------------

const orNull = (value) => (value.trim() === "" ? null : value.trim());

async function saveAsset(fields) {
  const { id, ...values } = fields;
  // .select() so the response names the rows actually written. An update a
  // policy excludes writes nothing and reports no error.
  const query = id
    ? supabase.from("assets").update(values).eq("id", id).select()
    : supabase.from("assets").insert(values).select();

  let result;
  try {
    result = await query;
  } catch (networkError) {
    // supabase-js throws, rather than returning an error, when a token
    // refresh fails — so a dead session often arrives here, not below.
    if (!requireSession(networkError)) return false;
    showBanner(`Could not reach the database: ${networkError.message}`);
    return false;
  }
  const { data, error } = result;
  if (error) {
    if (isWriteDenied(error)) {
      showBanner(READ_ONLY_MESSAGE);
      return false;
    }
    if (!requireSession(error)) return false;
    // 23505 is the Postgres unique-violation code; assets has one unique column.
    if (error.code === "23505") {
      showBanner(`Asset tag "${values.asset_tag}" already exists.`);
    } else {
      showBanner(`Could not save: ${error.message}`);
    }
    return false;
  }
  if (touchedNoRow(data)) {
    showBanner(NOTHING_CHANGED_MESSAGE);
    return false;
  }
  return true;
}

el("asset-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearBanner();
  const fields = {
    id: el("field-id").value || null,
    asset_tag: el("field-asset-tag").value.trim(),
    name: el("field-name").value.trim(),
    category: orNull(el("field-category").value),
    status: orNull(el("field-status").value),
    assigned_to: orNull(el("field-assigned-to").value),
    location: orNull(el("field-location").value),
    note: orNull(el("field-note").value),
  };
  const saved = await saveAsset(fields);
  if (!saved) return;
  el("asset-dialog").close();
  await loadAssets();
});

async function deleteAsset(id, label) {
  if (!window.confirm(`Delete asset "${label}"? This cannot be undone.`)) return;
  clearBanner();
  let result;
  try {
    result = await supabase.from("assets").delete().eq("id", id).select();
  } catch (networkError) {
    // supabase-js throws, rather than returning an error, when a token
    // refresh fails — so a dead session often arrives here, not below.
    if (!requireSession(networkError)) return;
    showBanner(`Could not reach the database: ${networkError.message}`);
    return;
  }
  const { data, error } = result;
  if (error) {
    if (isWriteDenied(error)) {
      showBanner(READ_ONLY_MESSAGE);
      return;
    }
    if (!requireSession(error)) return;
    showBanner(`Could not delete: ${error.message}`);
    return;
  }
  if (touchedNoRow(data)) {
    showBanner(NOTHING_CHANGED_MESSAGE);
    return;
  }
  await loadAssets();
}

// One listener on the tbody — rows are re-rendered constantly.
el("asset-tbody").addEventListener("click", (event) => {
  const editId = event.target.dataset.edit;
  const deleteId = event.target.dataset.delete;
  if (editId) {
    const asset = allAssets.find((a) => a.id === editId);
    if (asset) openDialog(asset);
  } else if (deleteId) {
    const asset = allAssets.find((a) => a.id === deleteId);
    if (asset) deleteAsset(asset.id, asset.asset_tag);
  }
});

// --- Bootstrap ----------------------------------------------------------
//
// Must stay last: it runs loadAssets, which reads `allAssets`, and a `let`
// binding is unreachable until its own declaration has executed.

const { data: { session: initialSession } } = await supabase.auth.getSession();
if (initialSession) {
  el("user-email").textContent = initialSession.user.email;
  showView("app");
  await loadRole();
  await loadAssets();
} else {
  showView("login");
}
