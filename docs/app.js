import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot, collection, getDocs,
  serverTimestamp, runTransaction, query, where
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";

// =========================
// Firebase config (your project)
// =========================
const firebaseConfig = {
  apiKey: "AIzaSyD_2ud1Nb3YMDFM2k_GwmKegVttsjCoajg",
  authDomain: "pricing-game-31176.firebaseapp.com",
  projectId: "pricing-game-31176",
  storageBucket: "pricing-game-31176.firebasestorage.app",
  messagingSenderId: "942843895084",
  appId: "1:942843895084:web:dc7aecbf63e16af49e2089"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// =========================
// Defaults (session creation)
// =========================
const DEFAULTS = {
  nTeams: 10,
  rounds: 8,
  timerSec: 90,
  pMin: 6.0,
  pMax: 20.0,
  pStep: 0.1,
  cost: 5.0,
  Q: 1000,
  k: 2,
  round1Visibility: "private", // private|full
  round1AdEnabled: false,
  defaultAdFee: 80,
  defaultAdMult: 1.2,
};

// =========================
// UI helpers
// =========================
const $ = (id) => document.getElementById(id);
const show = (id) => { $(id).hidden = false; };
const hide = (id) => { $(id).hidden = true; };
const fmtMoney0 = (x) => (Math.round(x)).toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtPct2 = (x) => (100 * x).toFixed(2) + "%";
const fmtPrice1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const clampStep = (x, min, max, step) => {
  const v = Math.min(max, Math.max(min, x));
  const snapped = Math.round((v - min) / step) * step + min;
  return Math.min(max, Math.max(min, Math.round(snapped * 10) / 10));
};

function randomJoinCode(len = 4) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function setHashRoute(route, params = {}) {
  const sp = new URLSearchParams(params);
  location.hash = route + (sp.toString() ? ("?" + sp.toString()) : "");
}

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "home";
  const [route, qs] = raw.split("?");
  const params = new URLSearchParams(qs || "");
  return { route, params };
}

// =========================
// App state
// =========================
let uid = null;
let role = ""; // student|instructor
let activeSessionId = null;
let joinCode = null;
let teamNumber = null;
let teamToken = null;
let instructorAuthed = false;
let sessionUnsub = null;
let teamUnsub = null;
let submissionsUnsub = null;
let lastSessionDoc = null;

// local storage keys
const LS = {
  teamToken: (sessionId) => `pg_teamToken_${sessionId}`,
  teamNumber: (sessionId) => `pg_teamNumber_${sessionId}`,
};

function cleanupSubs() {
  for (const u of [sessionUnsub, teamUnsub, submissionsUnsub]) {
    try { if (typeof u === "function") u(); } catch {}
  }
  sessionUnsub = teamUnsub = submissionsUnsub = null;
}

function hideAllScreens() {
  const ids = [
    "screenLoading","screenHome",
    "screenStudentJoin","screenStudentClaim","screenStudentLobby","screenStudentRound","screenStudentSubmitted","screenStudentResults","screenStudentFinal",
    "screenInstructorPIN","screenInstructorCreate","screenInstructorLobby","screenInstructorRound","screenInstructorBetween","screenInstructorFinal",
  ];
  ids.forEach(hide);
}

function setEnvConnected(ok) {
  $("envBadge").hidden = !ok;
}

// =========================
// Firestore paths
// =========================
const sessionsCol = () => collection(db, "sessions");
const sessionDoc = (sessionId) => doc(db, "sessions", sessionId);
const teamsCol = (sessionId) => collection(db, "sessions", sessionId, "teams");
const teamDoc = (sessionId, teamNum) => doc(db, "sessions", sessionId, "teams", String(teamNum));
const roundsCol = (sessionId) => collection(db, "sessions", sessionId, "rounds");
const roundDoc = (sessionId, roundNum) => doc(db, "sessions", sessionId, "rounds", String(roundNum));
const submissionsCol = (sessionId, roundNum) => collection(db, "sessions", sessionId, "rounds", String(roundNum), "submissions");
const submissionDoc = (sessionId, roundNum, teamNum) => doc(db, "sessions", sessionId, "rounds", String(roundNum), "submissions", String(teamNum));
const resultsCol = (sessionId, roundNum) => collection(db, "sessions", sessionId, "rounds", String(roundNum), "results");
const resultDoc = (sessionId, roundNum, teamNum) => doc(db, "sessions", sessionId, "rounds", String(roundNum), "results", String(teamNum));

// =========================
// Session creation
// =========================
async function createSession({ pin, params }) {
  // joinCode -> sessionId mapping stored in sessions using joinCode field (unique enough for classroom)
  // sessionId: random doc id
  const pinHash = await sha256Hex(pin);

  // attempt unique join code
  let code = randomJoinCode();
  for (let tries = 0; tries < 5; tries++) {
    const qy = query(sessionsCol(), where("joinCode", "==", code));
    const snap = await getDocs(qy);
    if (snap.empty) break;
    code = randomJoinCode();
  }

  const sessionRef = doc(sessionsCol());
  const sid = sessionRef.id;

  const now = serverTimestamp();
  const sessionData = {
    createdAt: now,
    joinCode: code,
    status: "lobby", // lobby|round_active|between|ended
    joinLocked: false,
    currentRound: 0,
    params: {
      nTeams: params.nTeams,
      rounds: params.rounds,
      timerSec: params.timerSec,
      pMin: params.pMin,
      pMax: params.pMax,
      pStep: params.pStep,
      cost: params.cost,
      Q: params.Q,
      k: params.k,
    },
    // round 1 config stored under rounds/1
    instructor: {
      pinHash,
      createdByUid: uid,
    }
  };

  await setDoc(sessionRef, sessionData);

  // create teams docs
  const teamWrites = [];
  for (let t = 1; t <= params.nTeams; t++) {
    teamWrites.push(setDoc(teamDoc(sid, t), {
      claimed: false,
      claimedAt: null,
      claimedByUid: null,
      teamTokenHash: null,
    }));
  }

  // create round 1 config
  teamWrites.push(setDoc(roundDoc(sid, 1), {
    roundNumber: 1,
    visibility: params.round1Visibility,
    adEnabled: params.round1AdEnabled,
    adFee: DEFAULTS.defaultAdFee,
    adMult: DEFAULTS.defaultAdMult,
    startedAt: null,
    endsAt: null,
    closedAt: null,
  }));

  await Promise.all(teamWrites);

  return { sessionId: sid, joinCode: code };
}

