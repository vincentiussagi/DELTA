// ============================================================
// app.js — DELTA single-page application logic
// ============================================================
// Sections handled here:
//   1. Tab navigation
//   2. Submit Request form (conditional fields + "Other" inputs)
//   3. Request Tracking (real-time Firestore listener)
//   4. DCO Dashboard (auth-gated, edit requests)
//   5. Shift Information
// ============================================================

import { db, auth } from "./firebase.js";
import {
  collection,
  addDoc,
  doc,
  runTransaction,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  where,
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

// ── Shift schedule data ──────────────────────────────────────
// Officers in each group
const SHIFT_GROUPS = {
  A: [
    { name: "Tedi Hidayat",                        phone: "6287861511291" },
    { name: "Vincentius Sagi Alban Anindyajati",   phone: "62895605709579" },
  ],
  B: [
    { name: "Azmi Awaldi Lubis",                   phone: "6282161074914" },
    { name: "Bayu Nugraha",                        phone: "6285156769654" },
  ],
  C: [
    { name: "Tulus Nicholas Manalu",               phone: "628973362244" },
    { name: "Dennidzar Alghifary",                 phone: "6281210162845" },
  ],
  D: [
    { name: "Musi Hardiyanto Wijaya",              phone: "6281383924081" },
    { name: "Akbar Ardiansyah",                    phone: "6285163226093" },
  ],
};

// 12-day repeating pattern: 3 work days + 1 OFF, cycling 3→2→1→3
const SHIFT_CYCLE = [3, 3, 3, "OFF", 2, 2, 2, "OFF", 1, 1, 1, "OFF"];

// Cycle index for each group on the anchor date 2026-06-02 (verified against reference)
const GROUP_CYCLE_OFFSET = { A: 9, B: 3, C: 0, D: 6 };
const SHIFT_ANCHOR = new Date(2026, 5, 2); // 1 Jun 2026 (month is 0-indexed)

const SHIFT_TIMES = {
  1: "07:00 – 15:00",
  2: "15:00 – 23:00",
  3: "23:00 – 07:00",
};

// ── Schedule calculation functions ───────────────────────────

/** Return the shift assignment (1, 2, 3, or "OFF") for a group on a local date. */
function getGroupShiftForDate(group, date) {
  const anchor = new Date(SHIFT_ANCHOR.getFullYear(), SHIFT_ANCHOR.getMonth(), SHIFT_ANCHOR.getDate());
  const d     = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff  = Math.round((d - anchor) / 86_400_000);
  const ci    = ((GROUP_CYCLE_OFFSET[group] + diff) % 12 + 12) % 12;
  return SHIFT_CYCLE[ci];
}

/**
 * Determine which shift is currently active and the date it started on.
 * Returns { shiftNumber: 1|2|3, shiftDate: Date }
 * Shift 3 is overnight (23:00–07:00): if hour < 7 the shift started yesterday.
 */
function getCurrentShift(now = new Date()) {
  const h   = now.getHours();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (h >= 7  && h < 15) return { shiftNumber: 1, shiftDate: today };
  if (h >= 15 && h < 23) return { shiftNumber: 2, shiftDate: today };
  if (h >= 23)            return { shiftNumber: 3, shiftDate: today };
  // 00:00–06:59 — Shift 3 that started yesterday
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  return { shiftNumber: 3, shiftDate: yesterday };
}

/** Shift immediately before the given shift. */
function getPreviousShift({ shiftNumber, shiftDate }) {
  if (shiftNumber === 1) {
    const prev = new Date(shiftDate.getFullYear(), shiftDate.getMonth(), shiftDate.getDate() - 1);
    return { shiftNumber: 3, shiftDate: prev };
  }
  if (shiftNumber === 2) return { shiftNumber: 1, shiftDate };
  return { shiftNumber: 2, shiftDate };
}

/** Shift immediately after the given shift. */
function getNextShift({ shiftNumber, shiftDate }) {
  if (shiftNumber === 1) return { shiftNumber: 2, shiftDate };
  if (shiftNumber === 2) return { shiftNumber: 3, shiftDate };
  const next = new Date(shiftDate.getFullYear(), shiftDate.getMonth(), shiftDate.getDate() + 1);
  return { shiftNumber: 1, shiftDate: next };
}

/** Returns all group keys ("A"–"D") assigned to the given shift on the given date. */
function getGroupsForShift(shiftNumber, shiftDate) {
  return ["A", "B", "C", "D"].filter(
    (g) => getGroupShiftForDate(g, shiftDate) === shiftNumber
  );
}

function getCurrentDutyGroups() {
  const { shiftNumber, shiftDate } = getCurrentShift();
  return getGroupsForShift(shiftNumber, shiftDate);
}
function getPreviousDutyGroups() {
  const prev = getPreviousShift(getCurrentShift());
  return getGroupsForShift(prev.shiftNumber, prev.shiftDate);
}
function getNextDutyGroups() {
  const next = getNextShift(getCurrentShift());
  return getGroupsForShift(next.shiftNumber, next.shiftDate);
}

// ── Status badge CSS classes ─────────────────────────────────
const STATUS_CLASS = {
  Pending: "badge-pending",
  Processing: "badge-processing",
  "Unit Assigned": "badge-assigned",
  "On Delivery": "badge-delivery",
  Completed: "badge-completed",
  Problem: "badge-problem",
};

// ============================================================
// UTILITY HELPERS
// ============================================================

/** Format a Firestore Timestamp or Date for display. */
function formatTime(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Wire up a select element so that choosing "Other" shows a
 * free-text input, and any other choice hides it again.
 */
function wireOther(selectEl, inputEl) {
  if (!selectEl || !inputEl) return;
  selectEl.addEventListener("change", () => {
    const isOther = selectEl.value === "Other";
    inputEl.classList.toggle("hidden", !isOther);
    inputEl.required = isOther;
    if (!isOther) inputEl.value = "";
  });
}

/**
 * Resolve the final value from a select that may have "Other".
 * When "Other" is chosen, uses the companion text input's value.
 */
function resolveValue(selectEl, otherInputEl) {
  if (!selectEl) return "";
  if (selectEl.value === "Other") {
    return otherInputEl ? otherInputEl.value.trim() : "";
  }
  return selectEl.value;
}

/** Show or hide a form group, setting required on its first input/select. */
function setGroupVisible(groupEl, visible) {
  if (!groupEl) return;
  groupEl.classList.toggle("hidden", !visible);
  const ctrl = groupEl.querySelector("select, input");
  if (ctrl) ctrl.required = visible;
  // If hiding, clear the "Other" sub-input too
  if (!visible) {
    const otherInput = groupEl.querySelector('input[type="text"]');
    if (otherInput) {
      otherInput.classList.add("hidden");
      otherInput.required = false;
      otherInput.value = "";
    }
    if (ctrl) ctrl.value = "";
  }
}

// ============================================================
// TAB NAVIGATION
// ============================================================

function initTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  const sections = document.querySelectorAll(".tab-section");

  function activate(tabId) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === tabId));
    sections.forEach((s) =>
      s.classList.toggle("hidden", s.id !== tabId + "-section")
    );
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activate(tab.dataset.tab));
  });

  // Default: show Submit tab
  activate("submit");
}

