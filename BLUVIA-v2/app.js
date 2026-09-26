/* ==========================================================================
   BLUVIA — lógica de la aplicación
   Los datos viven en IndexedDB (mucho más resistente que localStorage a que
   el navegador los borre solo). Además hay copia de seguridad manual
   (exportar/importar un .json) para no depender de un solo dispositivo.
   ========================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* 1. CONFIGURACIÓN Y CATEGORÍAS                                       */
  /* ------------------------------------------------------------------ */

  const CATEGORIES = {
    tarea:       { icon: "✅", label: "Tarea",              group: "Personal" },
    recordatorio:{ icon: "⏰", label: "Recordatorio",        group: "Recordatorio" },
    turno:       { icon: "📅", label: "Turno / Evento",      group: "Personal" },
    medicamento: { icon: "💊", label: "Medicamento",         group: "Recordatorio" },
    idea:        { icon: "💡", label: "Idea",                group: "Idea" },
    trabajo:     { icon: "💼", label: "Trabajo",             group: "Trabajo" },
    mia:         { icon: "👩‍👧", label: "Mia",               group: "Mia" },
    ninera:      { icon: "👩‍🍼", label: "Niñera",            group: "Niñera" },
    cumpleanos:  { icon: "🎁", label: "Cumpleaños / Regalo", group: "Regalo" },
  };

  const CATEGORY_COLORS = {
    tarea: "#5B6172", recordatorio: "#F5A623", turno: "#3D6BE0", medicamento: "#FF6B4A",
    idea: "#E0B324", trabajo: "#22307E", mia: "#8A5CF6", ninera: "#2BB3A3", cumpleanos: "#E85D9E",
  };

  const WEEKDAYS = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  const MONTHS = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

  const LS_KEYS = {
    notified: "bluvia_notified",
    bannerDismissed: "bluvia_notif_banner_dismissed",
    productHistory: "bluvia_product_history",
  };

  const COMMON_PRODUCTS = [
    "Leche", "Pan", "Huevos", "Papel higiénico", "Detergente", "Jabón",
    "Yerba", "Azúcar", "Aceite", "Arroz", "Fideos", "Pilas AA", "Pilas AAA",
    "Shampoo", "Acondicionador", "Lavandina", "Papas", "Manzanas", "Bananas",
    "Tomate", "Cebolla", "Pollo", "Carne picada", "Queso", "Yogur", "Manteca",
    "Café", "Té", "Servilletas", "Bolsas de residuo", "Esponja", "Lampazo",
    "Desodorante", "Pasta dental", "Toallitas húmedas", "Pañales", "Agua mineral",
  ];

  const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

  /* ------------------------------------------------------------------ */
  /* 2. localStorage seguro — solo para preferencias menores del navegador */
  /* (nunca para tareas/listas: eso vive en IndexedDB, ver más abajo)      */
  /* ------------------------------------------------------------------ */

  function lsGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function lsSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }
  function lsGetRaw(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSetRaw(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  /* ------------------------------------------------------------------ */
  /* 3. CAPA DE DATOS: IndexedDB                                          */
  /* ------------------------------------------------------------------ */

  const DB_NAME = "bluvia_db";
  const DB_VERSION = 1;
  let idb = null;

  function openIDB() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) { reject(new Error("IndexedDB no disponible")); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains("items")) d.createObjectStore("items", { keyPath: "id" });
        if (!d.objectStoreNames.contains("lists")) d.createObjectStore("lists", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function idbGetAll(storeName) {
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  function idbPut(storeName, value) {
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  function idbDelete(storeName, id) {
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  function idbClear(storeName) {
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(storeName, "readwrite");
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 4. UTILIDADES DE FECHA                                              */
  /* ------------------------------------------------------------------ */

  function toISODate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function todayISO() { return toISODate(new Date()); }
  function addDaysISO(iso, days) {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + days);
    return toISODate(d);
  }
  function formatDateHuman(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    return `${WEEKDAYS[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
  }
  function formatDateShort(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
  }
  function formatHeaderDate() {
    const d = new Date();
    return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
  }
  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function parseQuickDate(text) {
    const t = text.toLowerCase();
    const norm = t.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (/pasado\s*manana/.test(norm)) return { date: addDaysISO(todayISO(), 2), label: "pasado mañana" };
    if (/\bmanana\b/.test(norm)) return { date: addDaysISO(todayISO(), 1), label: "mañana" };
    if (/\bhoy\b/.test(norm)) return { date: todayISO(), label: "hoy" };
    const enDias = norm.match(/en\s+(\d{1,2})\s+dias?/);
    if (enDias) {
      const n = parseInt(enDias[1], 10);
      return { date: addDaysISO(todayISO(), n), label: `en ${n} día${n === 1 ? "" : "s"}` };
    }
    for (let i = 0; i < WEEKDAYS.length; i++) {
      const wdNorm = WEEKDAYS[i].normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (new RegExp(`\\b${wdNorm}\\b`).test(norm)) {
        const todayDow = new Date().getDay();
        let diff = (i - todayDow + 7) % 7;
        if (diff === 0) diff = 7;
        return { date: addDaysISO(todayISO(), diff), label: WEEKDAYS[i] };
      }
    }
    return null;
  }
  function daysAgoLabel(iso) {
    if (!iso) return "Eliminado";
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days <= 0) return "Eliminado hoy";
    if (days === 1) return "Eliminado hace 1 día";
    return `Eliminado hace ${days} días`;
  }

  /* ------------------------------------------------------------------ */
  /* 5. ESTADO EN MEMORIA                                                */
  /* ------------------------------------------------------------------ */

  let items = [];
  let lists = [];

  let calCursor = new Date();
  let calSelectedISO = todayISO();
  let activeListId = null;
  let listFilter = "todos";
  let activeCategory = null;
  let trashOpen = false;
  let activeDetailId = null;
  let selectedChipCat = "tarea";
  let editingItemId = null;

  function visibleItems() { return items.filter(i => !i.trashed); }
  function visibleLists() { return lists.filter(l => !l.trashed); }

  /* ---------- helpers de persistencia (mutan el array en memoria Y guardan) */

  async function saveItem(item) {
    items = items.some(i => i.id === item.id) ? items.map(i => i.id === item.id ? item : i) : [...items, item];
    try { await idbPut("items", item); } catch (e) { console.error(e); showToast("No se pudo guardar. Probá de nuevo."); }
  }
  async function deleteItemForever(id) {
    items = items.filter(i => i.id !== id);
    try { await idbDelete("items", id); } catch (e) { console.error(e); }
  }
  function softDeleteItem(id) {
    const item = items.find(i => i.id === id);
    if (!item) return;
    saveItem({ ...item, trashed: true, trashedAt: new Date().toISOString() });
  }
  function restoreItem(id) {
    const item = items.find(i => i.id === id);
    if (!item) return;
    saveItem({ ...item, trashed: false, trashedAt: null });
  }

  async function saveList(list) {
    lists = lists.some(l => l.id === list.id) ? lists.map(l => l.id === list.id ? list : l) : [...lists, list];
    try { await idbPut("lists", list); } catch (e) { console.error(e); showToast("No se pudo guardar. Probá de nuevo."); }
  }
  async function deleteListForever(id) {
    lists = lists.filter(l => l.id !== id);
    try { await idbDelete("lists", id); } catch (e) { console.error(e); }
  }
  function softDeleteList(id) {
    const list = lists.find(l => l.id === id);
    if (!list) return;
    if (activeListId === id) activeListId = null;
    saveList({ ...list, trashed: true, trashedAt: new Date().toISOString() });
  }
  function restoreList(id) {
    const list = lists.find(l => l.id === id);
    if (!list) return;
    saveList({ ...list, trashed: false, trashedAt: null });
  }

  function purgeOldTrash() {
    const cutoff = Date.now() - TRASH_RETENTION_MS;
    items.filter(i => i.trashed && i.trashedAt && new Date(i.trashedAt).getTime() < cutoff).forEach(i => deleteItemForever(i.id));
    lists.filter(l => l.trashed && l.trashedAt && new Date(l.trashedAt).getTime() < cutoff).forEach(l => deleteListForever(l.id));
  }

  /* ------------------------------------------------------------------ */
  /* 6. RENDER                                                           */
  /* ------------------------------------------------------------------ */

  function metaLabel(item) {
    const cat = CATEGORIES[item.category] || { group: "Personal" };
    const isToday = item.date === todayISO();
    if (item.time) return `${item.time} · ${cat.group}`;
    if (item.date && isToday) return `Hoy · ${cat.group}`;
    if (item.status === "completado") return `Completado · ${cat.group}`;
    return `Pendiente · ${cat.group}`;
  }

  function buildItemCard(item, opts) {
    opts = opts || {};
    const cat = CATEGORIES[item.category] || { icon: "📌" };
    const el = document.createElement("div");
    el.className = "item-card" + (item.status === "completado" ? " done" : "") + (opts.overdue ? " overdue" : "");
    el.style.setProperty("--cat-color", CATEGORY_COLORS[item.category] || "var(--border)");
    el.dataset.id = item.id;
    el.innerHTML = `
      <button class="item-check" aria-label="Marcar completado">
        <svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="item-icon">${cat.icon}</div>
      <div class="item-main">
        <div class="item-title"></div>
        <div class="item-meta"></div>
      </div>
      <div class="item-chevron">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
    `;
    el.querySelector(".item-title").textContent = item.title;
    el.querySelector(".item-meta").textContent = opts.metaOverride || metaLabel(item);
    el.querySelector(".item-check").addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.status !== "completado") {
        el.classList.add("completing");
        setTimeout(() => toggleComplete(item.id), 260);
      } else {
        toggleComplete(item.id);
      }
    });
    el.addEventListener("click", () => openDetail(item.id));
    return el;
  }

  function renderHome() {
    document.getElementById("home-date").textContent = formatHeaderDate();
    updateNotifBanner();

    const today = todayISO();
    const vis = visibleItems();

    const overdue = vis.filter(i => i.status !== "completado" && i.date && i.date < today)
      .sort((a, b) => a.date.localeCompare(b.date));
    const sectionOverdue = document.getElementById("section-overdue");
    const listOverdue = document.getElementById("list-overdue");
    listOverdue.innerHTML = "";
    if (overdue.length === 0) {
      sectionOverdue.hidden = true;
    } else {
      sectionOverdue.hidden = false;
      document.getElementById("overdue-count").textContent = overdue.length;
      overdue.forEach(i => {
        const card = buildItemCard(i, { overdue: true, metaOverride: `${formatDateShort(i.date)}${i.time ? " · " + i.time : ""} · atrasada` });
        listOverdue.appendChild(card);
      });
    }

    const allToday = vis.filter(i => i.date === today);
    const progress = document.getElementById("today-progress");
    if (allToday.length > 0) {
      const done = allToday.filter(i => i.status === "completado").length;
      progress.hidden = false;
      document.getElementById("today-progress-fill").style.width = `${Math.round((done / allToday.length) * 100)}%`;
      document.getElementById("today-progress-label").textContent = `${done}/${allToday.length} completadas hoy`;
    } else {
      progress.hidden = true;
    }

    const pendingToday = vis.filter(i => i.status !== "completado" && i.date === today)
      .sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));

    const listToday = document.getElementById("list-today");
    const emptyToday = document.getElementById("empty-today");
    listToday.innerHTML = "";
    document.getElementById("today-count").textContent = pendingToday.length;
    if (pendingToday.length === 0) {
      emptyToday.hidden = false;
    } else {
      emptyToday.hidden = true;
      pendingToday.forEach(i => listToday.appendChild(buildItemCard(i)));
    }

    const upcoming = vis
      .filter(i => i.status !== "completado" && i.date && i.date > today)
      .sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")))
      .slice(0, 8);

    const listUp = document.getElementById("list-upcoming");
    const emptyUp = document.getElementById("empty-upcoming");
    listUp.innerHTML = "";
    if (upcoming.length === 0) {
      emptyUp.hidden = false;
    } else {
      emptyUp.hidden = true;
      upcoming.forEach(i => {
        const card = buildItemCard(i, { metaOverride: `${formatDateShort(i.date)}${i.time ? " · " + i.time : ""} · ${(CATEGORIES[i.category] || {}).group || ""}` });
        listUp.appendChild(card);
      });
    }

    const noDate = vis.filter(i => i.status !== "completado" && !i.date);
    const sectionNoDate = document.getElementById("section-nodate");
    const listNoDate = document.getElementById("list-nodate");
    listNoDate.innerHTML = "";
    if (noDate.length === 0) {
      sectionNoDate.hidden = true;
    } else {
      sectionNoDate.hidden = false;
      document.getElementById("nodate-count").textContent = noDate.length;
      noDate.forEach(i => listNoDate.appendChild(buildItemCard(i, { metaOverride: `${(CATEGORIES[i.category] || {}).group || ""} · sin fecha` })));
    }
  }

  function renderCalendar() {
    const label = `${MONTHS[calCursor.getMonth()]} ${calCursor.getFullYear()}`;
    document.getElementById("cal-month-label").textContent = label;

    const grid = document.getElementById("calendar-grid");
    grid.innerHTML = "";

    const year = calCursor.getFullYear();
    const month = calCursor.getMonth();
    const firstOfMonth = new Date(year, month, 1);
    let startOffset = firstOfMonth.getDay() - 1;
    if (startOffset < 0) startOffset = 6;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();

    const vis = visibleItems();
    const categoriesByDate = new Map();
    vis.filter(i => i.date).forEach(i => {
      if (!categoriesByDate.has(i.date)) categoriesByDate.set(i.date, new Set());
      categoriesByDate.get(i.date).add(i.category);
    });

    const cells = [];
    for (let i = 0; i < startOffset; i++) cells.push({ day: daysInPrevMonth - startOffset + 1 + i, outside: true, iso: null });
    for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, outside: false, iso: toISODate(new Date(year, month, d)) });
    while (cells.length % 7 !== 0) cells.push({ day: cells.length - (startOffset + daysInMonth) + 1, outside: true, iso: null });

    cells.forEach(c => {
      const cell = document.createElement("div");
      cell.className = "cal-cell";
      if (c.outside) cell.classList.add("outside");
      if (c.iso === todayISO()) cell.classList.add("today");
      if (c.iso === calSelectedISO) cell.classList.add("selected");
      cell.innerHTML = `<span>${c.day}</span>`;
      if (c.iso && categoriesByDate.has(c.iso)) {
        const cats = [...categoriesByDate.get(c.iso)].slice(0, 3);
        const dotsWrap = document.createElement("span");
        dotsWrap.className = "cal-dots";
        cats.forEach(cat => {
          const dot = document.createElement("span");
          dot.className = "cal-dot";
          dot.style.background = c.iso === calSelectedISO ? "#fff" : (CATEGORY_COLORS[cat] || "var(--accent)");
          dotsWrap.appendChild(dot);
        });
        cell.appendChild(dotsWrap);
      }
      if (c.iso) cell.addEventListener("click", () => { calSelectedISO = c.iso; renderCalendar(); });
      grid.appendChild(cell);
    });

    document.getElementById("cal-day-label").textContent = calSelectedISO ? capitalize(formatDateHuman(calSelectedISO)) : "Seleccioná un día";

    const dayItems = vis.filter(i => i.date === calSelectedISO).sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
    const listDay = document.getElementById("list-day");
    const emptyDay = document.getElementById("empty-day");
    listDay.innerHTML = "";
    if (dayItems.length === 0) {
      emptyDay.hidden = false;
    } else {
      emptyDay.hidden = true;
      dayItems.forEach(i => listDay.appendChild(buildItemCard(i)));
    }
  }

  function renderLists() {
    const vis = visibleLists();
    if ((!activeListId || !vis.some(l => l.id === activeListId)) && vis.length) activeListId = vis[0].id;
    if (vis.length === 0) activeListId = null;

    const tabs = document.getElementById("lists-tabs");
    tabs.innerHTML = "";
    vis.forEach(l => {
      const tab = document.createElement("button");
      tab.className = "list-tab" + (l.id === activeListId ? " active" : "");
      tab.innerHTML = `<span>${l.icon || "📋"} ${l.name}</span><span class="list-tab-remove" title="Eliminar lista">✕</span>`;
      tab.addEventListener("click", () => { activeListId = l.id; renderLists(); });
      tab.querySelector(".list-tab-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        softDeleteList(l.id);
        renderLists();
        showToast("Lista enviada a la papelera");
      });
      tabs.appendChild(tab);
    });

    const activeList = vis.find(l => l.id === activeListId);
    const wrap = document.getElementById("list-items");
    const empty = document.getElementById("empty-list");
    wrap.innerHTML = "";

    if (!activeList) {
      empty.hidden = false;
      empty.querySelector("p").textContent = "Creá tu primera lista con “+ Nueva lista”.";
      return;
    }

    let sorted = [...activeList.products].sort((a, b) => Number(a.done) - Number(b.done));
    if (listFilter === "pendientes") sorted = sorted.filter(p => !p.done);
    if (listFilter === "comprados") sorted = sorted.filter(p => p.done);

    if (sorted.length === 0) {
      empty.hidden = false;
      empty.querySelector("p").textContent = listFilter === "comprados"
        ? "Todavía no marcaste nada como comprado."
        : listFilter === "pendientes" ? "No te queda nada pendiente en esta lista 🎉"
        : "Esta lista está vacía por ahora.";
    } else {
      empty.hidden = true;
      sorted.forEach(p => {
        const card = document.createElement("div");
        card.className = "list-item-card";
        card.innerHTML = `
          <button class="item-check" aria-label="Comprado">
            <svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="item-title"></div>
          <button class="list-item-remove" aria-label="Eliminar">✕</button>
        `;
        if (p.done) {
          card.classList.add("done");
          card.querySelector(".item-check").style.background = "var(--success)";
          card.querySelector(".item-check").style.borderColor = "var(--success)";
          card.querySelector(".item-check").style.color = "#fff";
          card.querySelector(".item-title").style.textDecoration = "line-through";
          card.querySelector(".item-title").style.color = "var(--ink-faint)";
        }
        card.querySelector(".item-title").textContent = p.name;
        card.querySelector(".item-check").addEventListener("click", () => toggleListProduct(activeList.id, p.id));
        card.querySelector(".list-item-remove").addEventListener("click", () => removeListProduct(activeList.id, p.id));
        wrap.appendChild(card);
      });
    }
  }

  function toggleListProduct(listId, productId) {
    const list = lists.find(l => l.id === listId);
    if (!list) return;
    const updated = list.products.map(p => p.id === productId ? { ...p, done: !p.done } : p);
    saveList({ ...list, products: updated });
    renderLists();
  }

  function removeListProduct(listId, productId) {
    const list = lists.find(l => l.id === listId);
    if (!list) return;
    const updated = list.products.filter(p => p.id !== productId);
    saveList({ ...list, products: updated });
    renderLists();
  }

  function addListProduct(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    addToProductHistory(trimmed);
    const vis = visibleLists();
    if (!activeListId || !vis.some(l => l.id === activeListId)) {
      const existingCompras = vis.find(l => l.name.toLowerCase() === "compras");
      if (existingCompras) {
        activeListId = existingCompras.id;
        saveList({ ...existingCompras, products: [...existingCompras.products, { id: uid(), name: trimmed, done: false }] });
      } else {
        const l = { id: uid(), name: "Compras", icon: "🛒", products: [{ id: uid(), name: trimmed, done: false }], trashed: false, trashedAt: null };
        activeListId = l.id;
        saveList(l);
      }
    } else {
      const list = lists.find(l => l.id === activeListId);
      saveList({ ...list, products: [...list.products, { id: uid(), name: trimmed, done: false }] });
    }
    renderLists();
    showToast("Agregado a la lista");
  }

  /* ---------- sugerencias de productos (preferencia local, no crítica) */
  function getProductHistory() { return lsGet(LS_KEYS.productHistory) || []; }
  function addToProductHistory(name) {
    const hist = getProductHistory();
    const lower = name.toLowerCase();
    if (!hist.some(h => h.toLowerCase() === lower)) {
      hist.unshift(name);
      lsSet(LS_KEYS.productHistory, hist.slice(0, 300));
    }
  }
  function suggestProducts(query) {
    const q = query.trim().toLowerCase();
    if (q.length < 3) return [];
    const pool = [...getProductHistory(), ...COMMON_PRODUCTS];
    const seen = new Set();
    const results = [];
    for (const p of pool) {
      const lp = p.toLowerCase();
      if (lp.includes(q) && !seen.has(lp)) {
        seen.add(lp);
        results.push(p);
        if (results.length >= 6) break;
      }
    }
    return results;
  }
  function renderProductSuggestions(matches) {
    const box = document.getElementById("list-suggestions");
    box.innerHTML = "";
    if (!matches.length) { box.hidden = true; return; }
    matches.forEach(m => {
      const item = document.createElement("div");
      item.className = "suggest-item";
      item.textContent = `🛒 ${m}`;
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => {
        addListProduct(m);
        const input = document.getElementById("list-item-input");
        input.value = "";
        box.hidden = true;
        input.focus();
      });
      box.appendChild(item);
    });
    box.hidden = false;
  }

  function renderCategory(cat) {
    activeCategory = cat;
    const meta = CATEGORIES[cat];
    document.getElementById("category-title").textContent = meta.label;
    document.getElementById("btn-add-category-item").hidden = false;
    const wrap = document.getElementById("list-category");
    const empty = document.getElementById("empty-category");
    wrap.innerHTML = "";
    const list = visibleItems().filter(i => i.category === cat)
      .sort((a, b) => Number(a.status === "completado") - Number(b.status === "completado") || (a.date || "9999").localeCompare(b.date || "9999"));
    if (list.length === 0) {
      empty.hidden = false;
    } else {
      empty.hidden = true;
      list.forEach(i => {
        const card = buildItemCard(i, cat === "cumpleanos" && i.extra && i.extra.persona
          ? { metaOverride: `${i.date ? formatDateShort(i.date) : "Sin fecha"} · Regalo: ${i.extra.regalo || "pendiente"}` } : {});
        wrap.appendChild(card);
      });
    }
  }

  function renderCompleted() {
    activeCategory = "__completed__";
    document.getElementById("category-title").textContent = "Completados";
    document.getElementById("btn-add-category-item").hidden = true;
    const wrap = document.getElementById("list-category");
    const empty = document.getElementById("empty-category");
    wrap.innerHTML = "";
    const done = visibleItems().filter(i => i.status === "completado")
      .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
    if (done.length === 0) {
      empty.hidden = false;
      empty.querySelector("p").textContent = "Todavía no completaste nada.";
    } else {
      empty.hidden = true;
      done.forEach(i => wrap.appendChild(buildItemCard(i)));
    }
  }

  function renderTrash() {
    const wrap = document.getElementById("trash-list");
    const empty = document.getElementById("empty-trash");
    wrap.innerHTML = "";
    const trashedItems = items.filter(i => i.trashed).map(i => ({
      type: "item", id: i.id, title: i.title, icon: (CATEGORIES[i.category] || {}).icon || "📌", trashedAt: i.trashedAt,
    }));
    const trashedLists = lists.filter(l => l.trashed).map(l => ({
      type: "list", id: l.id, title: l.name + " (lista)", icon: l.icon || "📋", trashedAt: l.trashedAt,
    }));
    const all = [...trashedItems, ...trashedLists].sort((a, b) => (b.trashedAt || "").localeCompare(a.trashedAt || ""));

    document.getElementById("btn-empty-trash").hidden = all.length === 0;
    if (all.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;

    all.forEach(t => {
      const row = document.createElement("div");
      row.className = "trash-row";
      row.innerHTML = `
        <div class="item-icon">${t.icon}</div>
        <div class="item-main">
          <div class="item-title"></div>
          <div class="item-meta"></div>
        </div>
        <div class="trash-actions">
          <button class="trash-restore" title="Restaurar" aria-label="Restaurar">↺</button>
          <button class="trash-delete" title="Eliminar definitivamente" aria-label="Eliminar definitivamente">✕</button>
        </div>`;
      row.querySelector(".item-title").textContent = t.title;
      row.querySelector(".item-meta").textContent = daysAgoLabel(t.trashedAt);
      row.querySelector(".trash-restore").addEventListener("click", () => {
        if (t.type === "item") restoreItem(t.id); else restoreList(t.id);
        renderTrash();
        showToast("Restaurado ✓");
      });
      row.querySelector(".trash-delete").addEventListener("click", () => {
        if (confirm(`¿Eliminar "${t.title}" para siempre? No se puede deshacer.`)) {
          if (t.type === "item") deleteItemForever(t.id); else deleteListForever(t.id);
          renderTrash();
          showToast("Eliminado definitivamente");
        }
      });
      wrap.appendChild(row);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 7. NAVEGACIÓN                                                       */
  /* ------------------------------------------------------------------ */

  function switchScreen(name) {
    document.querySelectorAll(".screen").forEach(s => s.hidden = s.dataset.screen !== name);
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.nav === name));
    document.getElementById("category-detail").hidden = true;
    document.getElementById("trash-detail").hidden = true;
    document.getElementById("more-grid").hidden = false;
    trashOpen = false;

    if (name === "home") renderHome();
    if (name === "calendar") renderCalendar();
    if (name === "lists") renderLists();
  }

  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.nav;
      if (target === "add") { openCapture(); return; }
      switchScreen(target);
    });
  });

  document.getElementById("btn-open-more").addEventListener("click", () => switchScreen("more"));

  document.getElementById("cal-prev").addEventListener("click", () => {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  document.getElementById("cal-next").addEventListener("click", () => {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1);
    renderCalendar();
  });
  document.getElementById("btn-add-event-day").addEventListener("click", () => {
    openCapture({ category: "turno", date: calSelectedISO });
  });

  document.querySelectorAll(".more-tile[data-category]").forEach(tile => {
    tile.addEventListener("click", () => {
      renderCategory(tile.dataset.category);
      document.getElementById("category-detail").hidden = false;
      document.getElementById("trash-detail").hidden = true;
      document.getElementById("more-grid").hidden = true;
      trashOpen = false;
    });
  });
  document.getElementById("tile-completed").addEventListener("click", () => {
    renderCompleted();
    document.getElementById("category-detail").hidden = false;
    document.getElementById("trash-detail").hidden = true;
    document.getElementById("more-grid").hidden = true;
    trashOpen = false;
  });
  document.getElementById("btn-add-category-item").addEventListener("click", () => {
    if (activeCategory && activeCategory !== "__completed__") openCapture({ category: activeCategory });
  });
  document.getElementById("btn-category-back").addEventListener("click", () => {
    document.getElementById("category-detail").hidden = true;
    document.getElementById("more-grid").hidden = false;
  });

  document.getElementById("tile-trash").addEventListener("click", () => {
    trashOpen = true;
    renderTrash();
    document.getElementById("trash-detail").hidden = false;
    document.getElementById("category-detail").hidden = true;
    document.getElementById("more-grid").hidden = true;
  });
  document.getElementById("btn-trash-back").addEventListener("click", () => {
    trashOpen = false;
    document.getElementById("trash-detail").hidden = true;
    document.getElementById("more-grid").hidden = false;
  });
  document.getElementById("btn-empty-trash").addEventListener("click", () => {
    if (confirm("¿Vaciar la papelera? Se eliminarán definitivamente todos los elementos.")) {
      items.filter(i => i.trashed).forEach(i => deleteItemForever(i.id));
      lists.filter(l => l.trashed).forEach(l => deleteListForever(l.id));
      renderTrash();
      showToast("Papelera vaciada");
    }
  });

  /* ---------- copia de seguridad: exportar / importar ---------- */
  document.getElementById("btn-export-backup").addEventListener("click", () => {
    const payload = { app: "bluvia", exportedAt: new Date().toISOString(), items, lists };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bluvia-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast("Copia descargada ⬇️");
  });
  document.getElementById("btn-import-backup").addEventListener("click", () => {
    document.getElementById("import-file-input").click();
  });
  document.getElementById("import-file-input").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); } catch (err) { showToast("El archivo no es una copia válida de BLUVIA."); return; }
      if (!data || !Array.isArray(data.items) || !Array.isArray(data.lists)) {
        showToast("El archivo no es una copia válida de BLUVIA.");
        return;
      }
      if (!confirm(`Esto va a REEMPLAZAR todo lo que tenés ahora por la copia del ${data.exportedAt ? new Date(data.exportedAt).toLocaleDateString("es-AR") : "archivo"}. ¿Continuar?`)) return;
      importBackup(data.items, data.lists);
    };
    reader.readAsText(file);
  });
  async function importBackup(newItems, newLists) {
    try {
      await idbClear("items");
      await idbClear("lists");
      for (const it of newItems) await idbPut("items", it);
      for (const l of newLists) await idbPut("lists", l);
      items = newItems;
      lists = newLists;
      activeListId = null;
      activeCategory = null;
      switchScreen("home");
      showToast("Copia restaurada ✓");
    } catch (err) {
      console.error(err);
      showToast("No se pudo restaurar la copia.");
    }
  }

  /* ---------- Listas: nueva lista + agregar producto ---------- */
  document.getElementById("btn-add-list-item").addEventListener("click", () => {
    const input = document.getElementById("list-item-input");
    addListProduct(input.value);
    input.value = "";
    document.getElementById("list-suggestions").hidden = true;
    input.focus();
  });
  document.getElementById("list-item-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-add-list-item").click();
  });
  document.getElementById("list-item-input").addEventListener("input", (e) => {
    renderProductSuggestions(suggestProducts(e.target.value));
  });
  document.getElementById("list-item-input").addEventListener("blur", () => {
    setTimeout(() => { document.getElementById("list-suggestions").hidden = true; }, 150);
  });

  document.querySelectorAll("#list-filter .chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#list-filter .chip").forEach(c => c.dataset.selected = "false");
      chip.dataset.selected = "true";
      listFilter = chip.dataset.filter;
      renderLists();
    });
  });

  document.getElementById("btn-new-list").addEventListener("click", () => openOverlay("newlist-overlay"));
  document.getElementById("btn-close-newlist").addEventListener("click", () => closeOverlay("newlist-overlay"));
  document.getElementById("btn-create-list").addEventListener("click", () => {
    const name = document.getElementById("newlist-name").value.trim();
    if (!name) return;
    const l = { id: uid(), name, icon: "📋", products: [], trashed: false, trashedAt: null };
    activeListId = l.id;
    saveList(l);
    document.getElementById("newlist-name").value = "";
    closeOverlay("newlist-overlay");
    switchScreen("lists");
  });

  /* ------------------------------------------------------------------ */
  /* 8. CAPTURA RÁPIDA (modal +)                                         */
  /* ------------------------------------------------------------------ */

  function openOverlay(id) { document.getElementById(id).hidden = false; }
  function closeOverlay(id) { document.getElementById(id).hidden = true; }

  function openCapture(opts) {
    opts = opts || {};
    const item = opts.item || null;
    editingItemId = item ? item.id : null;
    selectedChipCat = item ? item.category : (opts.category || "tarea");

    document.querySelectorAll(".chip").forEach(c => { c.dataset.selected = c.dataset.cat === selectedChipCat ? "true" : "false"; });

    document.getElementById("capture-title").textContent = item ? "Editar" : "¿Qué necesitas recordar?";
    document.getElementById("btn-save-capture").textContent = item ? "Guardar cambios" : "Guardar";

    document.getElementById("capture-text").value = item ? item.title : "";
    const prefDate = (item && item.date) || opts.date || "";
    document.getElementById("capture-date").value = prefDate;
    document.getElementById("capture-time").value = (item && item.time) || "";
    document.getElementById("capture-notes").value = (item && item.notes) || "";
    document.getElementById("capture-persona").value = (item && item.extra && item.extra.persona) || "";
    document.getElementById("capture-frecuencia").value = (item && item.extra && item.extra.frecuencia) || "";
    document.getElementById("capture-date-hint").hidden = true;

    const openMore = !!(item || prefDate);
    document.getElementById("capture-more-options").hidden = !openMore;
    document.getElementById("btn-toggle-more-options").textContent = openMore ? "Ocultar opciones ▴" : "Más opciones (fecha, hora, notas) ▾";

    updateConditionalFields();
    openOverlay("capture-overlay");
    setTimeout(() => document.getElementById("capture-text").focus(), 50);
  }

  document.getElementById("btn-open-capture").addEventListener("click", () => openCapture());
  document.getElementById("btn-close-capture").addEventListener("click", () => closeOverlay("capture-overlay"));

  document.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach(c => c.dataset.selected = "false");
      chip.dataset.selected = "true";
      selectedChipCat = chip.dataset.cat;
      updateConditionalFields();
    });
  });

  function updateConditionalFields() {
    document.getElementById("field-persona").hidden = !(selectedChipCat === "cumpleanos" || selectedChipCat === "mia");
    document.getElementById("field-frecuencia").hidden = !(selectedChipCat === "medicamento");
  }

  document.getElementById("btn-toggle-more-options").addEventListener("click", () => {
    const box = document.getElementById("capture-more-options");
    box.hidden = !box.hidden;
    document.getElementById("btn-toggle-more-options").textContent = box.hidden ? "Más opciones (fecha, hora, notas) ▾" : "Ocultar opciones ▴";
  });

  document.getElementById("capture-text").addEventListener("input", (e) => {
    const parsed = parseQuickDate(e.target.value);
    const hint = document.getElementById("capture-date-hint");
    if (parsed) {
      hint.hidden = false;
      hint.textContent = `📅 Detecté "${parsed.label}" → ${formatDateShort(parsed.date)}. Podés ajustarlo en "Más opciones".`;
      document.getElementById("capture-date").value = parsed.date;
    } else {
      hint.hidden = true;
    }
  });

  document.getElementById("btn-save-capture").addEventListener("click", saveCapture);

  function saveCapture() {
    const textEl = document.getElementById("capture-text");
    const text = textEl.value.trim();
    if (!text) { textEl.focus(); return; }

    if (selectedChipCat === "compra" && !editingItemId) {
      addListProduct(text);
      closeOverlay("capture-overlay");
      return;
    }

    const manualDate = document.getElementById("capture-date").value;
    const parsed = parseQuickDate(text);
    const date = manualDate || (parsed ? parsed.date : null);
    const time = document.getElementById("capture-time").value || null;
    const notes = document.getElementById("capture-notes").value.trim();
    const persona = document.getElementById("capture-persona").value.trim();
    const frecuencia = document.getElementById("capture-frecuencia").value.trim();

    if (editingItemId) {
      const existing = items.find(i => i.id === editingItemId);
      if (existing) {
        const extra = {};
        if (persona) extra.persona = persona;
        if (frecuencia) extra.frecuencia = frecuencia;
        if (selectedChipCat === "cumpleanos") extra.regalo = (existing.extra && existing.extra.regalo) || "pendiente";
        saveItem({ ...existing, category: selectedChipCat, title: text, date: date || null, time: time, notes: notes || "", extra: extra });
        editingItemId = null;
        closeOverlay("capture-overlay");
        showToast("Cambios guardados ✓");
        refreshCurrentScreen();
        return;
      }
      editingItemId = null;
    }

    const extra = {};
    if (persona) extra.persona = persona;
    if (frecuencia) extra.frecuencia = frecuencia;
    if (selectedChipCat === "cumpleanos") extra.regalo = "pendiente";

    saveItem({
      id: uid(), category: selectedChipCat, title: text, date: date || null, time: time,
      notes: notes || "", status: "pendiente", createdAt: new Date().toISOString(),
      completedAt: null, extra: extra, trashed: false, trashedAt: null,
    });
    closeOverlay("capture-overlay");
    showToast("Guardado ✓");
    refreshCurrentScreen();
  }

  function refreshCurrentScreen() {
    const current = [...document.querySelectorAll(".screen")].find(s => !s.hidden);
    if (!current) return;
    const name = current.dataset.screen;
    if (name === "home") renderHome();
    if (name === "calendar") renderCalendar();
    if (name === "lists") renderLists();
    if (name === "more") {
      if (trashOpen) renderTrash();
      else if (activeCategory === "__completed__") renderCompleted();
      else if (activeCategory) renderCategory(activeCategory);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 9. DETALLE / COMPLETAR / ELIMINAR                                   */
  /* ------------------------------------------------------------------ */

  function toggleComplete(id) {
    const item = items.find(i => i.id === id);
    if (!item) return;
    const nowCompleted = item.status !== "completado";
    saveItem({ ...item, status: nowCompleted ? "completado" : "pendiente", completedAt: nowCompleted ? new Date().toISOString() : null });
    refreshCurrentScreen();
  }

  function openDetail(id) {
    const item = items.find(i => i.id === id);
    if (!item) return;
    activeDetailId = id;
    const cat = CATEGORIES[item.category] || {};
    document.getElementById("detail-title").textContent = `${cat.icon || ""} ${item.title}`;

    const rows = [];
    rows.push(["Categoría", cat.label || item.category]);
    rows.push(["Estado", item.status === "completado" ? "Completado ✓" : "Pendiente"]);
    if (item.date) rows.push(["Fecha", capitalize(formatDateHuman(item.date))]);
    if (item.time) rows.push(["Hora", item.time]);
    if (item.extra && item.extra.persona) rows.push(["Persona", item.extra.persona]);
    if (item.extra && item.extra.frecuencia) rows.push(["Frecuencia", item.extra.frecuencia]);
    if (item.category === "cumpleanos") rows.push(["Regalo", (item.extra && item.extra.regalo) || "pendiente"]);
    if (item.notes) rows.push(["Notas", item.notes]);

    const body = document.getElementById("detail-body");
    body.innerHTML = rows.map(([k, v]) => `<div class="detail-row"><span>${k}</span><strong>${escapeHtml(String(v))}</strong></div>`).join("");

    document.getElementById("btn-toggle-complete").textContent = item.status === "completado" ? "Marcar como pendiente" : "Marcar como completado";
    openOverlay("detail-overlay");
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  document.getElementById("btn-close-detail").addEventListener("click", () => closeOverlay("detail-overlay"));
  document.getElementById("btn-edit-item").addEventListener("click", () => {
    const item = items.find(i => i.id === activeDetailId);
    if (!item) return;
    closeOverlay("detail-overlay");
    openCapture({ item });
  });
  document.getElementById("btn-toggle-complete").addEventListener("click", () => {
    if (activeDetailId) toggleComplete(activeDetailId);
    closeOverlay("detail-overlay");
  });
  document.getElementById("btn-delete-item").addEventListener("click", () => {
    if (!activeDetailId) return;
    softDeleteItem(activeDetailId);
    closeOverlay("detail-overlay");
    refreshCurrentScreen();
    showToast("Enviado a la papelera ↺ (Más → Papelera para restaurarlo)");
  });

  /* ------------------------------------------------------------------ */
  /* 10. TOAST                                                            */
  /* ------------------------------------------------------------------ */

  let toastTimer = null;
  function showToast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
  }

  document.querySelectorAll(".sheet-overlay").forEach(ov => {
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.hidden = true; });
  });

  /* ------------------------------------------------------------------ */
  /* 11. RECORDATORIOS CON NOTIFICACIÓN (alarma)                         */
  /* Funciona mientras BLUVIA está abierta o en segundo plano en el      */
  /* celular. No es una alarma nativa del sistema: si el navegador se    */
  /* cierra del todo o el celular la "duerme" por completo, no suena.    */
  /* ------------------------------------------------------------------ */

  let scheduledTimeouts = [];
  function clearScheduledTimeouts() { scheduledTimeouts.forEach(id => clearTimeout(id)); scheduledTimeouts = []; }
  function getNotifiedSet() { return new Set(lsGet(LS_KEYS.notified) || []); }
  function markNotified(key) {
    const set = getNotifiedSet();
    set.add(key);
    lsSet(LS_KEYS.notified, [...set]);
  }
  function fireNotif(item, key) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const cat = CATEGORIES[item.category] || {};
    const title = `${cat.icon || "🔔"} ${item.title}`;
    const options = { body: metaLabel(item), icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: item.id };
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then(reg => reg.showNotification(title, options))
        .catch(() => { try { new Notification(title, options); } catch (e) {} });
    } else {
      try { new Notification(title, options); } catch (e) {}
    }
    markNotified(key);
  }
  function scheduleTodayNotifications() {
    clearScheduledTimeouts();
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const today = todayISO();
    const notified = getNotifiedSet();
    const now = new Date();
    visibleItems()
      .filter(i => i.status !== "completado" && i.date === today && i.time)
      .forEach(item => {
        const key = item.id + "|" + item.date;
        if (notified.has(key)) return;
        const target = new Date(`${item.date}T${item.time}:00`);
        const diff = target - now;
        if (diff <= 0) { if (diff > -1000 * 60 * 60 * 3) fireNotif(item, key); }
        else scheduledTimeouts.push(setTimeout(() => fireNotif(item, key), diff));
      });
  }
  function updateNotifBanner() {
    const banner = document.getElementById("notif-banner");
    if (!banner) return;
    const dismissed = lsGetRaw(LS_KEYS.bannerDismissed);
    if (!("Notification" in window)) { banner.hidden = true; return; }
    banner.hidden = !(Notification.permission === "default" && !dismissed);
  }
  const btnEnableNotifs = document.getElementById("btn-enable-notifs");
  if (btnEnableNotifs) {
    btnEnableNotifs.addEventListener("click", () => {
      Notification.requestPermission().then(perm => {
        updateNotifBanner();
        if (perm === "granted") { showToast("Notificaciones activadas 🔔"); scheduleTodayNotifications(); }
        else showToast("No se activaron los permisos");
      });
    });
  }
  const btnDismissNotifBanner = document.getElementById("btn-dismiss-notif-banner");
  if (btnDismissNotifBanner) {
    btnDismissNotifBanner.addEventListener("click", () => {
      lsSetRaw(LS_KEYS.bannerDismissed, "1");
      updateNotifBanner();
    });
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleTodayNotifications(); });

  /* ------------------------------------------------------------------ */
  /* 12. INICIALIZACIÓN                                                   */
  /* ------------------------------------------------------------------ */

  async function init() {
    try {
      idb = await openIDB();
      items = await idbGetAll("items");
      lists = await idbGetAll("lists");
    } catch (e) {
      console.error(e);
      items = [];
      lists = [];
    }

    if (navigator.storage && navigator.storage.persist) {
      try { navigator.storage.persist(); } catch (e) {}
    }

    purgeOldTrash();
    document.getElementById("boot-loading").hidden = true;
    document.getElementById("app").hidden = false;
    switchScreen("home");
    scheduleTodayNotifications();

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("service-worker.js").catch(() => {});
      });
    }
  }

  init();
})();
