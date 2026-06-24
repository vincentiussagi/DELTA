import { db, auth } from "./firebase.js";
import {
  collection, addDoc, doc, setDoc, runTransaction,
  serverTimestamp, query, orderBy, onSnapshot,
  updateDoc, deleteDoc,
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";

// ═══════════════════════════════════════════════════
// SHIFT DATA & LOGIC
// ═══════════════════════════════════════════════════

const SHIFT_GROUPS = {
  A: [
    { name: "Tedi Hidayat", phone: "6287861511291" },
    { name: "Vincentius Sagi Alban Anindyajati", phone: "6288212237414" },
  ],
  B: [
    { name: "Azmi Awaldi Lubis", phone: "6282161074914" },
    { name: "Bayu Nugraha", phone: "6285156769654" },
  ],
  C: [
    { name: "Tulus Nicholas Manalu", phone: "628973362244" },
    { name: "Dennidzar Alghifary", phone: "6281210162845" },
  ],
  D: [
    { name: "Musi Hardiyanto Wijaya", phone: "6281383924081" },
    { name: "Akbar Ardiansyah", phone: "6285163226093" },
  ],
};

const SHIFT_CYCLE = [3, 3, 3, "OFF", 2, 2, 2, "OFF", 1, 1, 1, "OFF"];
const GROUP_OFFSET = { A: 9, B: 3, C: 0, D: 6 };
const SHIFT_ANCHOR = new Date(2026, 5, 2); // June 2, 2026

const SHIFT_TIMES = {
  1: "07:00 – 15:00",
  2: "15:00 – 23:00",
  3: "23:00 – 07:00",
};

function getGroupShiftForDate(group, date) {
  const anchor = new Date(SHIFT_ANCHOR.getFullYear(), SHIFT_ANCHOR.getMonth(), SHIFT_ANCHOR.getDate());
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((d - anchor) / 86_400_000);
  const ci = ((GROUP_OFFSET[group] + diff) % 12 + 12) % 12;
  return SHIFT_CYCLE[ci];
}

function getCurrentShift(now = new Date()) {
  const h = now.getHours();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (h >= 7 && h < 15) return { shiftNumber: 1, shiftDate: today };
  if (h >= 15 && h < 23) return { shiftNumber: 2, shiftDate: today };
  if (h >= 23) return { shiftNumber: 3, shiftDate: today };
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  return { shiftNumber: 3, shiftDate: yesterday };
}

function getPreviousShift({ shiftNumber, shiftDate }) {
  if (shiftNumber === 1) {
    const prev = new Date(shiftDate.getFullYear(), shiftDate.getMonth(), shiftDate.getDate() - 1);
    return { shiftNumber: 3, shiftDate: prev };
  }
  if (shiftNumber === 2) return { shiftNumber: 1, shiftDate };
  return { shiftNumber: 2, shiftDate };
}

function getNextShift({ shiftNumber, shiftDate }) {
  if (shiftNumber === 1) return { shiftNumber: 2, shiftDate };
  if (shiftNumber === 2) return { shiftNumber: 3, shiftDate };
  const next = new Date(shiftDate.getFullYear(), shiftDate.getMonth(), shiftDate.getDate() + 1);
  return { shiftNumber: 1, shiftDate: next };
}

function getGroupsForShift(shiftNumber, shiftDate) {
  return ["A", "B", "C", "D"].filter(g => getGroupShiftForDate(g, shiftDate) === shiftNumber);
}

function getCurrentOnDutyOfficers() {
  const shift = getCurrentShift();
  const groups = getGroupsForShift(shift.shiftNumber, shift.shiftDate);
  const officers = [];
  for (const g of groups) {
    for (const o of SHIFT_GROUPS[g]) {
      officers.push({ ...o, group: g });
    }
  }
  return officers;
}

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════

const STATUS_CLASS = {
  Pending: "badge-pending",
  Completed: "badge-completed",
  Problem: "badge-problem",
};

function detectRoute(doNumber) {
  const upper = (doNumber || "").trim().toUpperCase();
  if (upper.startsWith("RM2/") || upper.startsWith("OCB/")) return { originMill: "PD2", destinationMill: "IKK" };
  if (upper.startsWith("RM/")) return { originMill: "IKK", destinationMill: "PD2" };
  return null;
}

function routeStr(r) {
  if (r.requestType === "INTERN") {
    return `${r.originWarehouse || "—"} → ${r.destinationWarehouse || "—"}`;
  }
  const o = r.originMill || "";
  const d = r.destinationMill || "";
  return o && d ? `${o} → ${d}` : o || d || "—";
}

function formatTime(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("id-ID", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function escHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function generateRequestId() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  const datePart = `${dd}${mm}${yyyy}`;
  const counterRef = doc(db, "meta", `counter-${datePart}`);
  let newId = "";
  await runTransaction(db, async (txn) => {
    const snap = await txn.get(counterRef);
    const prev = snap.exists() ? (snap.data().count) : 0;
    const next = prev + 1;
    txn.set(counterRef, { count: next });
    newId = `DELTA-${datePart}` + String(next).padStart(3, "0");
  });
  return newId;
}

// ═══════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════

const tabPanes = {
  submit: document.getElementById("tab-submit"),
  dashboard: document.getElementById("tab-dashboard"),
  shift: document.getElementById("tab-shift"),
};
const tabBtns = document.querySelectorAll(".tab-btn");

function switchTab(tabId) {
  Object.entries(tabPanes).forEach(([id, pane]) => {
    pane.style.display = id === tabId ? "block" : "none";
  });
  tabBtns.forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  if (tabId === "shift") renderShiftInfo();
  if (tabId === "dashboard") initDashboard();
}

tabBtns.forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// ═══════════════════════════════════════════════════
// SUBMIT REQUEST FORM
// ═══════════════════════════════════════════════════

const form = document.getElementById("requestForm");
const deptSelect = document.getElementById("department");
const deptOther = document.getElementById("departmentOther");
const sectionDoNo = document.getElementById("sectionDoNo");
const sectionIntern = document.getElementById("sectionIntern");
const doNumberInput = document.getElementById("doNumber");
const routeDetect = document.getElementById("routeDetect");
const submitAlert = document.getElementById("submitAlert");
const btnSubmit = document.getElementById("btnSubmit");

// Department "Other" toggle
deptSelect.addEventListener("change", () => {
  deptOther.style.display = deptSelect.value === "Other" ? "block" : "none";
  if (deptSelect.value !== "Other") deptOther.value = "";
});

// Radio cards
function updateRadioCards() {
  const selected = form.querySelector("input[name='requestType']:checked");
  document.querySelectorAll(".radio-card").forEach(lbl => {
    const inp = lbl.querySelector("input[type='radio']");
    lbl.classList.toggle("selected", inp === selected);
  });
  const val = selected ? selected.value : "";
  sectionDoNo.style.display = val === "DO NO" ? "block" : "none";
  sectionIntern.style.display = val === "INTERN" ? "block" : "none";
  if (val !== "DO NO") { doNumberInput.value = ""; routeDetect.style.display = "none"; }
  if (val !== "INTERN") {
    document.getElementById("internOrigin").value = "";
    document.getElementById("internDest").value = "";
  }
}

form.querySelectorAll("input[name='requestType']").forEach(r => r.addEventListener("change", updateRadioCards));

// DO NO route detection
doNumberInput.addEventListener("input", () => {
  const val = doNumberInput.value.trim();
  if (!val) { routeDetect.style.display = "none"; return; }
  const route = detectRoute(val);
  routeDetect.style.display = "block";
  if (route) {
    routeDetect.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;
        background:#f0fdf4;border-radius:8px;border:1px solid #86efac">
        <span style="font-size:16px">✓</span>
        <div>
          <span style="font-size:12px;color:#15803d;font-weight:700;display:block">Rute Terdeteksi</span>
          <span style="font-size:14px;font-weight:700;color:#15803d">${route.originMill} → ${route.destinationMill}</span>
        </div>
      </div>`;
  } else {
    routeDetect.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;
        background:#fef9c3;border-radius:8px;border:1px solid #fde047">
        <span style="font-size:16px">⚠️</span>
        <div>
          <span style="font-size:12px;color:#854d0e;font-weight:700;display:block">Rute Tidak Terdeteksi</span>
          <span style="font-size:13px;color:#854d0e">Nomor DO harus diawali dengan RM/, RM2/, atau OCB/</span>
        </div>
      </div>`;
  }
});

// Form submit
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  submitAlert.style.display = "none";

  const name = document.getElementById("requesterName").value.trim();
  const dept = deptSelect.value === "Other" ? deptOther.value.trim() : deptSelect.value;
  const phone = document.getElementById("contactNumber").value.trim();
  const typeInput = form.querySelector("input[name='requestType']:checked");
  const requestType = typeInput ? typeInput.value : "";

  // Validation
  if (!name || !dept || !phone || !requestType) {
    showAlert(submitAlert, "Harap lengkapi semua field yang diperlukan.");
    return;
  }

  let originMill = "", destinationMill = "", originWarehouse = "", destinationWarehouse = "", doNumber = "";

  if (requestType === "DO NO") {
    doNumber = doNumberInput.value.trim();
    if (!doNumber) { showAlert(submitAlert, "Masukkan Nomor DO."); return; }
    const route = detectRoute(doNumber);
    if (!route) { showAlert(submitAlert, "Nomor DO tidak valid. Harus diawali dengan RM/, RM2/, atau OCB/"); return; }
    originMill = route.originMill;
    destinationMill = route.destinationMill;
  } else {
    originWarehouse = document.getElementById("internOrigin").value.trim();
    destinationWarehouse = document.getElementById("internDest").value.trim();
    if (!originWarehouse || !destinationWarehouse) {
      showAlert(submitAlert, "Harap isi Gudang Asal dan Gudang Tujuan.");
      return;
    }
  }

  btnSubmit.disabled = true;
  btnSubmit.textContent = "Memproses…";

  try {
    const requestId = await generateRequestId();
    const data = {
      requestId,
      requestTime: serverTimestamp(),
      requesterName: name,
      department: dept,
      contactNumber: phone,
      requestType,
      doNumber,
      originMill,
      destinationMill,
      originWarehouse,
      destinationWarehouse,
      status: "Pending",
      lastUpdated: serverTimestamp(),
    };

    await addDoc(collection(db, "requests"), data);
    await setDoc(doc(db, "publicTracking", requestId), {
      requestId, status: "Pending", updatedAt: serverTimestamp(),
    });

    form.reset();
    deptOther.style.display = "none";
    sectionDoNo.style.display = "none";
    sectionIntern.style.display = "none";
    routeDetect.style.display = "none";
    document.querySelectorAll(".radio-card").forEach(lbl => lbl.classList.remove("selected"));

    showSuccessModal(requestId);
  } catch (err) {
    showAlert(submitAlert, "Error: " + err.message);
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.textContent = "Submit Request";
  }
});