// ============================================================
// SUBMIT REQUEST FORM
// ============================================================

// -- Auto-generate date-based sequential request IDs
// Format: DELTA-DDMMYYYY001, DELTA-DDMMYYYY002, …
// The counter resets each day — each date gets its own counter doc.
async function generateRequestId() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  const datePart = `${dd}${mm}${yyyy}`;          // e.g. "20022026"

  // One counter document per calendar day in meta/counter-DDMMYYYY
  const counterRef = doc(db, "meta", `counter-${datePart}`);
  let newId;
  await runTransaction(db, async (txn) => {
    const snap = await txn.get(counterRef);
    const prev = snap.exists() ? snap.data().count : 0;
    const next = prev + 1;
    txn.set(counterRef, { count: next });
    newId = `DELTA-${datePart}` + String(next).padStart(3, "0");
  });
  return newId;                                   // e.g. "DELTA-20022026001"
}

/**
 * Save a delivery request to Firestore.
 * Collection: "requests"
 * Called from the form submit handler below.
 */
async function saveRequest(data) {
  // ------------------------------------------------------------
  // Firestore write: adds a new document to the "requests" collection.
  // The requestId is stored as a field (not the document ID) so we
  // can display it to the user independently of Firestore doc IDs.
  // ------------------------------------------------------------
  return addDoc(collection(db, "requests"), data);
}