// =========================
// Instructor auth (PIN check)
// =========================
async function instructorAuth(sessionId, pin) {
  const sref = sessionDoc(sessionId);
  const s = await getDoc(sref);
  if (!s.exists()) throw new Error("Session not found");
  const want = s.data().instructor?.pinHash;
  const got = await sha256Hex(pin);
  if (!want || want !== got) throw new Error("Incorrect PIN");
  instructorAuthed = true;
  return true;
}

async function getSessionIdFromJoinCode(code) {
  const qy = query(sessionsCol(), where("joinCode", "==", code));
  const snap = await getDocs(qy);
  if (snap.empty) return null;
  // should be 1
  return snap.docs[0].id;
}

// =========================
// Student claim team
// =========================
async function claimTeam(sessionId, teamNum) {
  const tok = crypto.randomUUID();
  const tokHash = await sha256Hex(tok);

  await runTransaction(db, async (tx) => {
    const sref = sessionDoc(sessionId);
    const tref = teamDoc(sessionId, teamNum);
    const [sSnap, tSnap] = await Promise.all([tx.get(sref), tx.get(tref)]);

    if (!sSnap.exists()) throw new Error("Session missing");
    const sdat = sSnap.data();
    if (sdat.joinLocked || sdat.status !== "lobby") throw new Error("Joining is locked");

    if (!tSnap.exists()) throw new Error("Team missing");
    const tdat = tSnap.data();
    if (tdat.claimed) throw new Error("Team already claimed");

    tx.update(tref, {
      claimed: true,
      claimedAt: serverTimestamp(),
      claimedByUid: uid,
      teamTokenHash: tokHash,
    });
  });

  localStorage.setItem(LS.teamToken(sessionId), tok);
  localStorage.setItem(LS.teamNumber(sessionId), String(teamNum));
  teamToken = tok;
  teamNumber = teamNum;
}

async function tryAutoRejoin(sessionId) {
  const tok = localStorage.getItem(LS.teamToken(sessionId));
  const tnum = localStorage.getItem(LS.teamNumber(sessionId));
  if (!tok || !tnum) return false;
  const tokHash = await sha256Hex(tok);
  const t = Number(tnum);
  const tSnap = await getDoc(teamDoc(sessionId, t));
  if (!tSnap.exists()) return false;
  const tdat = tSnap.data();
  if (!tdat.claimed || tdat.teamTokenHash !== tokHash) return false;
  teamToken = tok;
  teamNumber = t;
  return true;
}

// =========================
// Instructor controls
// =========================
async function releaseTeam(sessionId, teamNum) {
  if (!instructorAuthed) throw new Error("Not authed");
  await runTransaction(db, async (tx) => {
    const sref = sessionDoc(sessionId);
    const tref = teamDoc(sessionId, teamNum);
    const sSnap = await tx.get(sref);
    if (!sSnap.exists()) throw new Error("Session missing");
    const sdat = sSnap.data();
    if (sdat.currentRound > 0 || sdat.status !== "lobby") throw new Error("Cannot release after Round 1 starts");
    tx.update(tref, {
      claimed: false,
      claimedAt: null,
      claimedByUid: null,
      teamTokenHash: null,
    });
  });
}

async function startRound(sessionId, roundNum) {
  if (!instructorAuthed) throw new Error("Not authed");
  await runTransaction(db, async (tx) => {
    const sref = sessionDoc(sessionId);
    const rref = roundDoc(sessionId, roundNum);
    const sSnap = await tx.get(sref);
    const rSnap = await tx.get(rref);

    if (!sSnap.exists()) throw new Error("Session missing");
    const sdat = sSnap.data();
    if (sdat.status === "ended") throw new Error("Ended");
    if (!rSnap.exists()) throw new Error("Round config missing");

    const nowMs = Date.now();
    const endsMs = nowMs + (sdat.params.timerSec * 1000);

    tx.update(sref, {
      status: "round_active",
      joinLocked: true,
      currentRound: roundNum,
    });

    tx.update(rref, {
      startedAt: serverTimestamp(),
      endsAt: new Date(endsMs),
      closedAt: null,
    });
  });
}

