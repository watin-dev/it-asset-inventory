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

// A dead session must land the user on the login form, not an empty table.
function requireSession(error) {
  const message = error?.message ?? "";
  if (/jwt|session|token|not authenticated/i.test(message)) {
    showView("login");
    showBanner("Session expired. Please sign in again.");
    return false;
  }
  return true;
}

supabase.auth.onAuthStateChange((event, session) => {
  // INITIAL_SESSION fires once when the client finishes restoring a stored
  // session. The bootstrap at the end of this file already covers that case,
  // so handling it here too would load the table twice on every page load.
  if (event === "INITIAL_SESSION") return;
  if (session) {
    el("user-email").textContent = session.user.email;
    showView("app");
    loadAssets();
  } else {
    showView("login");
  }
});

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
        <td class="row-actions">
          <button type="button" data-edit="${escapeHtml(row.id)}">Edit</button>
          <button type="button" data-delete="${escapeHtml(row.id)}">Delete</button>
        </td>
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

function populateSelect(select, values, blankLabel) {
  select.innerHTML =
    `<option value="">${blankLabel}</option>` +
    values.map((v) => `<option value="${v}">${v}</option>`).join("");
}

populateSelect(el("filter-category"), CATEGORIES, "All categories");
populateSelect(el("filter-status"), STATUSES, "All statuses");
populateSelect(el("field-category"), CATEGORIES, "—");
populateSelect(el("field-status"), STATUSES, "—");

// --- Add / edit dialog --------------------------------------------------

function openDialog(asset) {
  el("dialog-title").textContent = asset ? "Edit asset" : "Add asset";
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
  const query = id
    ? supabase.from("assets").update(values).eq("id", id)
    : supabase.from("assets").insert(values);

  let result;
  try {
    result = await query;
  } catch (networkError) {
    showBanner(`Could not reach the database: ${networkError.message}`);
    return false;
  }
  const { error } = result;
  if (error) {
    if (!requireSession(error)) return false;
    // 23505 is the Postgres unique-violation code; assets has one unique column.
    if (error.code === "23505") {
      showBanner(`Asset tag "${values.asset_tag}" already exists.`);
    } else {
      showBanner(`Could not save: ${error.message}`);
    }
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
    result = await supabase.from("assets").delete().eq("id", id);
  } catch (networkError) {
    showBanner(`Could not reach the database: ${networkError.message}`);
    return;
  }
  const { error } = result;
  if (error) {
    if (!requireSession(error)) return;
    showBanner(`Could not delete: ${error.message}`);
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
  await loadAssets();
} else {
  showView("login");
}