function initSubmitForm() {
  const form = document.getElementById("requestForm");
  const msgEl = document.getElementById("formMsg");
  const successModal = document.getElementById("successModal");
  const successIdEl = document.getElementById("successId");
  const newRequestBtn = document.getElementById("newRequestBtn");

  // -- Request Type: show/hide DO NO or INTERN sub-sections
  const requestTypeEl = document.getElementById("requestType");
  const doSection = document.getElementById("doSection");
  const internSection = document.getElementById("internSection");

  // -- DO NO fields
  const originMillEl = document.getElementById("originMill");
  const destMillEl = document.getElementById("destinationMill");
  const originMillWhGroup = document.getElementById("originMillWhGroup");
  const destMillWhGroup = document.getElementById("destMillWhGroup");
  const originMillWhEl = document.getElementById("originMillWh");
  const originMillWhOtherEl = document.getElementById("originMillWhOther");
  const destMillWhEl = document.getElementById("destMillWh");
  const destMillWhOtherEl = document.getElementById("destMillWhOther");

  // -- INTERN fields
  const internOriginWhEl = document.getElementById("internOriginWh");
  const internOriginWhOtherEl = document.getElementById("internOriginWhOther");
  const internDestWhEl = document.getElementById("internDestWh");
  const internDestWhOtherEl = document.getElementById("internDestWhOther");

  // -- Department "Other" text input
  const departmentEl = document.getElementById("department");
  const departmentOtherEl = document.getElementById("departmentOther");
  wireOther(departmentEl, departmentOtherEl);

  // -- Unit Type "Other" text input
  const unitTypeEl = document.getElementById("unitType");
  const unitTypeOtherEl = document.getElementById("unitTypeOther");
  wireOther(unitTypeEl, unitTypeOtherEl);

  // -- DO NO mill warehouse "Other" text inputs
  wireOther(originMillWhEl, originMillWhOtherEl);
  wireOther(destMillWhEl, destMillWhOtherEl);

  // -- INTERN warehouse "Other" text inputs
  wireOther(internOriginWhEl, internOriginWhOtherEl);
  wireOther(internDestWhEl, internDestWhOtherEl);

  // -- Toggle DO NO / INTERN sections based on Request Type selection
  function updateRequestType() {
    const type = requestTypeEl.value;
    const isDO = type === "DO NO";
    const isINTERN = type === "INTERN";

    doSection.classList.toggle("hidden", !isDO);
    internSection.classList.toggle("hidden", !isINTERN);

    // Reset warehouse visibility when switching type
    if (!isDO) {
      setGroupVisible(originMillWhGroup, false);
      setGroupVisible(destMillWhGroup, false);
    }
  }

  requestTypeEl.addEventListener("change", updateRequestType);
  updateRequestType();

  // -- Show Origin Warehouse when Origin Mill = IKK (DO NO only)
  originMillEl.addEventListener("change", () => {
    setGroupVisible(originMillWhGroup, originMillEl.value === "IKK");
    wireOther(originMillWhEl, originMillWhOtherEl);
  });

  // -- Show Destination Warehouse when Destination Mill = IKK (DO NO only)
  destMillEl.addEventListener("change", () => {
    setGroupVisible(destMillWhGroup, destMillEl.value === "IKK");
    wireOther(destMillWhEl, destMillWhOtherEl);
  });

  // ── Form submission ────────────────────────────────────────
  // This is where the form data is collected and sent to Firestore.
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msgEl.innerHTML = "";

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";

    try {
      const requestType = requestTypeEl.value;

      // Resolve "Other" fields
      const department = resolveValue(departmentEl, departmentOtherEl);
      const unitType = resolveValue(unitTypeEl, unitTypeOtherEl);

      // Build origin/destination fields depending on request type
      let originMill = "";
      let destinationMill = "";
      let originWarehouse = "";
      let destinationWarehouse = "";

      if (requestType === "DO NO") {
        originMill = originMillEl.value;
        destinationMill = destMillEl.value;
        if (originMill === "IKK") {
          originWarehouse = resolveValue(originMillWhEl, originMillWhOtherEl);
        }
        if (destinationMill === "IKK") {
          destinationWarehouse = resolveValue(destMillWhEl, destMillWhOtherEl);
        }
      } else if (requestType === "INTERN") {
        originWarehouse = resolveValue(internOriginWhEl, internOriginWhOtherEl);
        destinationWarehouse = resolveValue(internDestWhEl, internDestWhOtherEl);
      }

      // Generate the unique DLT-xxx request ID
      const requestId = await generateRequestId();

      // Build the full data object to store in Firestore
      const requestData = {
        requestId,
        requestTime: serverTimestamp(),
        requesterName: document.getElementById("requesterName").value.trim(),
        department,
        contactNumber: document.getElementById("contactNumber").value.trim(),
        unitType,
        requestType,
        doNumber:
          requestType === "DO NO"
            ? document.getElementById("doNumber").value.trim()
            : "",
        originMill,
        destinationMill,
        originWarehouse,
        destinationWarehouse,
        notes: document.getElementById("notes").value.trim(),
        // Default status for all new requests
        status: "Pending",
        assignedOfficer: "",
        vendor: "",
        vehicleNumber: "",
        driverName: "",
        driverPhone: "",
        lastUpdated: serverTimestamp(),
      };

      // Save to Firestore
      await saveRequest(requestData);

      // Show success modal with the assigned request ID
      successIdEl.textContent = requestId;
      successModal.classList.add("open");
      form.reset();
      updateRequestType();
    } catch (err) {
      console.error(err);
      msgEl.innerHTML = `<div class="alert alert-error">Error submitting request: ${err.message}</div>`;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Request";
    }
  });

  newRequestBtn?.addEventListener("click", () =>
    successModal.classList.remove("open")
  );
}

