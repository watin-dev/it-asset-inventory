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

// Replaced in Task 5 with real search and filter logic.
function applyFilters() {
  renderAssets(allAssets);
}

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