async function closeRound(sessionId, roundNum) {
  if (!instructorAuthed) throw new Error("Not authed");
  // Mark closedAt; then assign missing submissions; then compute results.
  const sSnap = await getDoc(sessionDoc(sessionId));
  if (!sSnap.exists()) throw new Error("Session missing");
  const sdat = sSnap.data();

  await updateDoc(roundDoc(sessionId, roundNum), { closedAt: serverTimestamp() });

  // Ensure submissions exist (auto-assign max price, no ad)
  const subsSnap = await getDocs(submissionsCol(sessionId, roundNum));
  const have = new Set(subsSnap.docs.map(d => Number(d.id)));
  const writes = [];
  for (let t = 1; t <= sdat.params.nTeams; t++) {
    if (!have.has(t)) {
      writes.push(setDoc(submissionDoc(sessionId, roundNum, t), {
        teamNumber: t,
        price: sdat.params.pMax,
        ad: false,
        submissionType: "auto_assigned",
        submittedAt: serverTimestamp(),
      }));
    }
  }
  await Promise.all(writes);

  // compute results
  await computeAndStoreResults(sessionId, roundNum);

  // move session to between or ended
  if (roundNum >= sdat.params.rounds) {
    await updateDoc(sessionDoc(sessionId), { status: "ended" });
  } else {
    await updateDoc(sessionDoc(sessionId), { status: "between" });
  }
}

async function setNextRoundConfig(sessionId, nextRoundNum, cfg) {
  if (!instructorAuthed) throw new Error("Not authed");
  await setDoc(roundDoc(sessionId, nextRoundNum), {
    roundNumber: nextRoundNum,
    visibility: cfg.visibility,
    adEnabled: cfg.adEnabled,
    adFee: cfg.adFee,
    adMult: cfg.adMult,
    startedAt: null,
    endsAt: null,
    closedAt: null,
  }, { merge: true });
}

async function endGameEarly(sessionId) {
  if (!instructorAuthed) throw new Error("Not authed");
  await updateDoc(sessionDoc(sessionId), { status: "ended" });
}

// =========================
// Computation
// =========================
function median(values) {
  if (!values.length) return null;
  const a = [...values].sort((x,y)=>x-y);
  const mid = Math.floor(a.length/2);
  return a.length % 2 ? a[mid] : (a[mid-1] + a[mid])/2;
}

async function computeAndStoreResults(sessionId, roundNum) {
  const [sSnap, rSnap, subsSnap] = await Promise.all([
    getDoc(sessionDoc(sessionId)),
    getDoc(roundDoc(sessionId, roundNum)),
    getDocs(submissionsCol(sessionId, roundNum)),
  ]);
  const sdat = sSnap.data();
  const rdat = rSnap.data();

  const params = sdat.params;
  const adEnabled = !!rdat.adEnabled;
  const fee = Number(rdat.adFee || DEFAULTS.defaultAdFee);
  const mult = Number(rdat.adMult || DEFAULTS.defaultAdMult);

  const submissions = [];
  subsSnap.forEach(d => submissions.push({ teamNumber: Number(d.id), ...d.data() }));
  submissions.sort((a,b)=>a.teamNumber-b.teamNumber);

  const weights = submissions.map(s => {
    const p = Number(s.price);
    const base = 1 / Math.pow(p, Number(params.k));
    const w = adEnabled && s.ad ? base * mult : base;
    return w;
  });
  const wsum = weights.reduce((a,b)=>a+b,0);

  // compute per-team
  const res = submissions.map((s, idx) => {
    const share = wsum > 0 ? (weights[idx] / wsum) : (1 / params.nTeams);
    const q = share * Number(params.Q);
    const margin = Number(s.price) - Number(params.cost);
    const profit = q * margin - ((adEnabled && s.ad) ? fee : 0);
    return {
      teamNumber: s.teamNumber,
      price: Number(s.price),
      ad: !!s.ad,
      submissionType: s.submissionType || "user_confirmed",
      share,
      profitRound: profit,
    };
  });

  // cumulative
  // Sum prior stored results if any
  const cum = new Map();
  for (let r = 1; r < roundNum; r++) {
    const prevResSnap = await getDocs(resultsCol(sessionId, r));
    prevResSnap.forEach(d => {
      const t = Number(d.id);
      const v = d.data().profitRound || 0;
      cum.set(t, (cum.get(t) || 0) + v);
    });
  }
  res.forEach(x => cum.set(x.teamNumber, (cum.get(x.teamNumber) || 0) + x.profitRound));

  // ranks (round)
  const sortedRound = [...res].sort((a,b)=>b.profitRound-a.profitRound);
  const roundRank = new Map();
  let rank = 0;
  let prev = null;
  for (let i = 0; i < sortedRound.length; i++) {
    const p = sortedRound[i].profitRound;
    if (prev === null || p !== prev) rank = i + 1;
    roundRank.set(sortedRound[i].teamNumber, rank);
    prev = p;
  }

  // ranks (cum)
  const sortedCum = [...res].map(x => ({ teamNumber: x.teamNumber, profitCum: cum.get(x.teamNumber) }))
    .sort((a,b)=>b.profitCum-a.profitCum);
  const cumRank = new Map();
  rank = 0; prev = null;
  for (let i = 0; i < sortedCum.length; i++) {
    const p = sortedCum[i].profitCum;
    if (prev === null || p !== prev) rank = i + 1;
    cumRank.set(sortedCum[i].teamNumber, rank);
    prev = p;
  }

  // aggregates
  const prices = res.map(x => x.price);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const medP = median(prices);
  const topProfit = Math.max(...res.map(x => x.profitRound));

  const agg = {
    minPrice: minP,
    maxPrice: maxP,
    medianPrice: medP,
    topProfitRound: topProfit,
  };

  // write results
  const writes = [];
  res.forEach(x => {
    writes.push(setDoc(resultDoc(sessionId, roundNum, x.teamNumber), {
      teamNumber: x.teamNumber,
      price: x.price,
      ad: x.ad,
      submissionType: x.submissionType,
      share: x.share,
      profitRound: x.profitRound,
      profitCum: cum.get(x.teamNumber),
      rankRound: roundRank.get(x.teamNumber),
      rankCum: cumRank.get(x.teamNumber),
      aggregates: agg,
      visibility: rdat.visibility,
      adEnabled,
      adFee: fee,
      adMult: mult,
      computedAt: serverTimestamp(),
    }));
  });
  await Promise.all(writes);
}