// ============================================================
// REQUEST TRACKING (public — no login needed)
// ============================================================

function routeStr(r) {
  if (r.requestType === "INTERN") {
    const o = r.originWarehouse || "—";
    const d = r.destinationWarehouse || "—";
    return `${o} → ${d}`;
  }
  // DO NO
  let o = r.originMill || "";
  if (o === "IKK" && r.originWarehouse) o = `IKK / ${r.originWarehouse}`;
  let d = r.destinationMill || "";
  if (d === "IKK" && r.destinationWarehouse) d = `IKK / ${r.destinationWarehouse}`;
  return o && d ? `${o} → ${d}` : o || d || "—";
}

let trackUnsubscribe = null;

function initTracking() {
  const form = document.getElementById("trackSearchForm");
  const searchInput = document.getElementById("trackSearchId");
  const loadingEl = document.getElementById("trackLoading");
  const errorEl = document.getElementById("trackError");
  const errorMsgEl = document.getElementById("trackErrorMsg");
  const resultEl = document.getElementById("trackResult");

  if (!form) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const searchId = searchInput.value.trim().toUpperCase();
    if (!searchId) return;

    // Unsubscribe from previous search listener if it exists
    if (trackUnsubscribe) {
      trackUnsubscribe();
      trackUnsubscribe = null;
    }

    // Show loading, hide previous results/errors
    loadingEl.classList.remove("hidden");
    errorEl.classList.add("hidden");
    resultEl.classList.add("hidden");
    resultEl.innerHTML = "";

    try {
      const q = query(
        collection(db, "requests"),
        where("requestId", "==", searchId)
      );

      trackUnsubscribe = onSnapshot(q, (snap) => {
        loadingEl.classList.add("hidden");

        if (snap.empty) {
          errorMsgEl.textContent = `No delivery request was found with ID "${searchId}". Please check the ID and try again.`;
          errorEl.classList.remove("hidden");
          resultEl.classList.add("hidden");
          return;
        }

        const r = snap.docs[0].data();
        errorEl.classList.add("hidden");
        renderRequestDetails(r);
        resultEl.classList.remove("hidden");
      }, (error) => {
        console.error("Firestore tracking error:", error);
        loadingEl.classList.add("hidden");
        errorMsgEl.textContent = `An error occurred while fetching tracking details: ${error.message}`;
        errorEl.classList.remove("hidden");
        resultEl.classList.add("hidden");
      });
    } catch (err) {
      console.error(err);
      loadingEl.classList.add("hidden");
      errorMsgEl.textContent = `Failed to query: ${err.message}`;
      errorEl.classList.remove("hidden");
    }
  });

  function renderRequestDetails(r) {
    const statusClass = STATUS_CLASS[r.status] || "badge-normal";

    // Progress bar calculations based on standard 5 statuses
    // Pending -> Processing -> Unit Assigned -> On Delivery -> Completed
    const statuses = ["Pending", "Processing", "Unit Assigned", "On Delivery", "Completed"];
    
    // If status is Problem, determine how far it went, or just color the current state
    const isProblem = r.status === "Problem";
    
    // Find index of current status. If problem, look for last known state (e.g. check driver/vendor assignments)
    let currentIdx = statuses.indexOf(r.status);
    if (isProblem) {
      // Logic to deduce where it failed:
      if (r.driverName || r.vehicleNumber) {
        currentIdx = 3; // "On Delivery" or "Unit Assigned" failed. Let's show it at Step 4 (On Delivery) / Index 3
      } else if (r.vendor) {
        currentIdx = 2; // "Unit Assigned" failed. Step 3 / Index 2
      } else {
        currentIdx = 1; // "Processing" failed. Step 2 / Index 1
      }
    }

    // Set percentage
    let percent = 0;
    if (currentIdx !== -1) {
      percent = currentIdx * 25; // 0%, 25%, 50%, 75%, 100%
    }

    // Render style progress properties
    const progressStyle = `width: ${percent}%;`;

    const stepClass = (stepNum) => {
      const idx = stepNum - 1;
      if (isProblem && idx === currentIdx) return "problem";
      if (idx < currentIdx || r.status === "Completed") return "completed";
      if (idx === currentIdx) return "active";
      return "";
    };

    const stepIcon = (stepNum) => {
      const idx = stepNum - 1;
      if (isProblem && idx === currentIdx) return "⚠️";
      if (idx < currentIdx || r.status === "Completed") return "✓";
      return stepNum;
    };

    // Driver phone format WA link
    let waLinkHtml = "";
    if (r.driverPhone) {
      const cleanPhone = r.driverPhone.replace(/[^0-9]/g, "");
      const waPhone = cleanPhone.startsWith("0") ? "62" + cleanPhone.substring(1) : cleanPhone;
      waLinkHtml = `
        <div style="margin-top: 4px;">
          <a href="https://wa.me/${waPhone}" target="_blank" rel="noopener" class="wa-link">
            📱 WhatsApp (${r.driverPhone})
          </a>
        </div>
      `;
    }

    resultEl.innerHTML = `
      <div class="card" style="box-shadow: var(--shadow-lg); overflow: hidden;">
        <!-- Header -->
        <div class="card-header" style="flex-direction: column; align-items: flex-start; gap: 8px; border-bottom: 1px solid var(--border);">
          <div style="display: flex; justify-content: space-between; width: 100%; align-items: center; flex-wrap: wrap; gap: 8px;">
            <span class="req-id" style="font-size: 20px; font-weight: 800; color: var(--primary);">${r.requestId}</span>
            <span class="badge ${statusClass}">${r.status}</span>
          </div>
          <div style="font-size: 13px; color: var(--text-muted);">
            Submitted on <strong>${formatTime(r.requestTime)}</strong> | Type: <strong>${r.requestType}</strong>
          </div>
        </div>

        <div class="card-body">
          <!-- Problem Alert Banner -->
          ${isProblem ? `
          <div class="alert alert-error" style="display: flex; gap: 12px; align-items: flex-start; margin-bottom: 24px;">
            <div style="font-size: 22px; line-height: 1;">⚠️</div>
            <div>
              <strong style="display: block; margin-bottom: 4px;">Delivery Issue Reported</strong>
              <p style="margin: 0; font-size: 13px;">Our team has flagged a problem with this delivery request. Please check the notes or contact shift officers for support.</p>
            </div>
          </div>
          ` : ""}

          <!-- Timeline Stepper -->
          <div class="tracking-timeline">
            <div class="timeline-progress" style="${progressStyle}"></div>
            
            <div class="timeline-step ${stepClass(1)}">
              <div class="step-node">${stepIcon(1)}</div>
              <div class="step-label">Submitted</div>
            </div>
            <div class="timeline-step ${stepClass(2)}">
              <div class="step-node">${stepIcon(2)}</div>
              <div class="step-label">Processing</div>
            </div>
            <div class="timeline-step ${stepClass(3)}">
              <div class="step-node">${stepIcon(3)}</div>
              <div class="step-label">Unit Assigned</div>
            </div>
            <div class="timeline-step ${stepClass(4)}">
              <div class="step-node">${stepIcon(4)}</div>
              <div class="step-label">On Delivery</div>
            </div>
            <div class="timeline-step ${stepClass(5)}">
              <div class="step-node">${stepIcon(5)}</div>
              <div class="step-label">Completed</div>
            </div>
          </div>

          <hr style="border: 0; border-top: 1px solid var(--border); margin: 24px 0;" />

          <!-- Details Grid -->
          <div class="form-grid">
            <!-- Route & Unit -->
            <div class="form-section" style="margin-top: 0; background: #f8fafc;">
              <div class="form-section-title">Route & Unit Details</div>
              <div style="display: flex; flex-direction: column; gap: 12px;">
                <div>
                  <span style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); display: block;">Route</span>
                  <strong style="font-size: 15px; color: var(--primary-dark);">${routeStr(r)}</strong>
                </div>
                ${r.requestType === "DO NO" && r.doNumber ? `
                <div>
                  <span style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); display: block;">DO Number</span>
                  <strong>${r.doNumber}</strong>
                </div>
                ` : ""}
                <div>
                  <span style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); display: block;">Unit Type</span>
                  <strong>${r.unitType || "—"}</strong>
                </div>
              </div>
            </div>

            <!-- Delivery Assignment -->
            <div class="form-section" style="margin-top: 0; background: #f8fafc;">
              <div class="form-section-title">Delivery Assignment</div>
              <div style="display: flex; flex-direction: column; gap: 12px;">
                <div>
                  <span style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); display: block;">Vendor / Carrier</span>
                  <strong>${r.vendor || "Not assigned yet"}</strong>
                </div>
                <div>
                  <span style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); display: block;">Vehicle Number (Nopol)</span>
                  <strong>${r.vehicleNumber || "—"}</strong>
                </div>
                <div>
                  <span style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); display: block;">Driver Details</span>
                  ${r.driverName ? `
                    <strong>${r.driverName}</strong>
                    ${waLinkHtml}
                  ` : "<strong>—</strong>"}
                </div>
              </div>
            </div>

            <!-- Notes & Updates -->
            <div class="full" style="display: grid; grid-template-columns: 1fr; gap: 14px;">
              ${r.notes ? `
              <div class="form-section" style="margin-top: 0; background: #fffbeb; border-color: #fde047;">
                <div class="form-section-title" style="color: #854d0e;">Status Notes / Instructions</div>
                <p style="font-size: 13.5px; white-space: pre-line; color: #451a03; margin: 0;">${r.notes}</p>
              </div>
              ` : ""}

              <div style="display: flex; justify-content: space-between; align-items: center; color: var(--text-muted); font-size: 12px; border-top: 1px solid var(--border); padding-top: 12px; margin-top: 6px;">
                <span>Last Updated: <strong>${formatTime(r.lastUpdated)}</strong></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

// ============================================================
// DCO DASHBOARD (login required)
// ============================================================

function initDashboard() {
  const loginSection = document.getElementById("dashLogin");
  const tableSection = document.getElementById("dashTable");
  const userEmailEl = document.getElementById("dashUserEmail");
  const logoutBtn = document.getElementById("dashLogout");
  const loginForm = document.getElementById("dashLoginForm");
  const loginMsgEl = document.getElementById("dashLoginMsg");

  // -- Auth state: toggle between login form and dashboard table
  onAuthStateChanged(auth, (user) => {
    if (user) {
      loginSection.classList.add("hidden");
      tableSection.classList.remove("hidden");
      if (userEmailEl) userEmailEl.textContent = user.email;
      loadDashboardTable();
    } else {
      loginSection.classList.remove("hidden");
      tableSection.classList.add("hidden");
    }
  });

  // -- Login form submission
  loginForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginMsgEl.innerHTML = "";
    const email = document.getElementById("dashEmail").value.trim();
    const password = document.getElementById("dashPassword").value;
    const btn = loginForm.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      let msg = "Login failed. Check your credentials.";
      if (err.code === "auth/wrong-password") msg = "Incorrect password.";
      else if (err.code === "auth/user-not-found") msg = "Account not found.";
      else if (err.code === "auth/invalid-email") msg = "Invalid email.";
      else if (err.code === "auth/too-many-requests") msg = "Too many attempts. Try again later.";
      loginMsgEl.innerHTML = `<div class="alert alert-error">${msg}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Sign In";
    }
  });

  // -- Logout
  logoutBtn?.addEventListener("click", () => signOut(auth));

  // -- Edit modal
  const modal = document.getElementById("editModal");
  const modalCloseBtn = document.getElementById("modalClose");
  const cancelEditBtn = document.getElementById("cancelEdit");
  const editForm = document.getElementById("editForm");
  const modalMsgEl = document.getElementById("modalMsg");
  let currentDocId = null;

  modalCloseBtn?.addEventListener("click", () => modal.classList.remove("open"));
  cancelEditBtn?.addEventListener("click", () => modal.classList.remove("open"));
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("open");
  });

  window.__openEdit = (docId, row) => {
    currentDocId = docId;
    document.getElementById("modalReqId").textContent = row.requestId;
    document.getElementById("modalRoute").textContent =
      `${row.requestType} • ${routeStr(row)}`;
    document.getElementById("editStatus").value = row.status || "Pending";
    document.getElementById("editVendor").value = row.vendor || "";
    document.getElementById("editVehicle").value = row.vehicleNumber || "";
    document.getElementById("editDriver").value = row.driverName || "";
    document.getElementById("editDriverPhone").value = row.driverPhone || "";
    document.getElementById("editNotes").value = row.notes || "";
    modalMsgEl.textContent = "";
    modal.classList.add("open");
  };

  editForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const saveBtn = editForm.querySelector('[type="submit"]');
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      await updateDoc(doc(db, "requests", currentDocId), {
        status: document.getElementById("editStatus").value,
        vendor: document.getElementById("editVendor").value.trim(),
        vehicleNumber: document.getElementById("editVehicle").value.trim(),
        driverName: document.getElementById("editDriver").value.trim(),
        driverPhone: document.getElementById("editDriverPhone").value.trim(),
        notes: document.getElementById("editNotes").value.trim(),
        lastUpdated: serverTimestamp(),
      });
      modal.classList.remove("open");
    } catch (err) {
      modalMsgEl.textContent = "Error: " + err.message;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Changes";
    }
  });

  // -- Delete request (for removing test data)
  document.getElementById("deleteRequestBtn")?.addEventListener("click", async () => {
    const reqId = document.getElementById("modalReqId").textContent;
    if (!confirm(`Delete request ${reqId}? This cannot be undone.`)) return;
    try {
      await deleteDoc(doc(db, "requests", currentDocId));
      modal.classList.remove("open");
    } catch (err) {
      modalMsgEl.textContent = "Delete failed: " + err.message;
    }
  });
}