function showAlert(el, msg) {
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 6000);
}

// ═══════════════════════════════════════════════════
// SUCCESS MODAL
// ═══════════════════════════════════════════════════

const modalSuccess = document.getElementById("modalSuccess");

function showSuccessModal(requestId) {
  document.getElementById("successReqId").textContent = requestId;

  // On-duty officers
  const officers = getCurrentOnDutyOfficers();
  const shift = getCurrentShift();
  const shiftLabel = `Shift ${shift.shiftNumber} (${SHIFT_TIMES[shift.shiftNumber]})`;
  const officersEl = document.getElementById("successOfficers");

  if (officers.length > 0) {
    let html = `<div style="background:var(--primary);color:white;padding:10px 14px;font-size:13px;font-weight:700">
      👷 DCO On Duty — ${escHtml(shiftLabel)}</div>`;
    officers.forEach((o, i) => {
      const border = i < officers.length - 1 ? "border-bottom:1px solid var(--border)" : "";
      html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;${border};gap:10px">
        <div>
          <div style="font-size:13.5px;font-weight:600;color:var(--text)">${escHtml(o.name)}</div>
          <div style="font-size:11.5px;color:var(--text-muted)">Group ${escHtml(o.group)}</div>
        </div>
        <a href="https://wa.me/${escHtml(o.phone)}" target="_blank" rel="noopener" class="wa-link"
          style="padding:6px 12px;background:#dcfce7;border-radius:6px;border:1px solid #86efac;flex-shrink:0">
          📱 WhatsApp
        </a>
      </div>`;
    });
    officersEl.innerHTML = html;
    officersEl.style.display = "block";
  } else {
    officersEl.style.display = "none";
  }

  modalSuccess.classList.add("open");
}

document.getElementById("btnCopyId").addEventListener("click", async () => {
  const id = document.getElementById("successReqId").textContent;
  try {
    await navigator.clipboard.writeText(id);
    const btn = document.getElementById("btnCopyId");
    btn.textContent = "✓ Tersalin!";
    btn.style.background = "#dcfce7";
    setTimeout(() => { btn.textContent = "Salin Request ID"; btn.style.background = "white"; }, 1800);
  } catch {}
});

document.getElementById("btnSuccessShift").addEventListener("click", () => {
  modalSuccess.classList.remove("open");
  switchTab("shift");
});
document.getElementById("btnSuccessNew").addEventListener("click", () => {
  modalSuccess.classList.remove("open");
});
modalSuccess.addEventListener("click", (e) => {
  if (e.target === modalSuccess) modalSuccess.classList.remove("open");
});

// ═══════════════════════════════════════════════════
// DASHBOARD — AUTH
// ═══════════════════════════════════════════════════

let dashUnsubscribe = null;
let allRows = [];
let currentStatusFilter = "";
let dashInitialized = false;

const dashLogin = document.getElementById("dashLogin");
const dashMain = document.getElementById("dashMain");

onAuthStateChanged(auth, (user) => {
  if (user) {
    dashLogin.style.display = "none";
    dashMain.style.display = "block";
    document.getElementById("userEmail").textContent = user.email;
    startDashboardListener();
  } else {
    dashLogin.style.display = "block";
    dashMain.style.display = "none";
    if (dashUnsubscribe) { dashUnsubscribe(); dashUnsubscribe = null; }
    allRows = [];
  }
});

function initDashboard() {
  if (dashInitialized) return;
  dashInitialized = true;

  // Login form
  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const loginAlert = document.getElementById("loginAlert");
    loginAlert.style.display = "none";
    const btnLogin = document.getElementById("btnLogin");
    btnLogin.disabled = true;
    btnLogin.textContent = "Masuk…";
    try {
      await signInWithEmailAndPassword(
        auth,
        document.getElementById("loginEmail").value,
        document.getElementById("loginPassword").value
      );
    } catch (err) {
      const code = err.code || "";
      let msg = "Login gagal. Periksa kembali kredensial Anda.";
      if (code === "auth/wrong-password" || code === "auth/invalid-credential") msg = "Password salah.";
      else if (code === "auth/user-not-found") msg = "Akun tidak ditemukan.";
      else if (code === "auth/invalid-email") msg = "Format email tidak valid.";
      else if (code === "auth/too-many-requests") msg = "Terlalu banyak percobaan. Coba lagi nanti.";
      loginAlert.textContent = msg;
      loginAlert.style.display = "block";
    } finally {
      btnLogin.disabled = false;
      btnLogin.textContent = "Masuk";
    }
  });

  document.getElementById("btnLogout").addEventListener("click", () => signOut(auth));

  // Search + filter
  document.getElementById("dashSearch").addEventListener("input", renderTable);
  document.getElementById("dashStatusFilter").addEventListener("change", (e) => {
    currentStatusFilter = e.target.value;
    updateSummaryPills();
    renderTable();
  });
}

function startDashboardListener() {
  if (dashUnsubscribe) return;
  const q = query(collection(db, "requests"), orderBy("requestTime", "desc"));
  dashUnsubscribe = onSnapshot(q, (snap) => {
    allRows = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    updateSummaryPills();
    renderTable();
  });
}

// ─── STATUS SUMMARY PILLS ───

const ALL_STATUSES = ["Pending", "Completed", "Problem"];

function updateSummaryPills() {
  const counts = Object.fromEntries(ALL_STATUSES.map(s => [s, 0]));
  allRows.forEach(r => { if (r.status in counts) counts[r.status]++; });

  const container = document.getElementById("statusSummary");
  let html = `
    <button class="summary-pill ${!currentStatusFilter ? "active" : ""}" data-filter="">
      <span class="summary-pill-label">Semua</span>
      <span class="summary-pill-count">${allRows.length}</span>
    </button>`;
  ALL_STATUSES.forEach(s => {
    html += `
      <button class="summary-pill ${currentStatusFilter === s ? "active" : ""}" data-filter="${s}">
        <span class="badge ${STATUS_CLASS[s] || "badge-normal"}" style="font-size:11.5px">${s}</span>
        <span class="summary-pill-count">${counts[s]}</span>
      </button>`;
  });
  container.innerHTML = html;
  container.querySelectorAll(".summary-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      currentStatusFilter = btn.dataset.filter;
      document.getElementById("dashStatusFilter").value = currentStatusFilter;
      updateSummaryPills();
      renderTable();
    });
  });
}

// ─── TABLE ───

function renderTable() {
  const search = (document.getElementById("dashSearch").value || "").toLowerCase();
  const filtered = allRows.filter(r => {
    const matchStatus = !currentStatusFilter || r.status === currentStatusFilter;
    const matchSearch = !search ||
      (r.requestId || "").toLowerCase().includes(search) ||
      (r.requesterName || "").toLowerCase().includes(search) ||
      (r.department || "").toLowerCase().includes(search) ||
      (r.contactNumber || "").toLowerCase().includes(search) ||
      routeStr(r).toLowerCase().includes(search);
    return matchStatus && matchSearch;
  });

  document.getElementById("rowCount").textContent = `${filtered.length} request`;

  let html = `
    <table style="width:100%;min-width:600px">
      <thead><tr>
        <th>Request ID</th>
        <th>Waktu</th>
        <th>Nama Peminta</th>
        <th>Dept</th>
        <th>No. HP</th>
        <th>Jenis</th>
        <th>Rute / Gudang</th>
        <th>Status</th>
        <th>Aksi</th>
      </tr></thead>
      <tbody>`;

  if (filtered.length === 0) {
    html += `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text-muted)">Tidak ada request ditemukan.</td></tr>`;
  } else {
    filtered.forEach(r => {
      const cls = STATUS_CLASS[r.status] || "badge-normal";
      html += `<tr>
        <td><span class="req-id">${escHtml(r.requestId || "—")}</span></td>
        <td style="font-size:12px;white-space:nowrap;color:var(--text-muted)">${formatTime(r.requestTime)}</td>
        <td style="font-weight:500">${escHtml(r.requesterName || "—")}</td>
        <td>${escHtml(r.department || "—")}</td>
        <td style="white-space:nowrap">${escHtml(r.contactNumber || "—")}</td>
        <td><span style="font-size:12px;font-weight:700;color:var(--primary)">${escHtml(r.requestType || "—")}</span></td>
        <td style="white-space:nowrap">${escHtml(routeStr(r))}</td>
        <td><span class="badge ${cls}">${escHtml(r.status || "—")}</span></td>
        <td><button class="btn btn-sm btn-outline edit-btn" data-id="${escHtml(r._id)}">Edit</button></td>
      </tr>`;
    });
  }

  html += `</tbody></table>`;
  document.getElementById("tableWrap").innerHTML = html;

  document.querySelectorAll(".edit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const row = allRows.find(r => r._id === btn.dataset.id);
      if (row) openEditModal(row);
    });
  });
}