// =========================
// Student submission
// =========================
async function submitTeam(sessionId, roundNum, teamNum, { price, ad }) {
  // Enforce: if advertising off, force ad=false; also enforce bounds & step.
  const [sSnap, rSnap] = await Promise.all([getDoc(sessionDoc(sessionId)), getDoc(roundDoc(sessionId, roundNum))]);
  const sdat = sSnap.data();
  const rdat = rSnap.data();

  const p = clampStep(Number(price), Number(sdat.params.pMin), Number(sdat.params.pMax), Number(sdat.params.pStep));
  const adEnabled = !!rdat.adEnabled;
  const finalAd = adEnabled ? !!ad : false;

  // One-shot: if exists already, do nothing
  await runTransaction(db, async (tx) => {
    const sref = sessionDoc(sessionId);
    const subref = submissionDoc(sessionId, roundNum, teamNum);
    const [ss, sub] = await Promise.all([tx.get(sref), tx.get(subref)]);
    if (!ss.exists()) throw new Error("Session missing");
    const sdat2 = ss.data();
    if (sdat2.status !== "round_active" || sdat2.currentRound !== roundNum) throw new Error("Round not active");
    if (sub.exists()) return; // already submitted
    tx.set(subref, {
      teamNumber: teamNum,
      price: p,
      ad: finalAd,
      submissionType: "user_confirmed",
      submittedAt: serverTimestamp(),
    });
  });

  return { price: p, ad: finalAd };
}

// =========================
// Export
// =========================
async function exportCSV(sessionId) {
  if (!instructorAuthed) throw new Error("Not authed");
  const sSnap = await getDoc(sessionDoc(sessionId));
  const sdat = sSnap.data();
  const R = sdat.currentRound;

  const rows = [];
  const header = [
    "session_id","round_number","team_number","submission_type","price","advertising","market_share","profit_round","profit_cumulative","rank_round","rank_cumulative"
  ];
  rows.push(header);

  for (let r = 1; r <= R; r++) {
    const rs = await getDocs(resultsCol(sessionId, r));
    const byTeam = rs.docs.map(d => d.data()).sort((a,b)=>a.teamNumber-b.teamNumber);
    for (const x of byTeam) {
      rows.push([
        sessionId,
        r,
        x.teamNumber,
        x.submissionType,
        x.price,
        x.ad ? 1 : 0,
        x.share,
        x.profitRound,
        x.profitCum,
        x.rankRound,
        x.rankCum,
      ]);
    }
  }

  const csv = rows.map(r => r.map(v => {
    const s = String(v ?? "");
    if (/[\",\n]/.test(s)) return '"' + s.replaceAll('"','""') + '"';
    return s;
  }).join(",")).join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pricing-game_${sessionId}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// =========================
// Rendering
// =========================
function renderTeamButtons(listEl, nTeams, claimedMap, { disabledAll=false, onClick=null, showRelease=false }) {
  listEl.innerHTML = "";
  for (let t = 1; t <= nTeams; t++) {
    const claimed = claimedMap.get(t) || false;
    const btn = document.createElement("div");
    btn.className = "team";
    btn.setAttribute("role","button");
    btn.setAttribute("tabindex","0");
    const disabled = disabledAll || claimed;
    btn.setAttribute("aria-disabled", disabled ? "true" : "false");
    btn.innerHTML = `<div class="t">Team ${t}</div><div class="s">${claimed ? "Claimed" : "Available"}</div>`;

    if (!disabled && onClick) {
      btn.addEventListener("click", () => onClick(t));
    }

    if (showRelease && claimed) {
      const rel = document.createElement("button");
      rel.className = "btn btn--ghost";
      rel.style.marginTop = "8px";
      rel.textContent = "Release";
      rel.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await releaseTeam(activeSessionId, t);
        } catch (err) {
          alert(err.message || String(err));
        }
      });
      btn.appendChild(rel);
    }

    listEl.appendChild(btn);
  }
}

function renderKV(el, obj) {
  el.innerHTML = "";
  for (const [k,v] of Object.entries(obj)) {
    const kk = document.createElement("div");
    kk.className = "k";
    kk.textContent = k;
    const vv = document.createElement("div");
    vv.className = "v";
    vv.textContent = v;
    el.appendChild(kk);
    el.appendChild(vv);
  }
}