let dashboardLoaded = false;

function loadDashboardTable() {
  if (dashboardLoaded) return;
  dashboardLoaded = true;

  const tbody = document.getElementById("dashTbody");
  const loadingEl = document.getElementById("dashLoading");
  const searchEl = document.getElementById("dashSearch");
  const statusFilter = document.getElementById("dashStatusFilter");
  const countEl = document.getElementById("dashCount");
  const summaryEl = document.getElementById("statusSummary");

  const ALL_STATUSES = [
    "Pending", "Processing", "Unit Assigned",
    "On Delivery", "Completed", "Problem",
  ];

  // -- Render the live status count pills above the table
  function renderStatusSummary(rows) {
    if (!summaryEl) return;
    const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
    rows.forEach((r) => { if (r.status in counts) counts[r.status]++; });
    const active = statusFilter?.value || "";

    summaryEl.innerHTML = [
      // "All" pill
      `<button class="summary-pill ${!active ? "active" : ""}"
        data-status="" onclick="window.__setStatusFilter('')">
        <span class="summary-pill-label">All</span>
        <span class="summary-pill-count">${rows.length}</span>
      </button>`,
      ...ALL_STATUSES.map((s) => {
        const cls = STATUS_CLASS[s] || "badge-normal";
        const isActive = active === s;
        return `<button class="summary-pill ${isActive ? "active" : ""}"
          data-status="${s}" onclick="window.__setStatusFilter('${s}')">
          <span class="badge ${cls}" style="font-size:11.5px;">${s}</span>
          <span class="summary-pill-count">${counts[s]}</span>
        </button>`;
      }),
    ].join("");
  }

  let allRows = [];

  // Real-time listener for dashboard table
  const q = query(collection(db, "requests"), orderBy("requestTime", "desc"));
  onSnapshot(q, (snap) => {
    allRows = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    loadingEl?.classList.add("hidden");
    renderStatusSummary(allRows);
    renderDash();
  });

  // Clicking a pill sets the status filter and re-renders
  window.__setStatusFilter = (status) => {
    if (statusFilter) statusFilter.value = status;
    renderStatusSummary(allRows);
    renderDash();
  };

  function renderDash() {
    const search = searchEl?.value.toLowerCase() ?? "";
    const status = statusFilter?.value ?? "";

    const filtered = allRows.filter((r) => {
      const matchSearch =
        !search ||
        Object.values(r)
          .filter((v) => typeof v === "string")
          .some((v) => v.toLowerCase().includes(search)) ||
        routeStr(r).toLowerCase().includes(search);
      const matchStatus = !status || r.status === status;
      return matchSearch && matchStatus;
    });

    if (countEl)
      countEl.textContent = `${filtered.length} request${filtered.length !== 1 ? "s" : ""}`;

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;padding:32px;color:var(--text-muted);">No requests found.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered
      .map((r) => {
        const cls = STATUS_CLASS[r.status] || "badge-normal";
        const driverInfo = [r.driverName, r.vehicleNumber]
          .filter(Boolean)
          .join(" / ") || "—";
        return `<tr>
          <td><span class="req-id">${r.requestId || "—"}</span></td>
          <td style="font-size:12px;white-space:nowrap">${formatTime(r.requestTime)}</td>
          <td>${r.requesterName || "—"}</td>
          <td>${r.department || "—"}</td>
          <td>${r.contactNumber || "—"}</td>
          <td>${r.requestType || "—"}</td>
          <td style="white-space:nowrap">${routeStr(r)}</td>
          <td>${r.unitType || "—"}</td>
          <td><span class="badge ${cls}">${r.status || "—"}</span></td>
          <td>${r.vendor || "—"}</td>
          <td>${driverInfo}</td>
          <td style="font-size:12px;white-space:nowrap;color:var(--text-muted)">${formatTime(r.lastUpdated)}</td>
          <td>
            <button class="btn btn-sm btn-outline"
              onclick='window.__openEdit("${r._id}", ${JSON.stringify(r).replace(/'/g, "&#39;")})'>
              Edit
            </button>
          </td>
        </tr>`;
      })
      .join("");
  }

  searchEl?.addEventListener("input", renderDash);
  statusFilter?.addEventListener("change", renderDash);
}