// ═══════════════════════════════════════════════════
// EDIT MODAL
// ═══════════════════════════════════════════════════

const modalEdit = document.getElementById("modalEdit");
let editingRow = null;
let editingStatus = "";

function openEditModal(row) {
  editingRow = row;
  editingStatus = row.status || "Pending";

  document.getElementById("editModalTitle").textContent = `Update Status — ${row.requestId}`;
  document.getElementById("editModalSub").textContent =
    `${row.requesterName || ""} · ${row.department || ""} · ${row.requestType || ""} · ${routeStr(row)}`;
  document.getElementById("editAlert").style.display = "none";

  renderStatusOptions();
  modalEdit.classList.add("open");
}

function renderStatusOptions() {
  const container = document.getElementById("editStatusOptions");
  let html = "";
  ALL_STATUSES.forEach(s => {
    const cls = STATUS_CLASS[s] || "badge-normal";
    const selected = editingStatus === s ? "selected" : "";
    html += `
      <label class="status-radio-row ${selected}" data-status="${s}">
        <input type="radio" name="editStatus" value="${s}" ${editingStatus === s ? "checked" : ""} />
        <span class="badge ${cls}">${s}</span>
      </label>`;
  });
  container.innerHTML = html;
  container.querySelectorAll(".status-radio-row").forEach(lbl => {
    lbl.addEventListener("click", () => {
      editingStatus = lbl.dataset.status;
      renderStatusOptions();
    });
  });
}