function renderResultsTable(tableEl, rows, { showAd }) {
  const cols = [
    { key:"teamNumber", label:"Team" },
    { key:"price", label:"Price", fmt:(x)=>`$${fmtPrice1(x)}` },
  ];
  if (showAd) cols.push({ key:"ad", label:"Ad?", fmt:(x)=>x?"Yes":"No" });
  cols.push(
    { key:"share", label:"Share", fmt:(x)=>fmtPct2(x) },
    { key:"profitRound", label:"Profit (round)", fmt:(x)=>fmtMoney0(x) },
    { key:"profitCum", label:"Cumulative", fmt:(x)=>fmtMoney0(x) },
    { key:"rankRound", label:"Rank (round)" },
    { key:"rankCum", label:"Rank (overall)" },
  );

  tableEl.innerHTML = "";
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  cols.forEach(c => {
    const th = document.createElement("th");
    th.textContent = c.label;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  tableEl.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach(r => {
    const tr = document.createElement("tr");
    cols.forEach(c => {
      const td = document.createElement("td");
      const raw = r[c.key];
      td.textContent = c.fmt ? c.fmt(raw) : raw;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tableEl.appendChild(tbody);
}

function computeTimeLeftMs(endsAt) {
  if (!endsAt) return null;
  const end = endsAt.toDate ? endsAt.toDate().getTime() : new Date(endsAt).getTime();
  return Math.max(0, end - Date.now());
}

function formatMMSS(ms) {
  const s = Math.ceil(ms/1000);
  const m = Math.floor(s/60);
  const ss = String(s%60).padStart(2,"0");
  return `${m}:${ss}`;
}

let timerInterval = null;
function startTimerLoop(endsAt) {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(()=>{
    const left = computeTimeLeftMs(endsAt);
    if (left === null) return;
    $("timerBig").textContent = formatMMSS(left);
    if (left <= 0) {
      $("timerNote").textContent = "Time is up. Close the round if it doesn't auto-close.";
    } else {
      $("timerNote").textContent = "";
    }
  }, 200);
}

// =========================
// Subscriptions / route handling
// =========================
async function subscribeSession(sessionId) {
  cleanupSubs();
  activeSessionId = sessionId;

  sessionUnsub = onSnapshot(sessionDoc(sessionId), async (snap) => {
    if (!snap.exists()) return;
    lastSessionDoc = snap.data();
    const sdat = lastSessionDoc;

    // route rendering depends on role
    if (role === "instructor") {
      if (!instructorAuthed) return; // waiting for PIN auth screen

      if (sdat.status === "lobby") {
        await renderInstructorLobby(sdat);
      } else if (sdat.status === "round_active") {
        await renderInstructorRound(sdat);
      } else if (sdat.status === "between") {
        await renderInstructorBetween(sdat);
      } else if (sdat.status === "ended") {
        await renderInstructorFinal(sdat);
      }
    }

    if (role === "student") {
      if (!teamNumber) {
        // still claiming
        await renderStudentClaim(sdat);
        return;
      }
      // student state transitions
      if (sdat.status === "lobby") {
        await renderStudentLobby(sdat);
      } else if (sdat.status === "round_active") {
        await renderStudentRound(sdat);
      } else if (sdat.status === "between") {
        await renderStudentResults(sdat);
      } else if (sdat.status === "ended") {
        await renderStudentFinal(sdat);
      }
    }
  });
}

async function renderInstructorLobby(sdat) {
  hideAllScreens();
  show("screenInstructorLobby");

  $("joinCodeBig").textContent = sdat.joinCode;
  const joinUrl = `${location.origin}${location.pathname}#student?code=${encodeURIComponent(sdat.joinCode)}`;
  $("joinUrl").textContent = joinUrl;

  // QR
  const qr = new QRious({
    element: $("qrCanvas"),
    value: joinUrl,
    size: 256,
    background: "white",
    foreground: "black",
  });
  void(qr);

  // teams
  const nTeams = sdat.params.nTeams;
  const claimedMap = new Map();
  const tSnap = await getDocs(teamsCol(activeSessionId));
  tSnap.forEach(d => claimedMap.set(Number(d.id), !!d.data().claimed));
  const claimedCount = [...claimedMap.values()].filter(Boolean).length;
  $("lobbyStatus").textContent = `${claimedCount}/${nTeams} teams claimed.`;

  renderTeamButtons($("instructorTeamList"), nTeams, claimedMap, { showRelease: true });
}

async function renderInstructorRound(sdat) {
  hideAllScreens();
  show("screenInstructorRound");

  const r = sdat.currentRound;
  const rSnap = await getDoc(roundDoc(activeSessionId, r));
  const rdat = rSnap.data();
  $("instructorRoundHeader").textContent = `Round ${r} of ${sdat.params.rounds} • Visibility: ${rdat.visibility === "full" ? "Full" : "Private"} • Advertising: ${rdat.adEnabled ? `ON (fee $${rdat.adFee}, ×${rdat.adMult})` : "OFF"}`;

  startTimerLoop(rdat.endsAt);

  submissionsUnsub?.();
  submissionsUnsub = onSnapshot(submissionsCol(activeSessionId, r), async (snap) => {
    const submittedTeams = new Set(snap.docs.map(d => Number(d.id)));
    const nTeams = sdat.params.nTeams;
    const missing = [];
    for (let t = 1; t <= nTeams; t++) if (!submittedTeams.has(t)) missing.push(t);

    renderKV($("submissionStats"), {
      "Submitted": `${submittedTeams.size} / ${nTeams}`,
      "Remaining": String(missing.length),
    });

    $("missingTeams").innerHTML = "";
    missing.forEach(t => {
      const c = document.createElement("div");
      c.className = "chip";
      c.textContent = `Team ${t}`;
      $("missingTeams").appendChild(c);
    });
  });
}

async function renderInstructorBetween(sdat) {
  hideAllScreens();
  show("screenInstructorBetween");

  const r = sdat.currentRound;
  $("betweenHeader").textContent = `Round ${r} complete • Configure Round ${r+1}`;

  // Show results table (always for instructor)
  const rs = await getDocs(resultsCol(activeSessionId, r));
  const rows = rs.docs.map(d => d.data()).sort((a,b)=>a.rankRound-b.rankRound || a.teamNumber-b.teamNumber);
  const adEnabled = rows[0]?.adEnabled ?? false;
  renderResultsTable($("instructorResultsTable"), rows, { showAd: adEnabled });

  // Set defaults for next round config
  const next = r + 1;
  if (next <= sdat.params.rounds) {
    const nextSnap = await getDoc(roundDoc(activeSessionId, next));
    const nextData = nextSnap.exists() ? nextSnap.data() : null;
    $("nextVisibility").value = nextData?.visibility || "private";
    $("nextAdEnabled").checked = !!nextData?.adEnabled;
    $("nextAdFee").value = nextData?.adFee ?? DEFAULTS.defaultAdFee;
    $("nextAdMult").value = nextData?.adMult ?? DEFAULTS.defaultAdMult;
    $("nextAdFields").hidden = !$("nextAdEnabled").checked;
  }
}

async function renderInstructorFinal(sdat) {
  hideAllScreens();
  show("screenInstructorFinal");

  $("finalHeader").textContent = `Completed rounds: ${sdat.currentRound} of ${sdat.params.rounds}`;

  // Use latest available results to build final table
  const R = sdat.currentRound;
  if (R === 0) {
    $("instructorFinalTable").innerHTML = "";
    $("finalHelp").textContent = "No rounds were completed.";
    return;
  }

  const rs = await getDocs(resultsCol(activeSessionId, R));
  const rows = rs.docs.map(d => d.data()).sort((a,b)=>a.rankCum-b.rankCum || a.teamNumber-b.teamNumber);
  renderResultsTable($("instructorFinalTable"), rows, { showAd: false });
}

async function renderStudentClaim(sdat) {
  hideAllScreens();
  show("screenStudentClaim");

  $("studentSessionBadge").textContent = `Join code: ${sdat.joinCode}`;

  const joinLocked = sdat.joinLocked || sdat.status !== "lobby";
  $("joinLockedNotice").hidden = !joinLocked;

  // fetch team claims
  const tSnap = await getDocs(teamsCol(activeSessionId));
  const claimedMap = new Map();
  tSnap.forEach(d => claimedMap.set(Number(d.id), !!d.data().claimed));

  renderTeamButtons($("teamList"), sdat.params.nTeams, claimedMap, {
    disabledAll: joinLocked,
    onClick: async (t) => {
      try {
        await claimTeam(activeSessionId, t);
        // Immediately transition UI after a successful claim
        await renderStudentLobby(lastSessionDoc);
      } catch (err) {
        alert(err.message || String(err));
      }
    }
  });
}

async function renderStudentLobby(sdat) {
  hideAllScreens();
  show("screenStudentLobby");
  $("studentTeamLabel").textContent = `Team ${teamNumber}`;
  $("studentConnection").textContent = "";
}

async function renderStudentRound(sdat) {
  hideAllScreens();
  show("screenStudentRound");

  const r = sdat.currentRound;
  const rSnap = await getDoc(roundDoc(activeSessionId, r));
  const rdat = rSnap.data();

  const header = [`Round ${r} of ${sdat.params.rounds}`];
  if (rdat.adEnabled) header.push(`Advertising ON: Fee $${rdat.adFee}, Boost ×${rdat.adMult}`);
  else header.push("Advertising OFF");
  $("studentRoundHeader").textContent = header.join(" • ");

  $("priceBoundsLabel").textContent = `Allowed: $${fmtPrice1(sdat.params.pMin)} to $${fmtPrice1(sdat.params.pMax)} (step ${sdat.params.pStep})`;

  // ad toggle visibility
  if (rdat.adEnabled) {
    $("adBlock").hidden = false;
    $("adOffNotice").hidden = true;
    $("adDetails").textContent = `Fee $${rdat.adFee}. Weight multiplier ×${rdat.adMult}.`;
  } else {
    $("adBlock").hidden = true;
    $("adOffNotice").hidden = true; // hide entirely per requirement
  }

  // check if already submitted
  const subSnap = await getDoc(submissionDoc(activeSessionId, r, teamNumber));
  if (subSnap.exists()) {
    await renderStudentSubmitted(sdat);
    return;
  }

  // default price input
  if (!$("priceInput").value) $("priceInput").value = fmtPrice1(sdat.params.pMin);

  $("submitHelp").textContent = "Submit once. You will be asked to confirm.";
}

async function renderStudentSubmitted(sdat) {
  hideAllScreens();
  show("screenStudentSubmitted");
  $("submittedTeam").textContent = String(teamNumber);

  const r = sdat.currentRound;
  const subSnap = await getDoc(submissionDoc(activeSessionId, r, teamNumber));
  const sub = subSnap.data();
  const adStr = sub.ad ? "Yes" : "No";
  $("submittedSummary").textContent = `Submitted: $${fmtPrice1(sub.price)} • Advertising: ${adStr}`;
}

async function renderStudentResults(sdat) {
  hideAllScreens();
  show("screenStudentResults");

  const r = sdat.currentRound;
  $("studentResultsHeader").textContent = `Round ${r} of ${sdat.params.rounds} results`;

  const yourSnap = await getDoc(resultDoc(activeSessionId, r, teamNumber));
  if (!yourSnap.exists()) {
    renderKV($("yourResult"), { "Status": "Results not available yet." });
    return;
  }
  const y = yourSnap.data();

  renderKV($("yourResult"), {
    "Team": `Team ${y.teamNumber}`,
    "Price": `$${fmtPrice1(y.price)}`,
    ...(y.adEnabled ? { "Advertising": y.ad ? "Yes" : "No" } : {}),
    "Market share": fmtPct2(y.share),
    "Profit (round)": fmtMoney0(y.profitRound),
    "Cumulative profit": fmtMoney0(y.profitCum),
    "Rank (round)": String(y.rankRound),
    "Rank (overall)": String(y.rankCum),
    ...(y.submissionType === "auto_assigned" ? { "Note": "Auto-assigned (no submission)" } : {}),
  });

  const agg = y.aggregates || {};
  renderKV($("marketAgg"), {
    "Min price": agg.minPrice != null ? `$${fmtPrice1(agg.minPrice)}` : "—",
    "Max price": agg.maxPrice != null ? `$${fmtPrice1(agg.maxPrice)}` : "—",
    "Median price": agg.medianPrice != null ? `$${fmtPrice1(agg.medianPrice)}` : "—",
    "Top profit (round)": agg.topProfitRound != null ? fmtMoney0(agg.topProfitRound) : "—",
  });

  // full table if round visibility is full
  if (y.visibility === "full") {
    $("fullTablePanel").hidden = false;
    const rs = await getDocs(resultsCol(activeSessionId, r));
    const rows = rs.docs.map(d => d.data()).sort((a,b)=>a.rankRound-b.rankRound || a.teamNumber-b.teamNumber);
    renderResultsTable($("fullResultsTable"), rows, { showAd: y.adEnabled });
  } else {
    $("fullTablePanel").hidden = true;
  }
}

async function renderStudentFinal(sdat) {
  hideAllScreens();
  show("screenStudentFinal");

  const R = sdat.currentRound;
  if (R === 0) {
    $("finalTable").innerHTML = "";
    return;
  }
  const rs = await getDocs(resultsCol(activeSessionId, R));
  const rows = rs.docs.map(d => d.data()).sort((a,b)=>a.rankCum-b.rankCum || a.teamNumber-b.teamNumber);
  renderResultsTable($("finalTable"), rows, { showAd: false });
}

// =========================
// Navigation and event wiring
// =========================
function wireUI() {
  $("btnHome").addEventListener("click", () => { cleanupSubs(); role=""; instructorAuthed=false; teamNumber=null; activeSessionId=null; setHashRoute("home"); });

  // home
  $("btnStudent").addEventListener("click", () => setHashRoute("student"));
  $("btnInstructor").addEventListener("click", () => setHashRoute("instructor"));

  // student
  $("btnStudentBack").addEventListener("click", ()=> setHashRoute("home"));
  $("btnStudentJoin").addEventListener("click", async ()=> {
    const code = $("studentJoinCode").value.trim().toUpperCase();
    if (!code) return;
    const sid = await getSessionIdFromJoinCode(code);
    if (!sid) { alert("Join code not found"); return; }
    role = "student";
    joinCode = code;
    // try auto rejoin
    await subscribeSession(sid);
    const ok = await tryAutoRejoin(sid);
    if (ok) {
      // session snapshot will render
    } else {
      // will show claim screen
    }
  });
  $("btnStudentLeave").addEventListener("click", ()=> setHashRoute("home"));

  // student submit
  $("btnSubmit").addEventListener("click", async ()=> {
    const sdat = lastSessionDoc;
    if (!sdat || sdat.status !== "round_active") return;
    const r = sdat.currentRound;
    const rSnap = await getDoc(roundDoc(activeSessionId, r));
    const rdat = rSnap.data();

    const rawPrice = Number($("priceInput").value);
    if (!Number.isFinite(rawPrice)) { alert("Enter a valid price"); return; }

    const p = clampStep(rawPrice, sdat.params.pMin, sdat.params.pMax, sdat.params.pStep);
    const ad = rdat.adEnabled ? $("adToggle").checked : false;

    // confirm modal
    const sum = {
      "Team": `Team ${teamNumber}`,
      "Price": `$${fmtPrice1(p)}`,
      ...(rdat.adEnabled ? { "Advertising": ad ? "Yes" : "No" } : {}),
    };
    renderKV($("confirmSummary"), sum);

    const dlg = $("confirmSubmitDialog");
    dlg.showModal();

    const onClose = async () => {
      dlg.removeEventListener("close", onClose);
      if (dlg.returnValue !== "confirm") return;
      try {
        const out = await submitTeam(activeSessionId, r, teamNumber, { price: p, ad });
        $("submittedSummary").textContent = `Submitted: $${fmtPrice1(out.price)} • Advertising: ${out.ad ? "Yes" : "No"}`;
      } catch (err) {
        alert(err.message || String(err));
      }
    };
    dlg.addEventListener("close", onClose);
  });

  // instructor
  $("btnInstructorBack").addEventListener("click", ()=> setHashRoute("home"));
  $("btnCreateSession").addEventListener("click", ()=> setHashRoute("create"));

  $("btnOpenSession").addEventListener("click", async ()=> {
    const code = $("instructorJoinCode").value.trim().toUpperCase();
    const pin = $("instructorPIN").value.trim();
    if (!code || !pin) return;
    const sid = await getSessionIdFromJoinCode(code);
    if (!sid) { $("instructorOpenHelp").textContent = "Join code not found."; return; }
    try {
      await instructorAuth(sid, pin);
      role = "instructor";
      joinCode = code;
      await subscribeSession(sid);
    } catch (err) {
      $("instructorOpenHelp").textContent = err.message || String(err);
    }
  });

  // create session inputs init
  $("btnCreateConfirm").addEventListener("click", async ()=> {
    const pin = $("createPIN").value.trim();
    if (!pin) { $("createHelp").textContent = "PIN required."; return; }

    const params = {
      nTeams: Number($("createN").value),
      rounds: Number($("createR").value),
      timerSec: Number($("createT").value),
      pMin: Number($("createPmin").value),
      pMax: Number($("createPmax").value),
      pStep: Number($("createStep").value),
      cost: Number($("createC").value),
      Q: Number($("createQ").value),
      k: Number($("createK").value),
      round1Visibility: $("createFullDefault").checked ? "full" : "private",
      round1AdEnabled: false,
    };

    try {
      const out = await createSession({ pin, params });
      // auto open instructor view
      await instructorAuth(out.sessionId, pin);
      role = "instructor";
      joinCode = out.joinCode;
      await subscribeSession(out.sessionId);
      setHashRoute("instructor", { code: out.joinCode });
    } catch (err) {
      $("createHelp").textContent = err.message || String(err);
    }
  });
  $("btnCreateCancel").addEventListener("click", ()=> setHashRoute("instructor"));

  // instructor lobby
  $("btnStartRound1").addEventListener("click", async ()=> {
    try {
      await startRound(activeSessionId, 1);
    } catch (err) { alert(err.message || String(err)); }
  });

  // instructor round
  $("btnCloseEarly").addEventListener("click", async ()=> {
    try {
      const r = lastSessionDoc.currentRound;
      await closeRound(activeSessionId, r);
    } catch (err) { alert(err.message || String(err)); }
  });

  // between rounds
  $("nextAdEnabled").addEventListener("change", ()=> {
    $("nextAdFields").hidden = !$("nextAdEnabled").checked;
  });

  $("btnStartNext").addEventListener("click", async ()=> {
    try {
      const sdat = lastSessionDoc;
      const next = sdat.currentRound + 1;
      if (next > sdat.params.rounds) return;
      const cfg = {
        visibility: $("nextVisibility").value,
        adEnabled: $("nextAdEnabled").checked,
        adFee: Number($("nextAdFee").value || DEFAULTS.defaultAdFee),
        adMult: Number($("nextAdMult").value || DEFAULTS.defaultAdMult),
      };
      await setNextRoundConfig(activeSessionId, next, cfg);
      await startRound(activeSessionId, next);
    } catch (err) { alert(err.message || String(err)); }
  });

  $("btnEndEarly").addEventListener("click", ()=> {
    $("confirmEndDialog").showModal();
  });
  $("confirmEndBtn").addEventListener("click", async ()=> {
    try {
      await endGameEarly(activeSessionId);
    } catch (err) { alert(err.message || String(err)); }
  });

  $("btnExport").addEventListener("click", async ()=> {
    try {
      await exportCSV(activeSessionId);
      $("exportHelp").textContent = "Export downloaded.";
    } catch (err) { $("exportHelp").textContent = err.message || String(err); }
  });

  $("btnFinalExport").addEventListener("click", async ()=> {
    try {
      await exportCSV(activeSessionId);
      $("finalHelp").textContent = "Export downloaded.";
    } catch (err) { $("finalHelp").textContent = err.message || String(err); }
  });

  $("btnResetReplay").addEventListener("click", ()=> {
    // simplest: go back to create screen
    setHashRoute("create");
  });
}

function initCreateDefaults() {
  $("createN").value = DEFAULTS.nTeams;
  $("createR").value = DEFAULTS.rounds;
  $("createT").value = DEFAULTS.timerSec;
  $("createPmin").value = DEFAULTS.pMin;
  $("createPmax").value = DEFAULTS.pMax;
  $("createStep").value = DEFAULTS.pStep;
  $("createC").value = DEFAULTS.cost;
  $("createQ").value = DEFAULTS.Q;
  $("createK").value = DEFAULTS.k;
  $("createFullDefault").checked = (DEFAULTS.round1Visibility === "full");
}

async function handleRoute() {
  const { route, params } = parseHash();
  hideAllScreens();

  if (route === "home") {
    role = "";
    instructorAuthed = false;
    show("screenHome");
    return;
  }

  if (route === "student") {
    role = "student";
    show("screenStudentJoin");
    const code = params.get("code");
    if (code) $("studentJoinCode").value = code.toUpperCase();
    return;
  }

  if (route === "instructor") {
    role = "instructor";
    show("screenInstructorPIN");
    const code = params.get("code");
    if (code) $("instructorJoinCode").value = code.toUpperCase();
    return;
  }

  if (route === "create") {
    role = "instructor";
    show("screenInstructorCreate");
    initCreateDefaults();
    return;
  }

  // fallback
  show("screenHome");
}

// =========================
// Boot
// =========================
async function boot() {
  wireUI();

  onAuthStateChanged(auth, async (u) => {
    if (u) {
      uid = u.uid;
      setEnvConnected(true);
      hide("screenLoading");
      await handleRoute();
    }
  });

  await signInAnonymously(auth);

  window.addEventListener("hashchange", async () => {
    cleanupSubs();
    teamNumber = null;
    teamToken = null;
    activeSessionId = null;
    instructorAuthed = false;
    await handleRoute();
  });
}

hideAllScreens();
show("screenLoading");
boot();
