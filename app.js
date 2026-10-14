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

supabase.auth.onAuthStateChange((_event, session) => {
  if (session) {
    el("user-email").textContent = session.user.email;
    showView("app");
  } else {
    showView("login");
  }
});

const { data: { session: initialSession } } = await supabase.auth.getSession();
if (initialSession) {
  el("user-email").textContent = initialSession.user.email;
  showView("app");
} else {
  showView("login");
}