document.getElementById("editForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!editingRow) return;
  const editAlert = document.getElementById("editAlert");
  editAlert.style.display = "none";
  const btnSave = document.getElementById("btnEditSave");
  btnSave.disabled = true;
  btnSave.textContent = "Menyimpan…";
  try {
    await updateDoc(doc(db, "requests", editingRow._id), {
      status: editingStatus,
      lastUpdated: serverTimestamp(),
    });
    modalEdit.classList.remove("open");
  } catch (err) {
    editAlert.textContent = "Error: " + err.message;
    editAlert.style.display = "block";
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = "Simpan";
  }
});

document.getElementById("btnDeleteRow").addEventListener("click", async () => {
  if (!editingRow) return;
  if (!confirm(`Hapus request ${editingRow.requestId}? Tindakan ini tidak dapat dibatalkan.`)) return;
  try {
    await deleteDoc(doc(db, "requests", editingRow._id));
    modalEdit.classList.remove("open");
  } catch (err) {
    const editAlert = document.getElementById("editAlert");
    editAlert.textContent = "Hapus gagal: " + err.message;
    editAlert.style.display = "block";
  }
});

document.getElementById("btnEditClose").addEventListener("click", () => modalEdit.classList.remove("open"));
document.getElementById("btnEditCancel").addEventListener("click", () => modalEdit.classList.remove("open"));
modalEdit.addEventListener("click", (e) => { if (e.target === modalEdit) modalEdit.classList.remove("open"); });