// ============================================================
// SHIFT INFORMATION
// ============================================================

/** Build and inject the three shift panels (previous / current / next). */
function renderShiftPanel() {
  const grid    = document.getElementById("shiftGrid");
  const clockEl = document.getElementById("shiftClock");
  if (!grid) return;

  const now     = new Date();
  const current  = getCurrentShift(now);
  const previous = getPreviousShift(current);
  const next     = getNextShift(current);

  // Live clock line
  if (clockEl) {
    const timeStr = now.toLocaleString("id-ID", {
      weekday: "long", day: "2-digit", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
    clockEl.textContent = `${timeStr} — Shift ${current.shiftNumber} (${SHIFT_TIMES[current.shiftNumber]})`;
  }

  function officersHtml(groups, shiftDate) {
    const dateStr = shiftDate.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
    if (groups.length === 0) return `<div class="shift-no-officer">—</div>`;
    return groups.map((g) => `
      <div class="shift-group-block">
        <div class="shift-group-badge">Group ${g}</div>
        <div class="shift-officers">
          ${SHIFT_GROUPS[g].map((o) => `
            <div class="shift-officer">
              <span class="shift-officer-name">${o.name}</span>
              <a href="https://wa.me/${o.phone}" target="_blank" rel="noopener" class="wa-link">📱 WhatsApp</a>
            </div>`).join("")}
        </div>
      </div>`).join("");
  }

  function buildCard(label, shift, isCurrent) {
    const groups  = getGroupsForShift(shift.shiftNumber, shift.shiftDate);
    const dateStr = shift.shiftDate.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
    return `
      <div class="shift-card ${isCurrent ? "current" : ""}">
        <div class="shift-label ${isCurrent ? "current" : ""}">${label}</div>
        <div class="shift-number">Shift ${shift.shiftNumber}</div>
        <div class="shift-time">${SHIFT_TIMES[shift.shiftNumber]} · ${dateStr}</div>
        <div class="shift-groups">${officersHtml(groups, shift.shiftDate)}</div>
      </div>`;
  }

  grid.innerHTML = [
    buildCard("Previous Shift", previous, false),
    buildCard("Current Shift",  current,  true),
    buildCard("Next Shift",     next,     false),
  ].join("");
}

function initShift() {
  renderShiftPanel();
  setInterval(renderShiftPanel, 60_000); // auto-refresh every minute
}

// ============================================================
// BOOT
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initSubmitForm();
  initTracking();
  initDashboard();
  initShift();
});