// ═══════════════════════════════════════════════════
// SHIFT INFORMATION
// ═══════════════════════════════════════════════════

function renderShiftInfo() {
  const now = new Date();
  const current = getCurrentShift(now);
  const previous = getPreviousShift(current);
  const next = getNextShift(current);

  const timeStr = now.toLocaleString("id-ID", {
    weekday: "long", day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  document.getElementById("shiftHeader").innerHTML = `
    <h1>Informasi Shift</h1>
    <p style="font-size:13px;color:var(--text-muted)">
      ${escHtml(timeStr)} — Shift ${current.shiftNumber} (${SHIFT_TIMES[current.shiftNumber]})
    </p>`;

  const shiftGrid = document.getElementById("shiftGrid");
  shiftGrid.innerHTML =
    buildShiftCard("Shift Sebelumnya", previous, false) +
    buildShiftCard("Shift Saat Ini", current, true) +
    buildShiftCard("Shift Berikutnya", next, false);
}

function buildShiftCard(label, shift, isCurrent) {
  const groups = getGroupsForShift(shift.shiftNumber, shift.shiftDate);
  const dateStr = shift.shiftDate.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
  const cls = isCurrent ? "shift-card current" : "shift-card";
  const lblCls = isCurrent ? "shift-label current" : "shift-label";

  let groupsHtml = "";
  if (groups.length === 0) {
    groupsHtml = `<div style="font-size:13px;color:var(--text-muted);padding:8px 0">—</div>`;
  } else {
    groups.forEach(g => {
      let officersHtml = "";
      SHIFT_GROUPS[g].forEach((o, i) => {
        officersHtml += `
          <div class="shift-officer">
            <span class="shift-officer-name">${escHtml(o.name)}</span>
            <a href="https://wa.me/${escHtml(o.phone)}" target="_blank" rel="noopener" class="wa-link">📱 WhatsApp</a>
          </div>`;
      });
      groupsHtml += `
        <div>
          <div class="shift-group-badge">Group ${escHtml(g)}</div>
          <div class="shift-officers">${officersHtml}</div>
        </div>`;
    });
  }

  return `
    <div class="${cls}">
      <div class="${lblCls}">${escHtml(label)}</div>
      <div class="shift-number">Shift ${shift.shiftNumber}</div>
      <div class="shift-time">${SHIFT_TIMES[shift.shiftNumber]} · ${escHtml(dateStr)}</div>
      <div class="shift-groups">${groupsHtml}</div>
    </div>`;
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════

// Render shift info immediately (it's visible on tab switch)
// Tab starts on "submit", so we don't need to call renderShiftInfo now.
