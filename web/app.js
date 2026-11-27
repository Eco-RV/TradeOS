// TradeOS · página de demostración
// Lee el contrato desplegado en Stellar Testnet (simulación, sin firmar)
// y envía transacciones firmadas con la billetera Freighter.

import * as SdkModule from "https://cdn.jsdelivr.net/npm/@stellar/stellar-sdk@17.4.0/+esm";
import * as FreighterModule from "https://cdn.jsdelivr.net/npm/@stellar/freighter-api@6.0.1/+esm";

const S = SdkModule.Contract ? SdkModule : SdkModule.default;
const F = FreighterModule.requestAccess ? FreighterModule : FreighterModule.default;

// ---- Configuración (de deployments/testnet.txt) ----
const CONTRATO = "CDEAIZUTQDNCB2DV5VLRRM27EZFNF6R5KZGMO5CH4VXJQSMAQBIZ3NJG";
const TOKEN_XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
// Cuenta pública usada solo como "origen" para simular lecturas.
const CUENTA_LECTURA = "GDK7ONDJUWYKH2PBQ76O7VFLO5ZFFOX7RWQIT2MJBEIOOQSZO6564WAF";
const RPC_URL = "https://soroban-testnet.stellar.org";
const PASSPHRASE = S.Networks.TESTNET;
const EXPLORER = "https://stellar.expert/explorer/testnet";
const STROOPS = 10_000_000n;

const ERRORES = {
  1: "La obra necesita al menos una etapa (y una descripción por monto).",
  2: "Los montos deben ser mayores a cero.",
  3: "El plazo debe estar en el futuro.",
  4: "Esa obra no existe.",
  5: "La obra ya no está en curso.",
  6: "Esa etapa no existe.",
  7: "Esa etapa ya fue aprobada.",
  8: "Hay que aprobar las etapas en orden.",
  9: "Todavía no se vence el plazo: no se puede cancelar.",
  10: "El cliente y el maestro no pueden ser la misma cuenta.",
};

const server = new S.rpc.Server(RPC_URL);
const contrato = new S.Contract(CONTRATO);
let wallet = null;
let obraActual = null; // { id, datos }

const $ = (sel) => document.querySelector(sel);

// ---------- Utilidades ----------
function xlm(stroops) {
  const v = BigInt(stroops);
  const entero = v / STROOPS;
  const frac = (v % STROOPS).toString().padStart(7, "0").replace(/0+$/, "");
  return `${entero.toLocaleString("es-CR")}${frac ? "," + frac : ""} XLM`;
}
function aStroops(texto) {
  const t = String(texto).trim().replace(",", ".");
  if (!/^\d+(\.\d{1,7})?$/.test(t)) return null;
  const [e, f = ""] = t.split(".");
  return BigInt(e) * STROOPS + BigInt(f.padEnd(7, "0"));
}
const corta = (g) => `${g.slice(0, 5)}…${g.slice(-5)}`;
const fecha = (seg) =>
  new Date(Number(seg) * 1000).toLocaleString("es-CR", { dateStyle: "medium", timeStyle: "short" });
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function faltan(seg) {
  const d = Number(seg) - Date.now() / 1000;
  if (d <= 0) return "vencido";
  const dias = Math.floor(d / 86400);
  const horas = Math.floor((d % 86400) / 3600);
  return dias > 0 ? `faltan ${dias} d ${horas} h` : `faltan ${horas} h`;
}
function mensajeError(e) {
  const txt = String(e?.message ?? e);
  const m = txt.match(/Error\(Contract, #(\d+)\)/);
  if (m) return ERRORES[m[1]] ?? `Error del contrato #${m[1]}`;
  if (/User declined|rejected/i.test(txt)) return "Firma cancelada en Freighter.";
  return txt.length > 220 ? txt.slice(0, 220) + "…" : txt;
}
function toast(html, tipo = "") {
  const el = document.createElement("div");
  el.className = `toast ${tipo}`;
  el.innerHTML = html;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), tipo === "bad" ? 9000 : 6000);
}

// ---------- Contrato: lectura ----------
async function leer(metodo, ...args) {
  const origen = new S.Account(CUENTA_LECTURA, "0");
  const tx = new S.TransactionBuilder(origen, { fee: S.BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(contrato.call(metodo, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return S.scValToNative(sim.result.retval);
}

// ---------- Contrato: escritura (firma Freighter) ----------
async function enviar(metodo, args, etiqueta) {
  if (!wallet) {
    toast("Conectá Freighter primero.", "bad");
    return null;
  }
  const aviso = (t) => toast(`<b>${esc(etiqueta)}</b>: ${t}`);
  try {
    const red = await F.getNetworkDetails?.();
    if (red && red.networkPassphrase && red.networkPassphrase !== PASSPHRASE) {
      throw new Error("Freighter no está en Testnet. Cambiá la red en la extensión.");
    }
    const cuenta = await server.getAccount(wallet);
    let tx = new S.TransactionBuilder(cuenta, { fee: S.BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(contrato.call(metodo, ...args))
      .setTimeout(120)
      .build();
    tx = await server.prepareTransaction(tx); // simula; falla aquí si el contrato devuelve error
    aviso("revisá y firmá en Freighter…");
    const firmado = await F.signTransaction(tx.toXDR(), { networkPassphrase: PASSPHRASE, address: wallet });
    if (firmado.error) throw new Error(firmado.error.message ?? firmado.error);
    const txFirmada = S.TransactionBuilder.fromXDR(firmado.signedTxXdr, PASSPHRASE);
    const envio = await server.sendTransaction(txFirmada);
    if (envio.status === "ERROR") throw new Error("La red rechazó la transacción.");
    aviso("enviada, esperando confirmación…");
    let res;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await server.getTransaction(envio.hash);
      if (res.status !== "NOT_FOUND") break;
    }
    if (res?.status !== "SUCCESS") throw new Error(`La transacción terminó en ${res?.status ?? "tiempo agotado"}.`);
    toast(
      `<b>${esc(etiqueta)}</b>: listo ✔ · <a href="${EXPLORER}/tx/${envio.hash}" target="_blank" rel="noopener">ver transacción</a>`,
      "ok",
    );
    return res.returnValue ? S.scValToNative(res.returnValue) : true;
  } catch (e) {
    toast(`<b>${esc(etiqueta)}</b>: ${esc(mensajeError(e))}`, "bad");
    return null;
  }
}

// ---------- Billetera ----------
async function conectar() {
  try {
    const conectado = await F.isConnected();
    if (!conectado?.isConnected) {
      toast('No se detectó Freighter. Instalala desde <a href="https://www.freighter.app" target="_blank" rel="noopener">freighter.app</a> y ponela en Testnet.', "bad");
      return;
    }
    const acceso = await F.requestAccess();
    if (acceso.error || !acceso.address) throw new Error(acceso.error?.message ?? "Sin acceso");
    wallet = acceso.address;
    const btn = $("#btn-wallet");
    btn.textContent = corta(wallet);
    btn.title = wallet;
    btn.classList.add("connected");
    toast(`Conectado como <code>${corta(wallet)}</code>`, "ok");
    if (obraActual) pintarObra(obraActual.id, obraActual.datos);
  } catch (e) {
    toast(esc(mensajeError(e)), "bad");
  }
}

// ---------- Consulta de obra ----------
async function consultar(id) {
  const caja = $("#obra");
  caja.className = "obra empty";
  caja.textContent = "Consultando la red…";
  try {
    const datos = await leer("obra", S.nativeToScVal(id, { type: "u32" }));
    obraActual = { id, datos };
    pintarObra(id, datos);
  } catch (e) {
    obraActual = null;
    caja.textContent = mensajeError(e);
  }
}

function pintarObra(id, o) {
  const caja = $("#obra");
  caja.className = "obra";
  const estado = Array.isArray(o.estado) ? o.estado[0] : o.estado;
  const total = o.hitos.reduce((a, h) => a + BigInt(h.monto), 0n);
  const pagado = total - BigInt(o.saldo);
  const pct = total > 0n ? Number((pagado * 1000n) / total) / 10 : 0;
  const siguiente = o.hitos.findIndex((h) => !h.aprobado);
  const enCurso = estado === "EnCurso";
  const vencido = Date.now() / 1000 > Number(o.plazo);
  const soyCliente = wallet === o.cliente;
  const soyMaestro = wallet === o.maestro;

  const hitos = o.hitos
    .map((h, i) => {
      const cls = h.aprobado ? "pagado" : i === siguiente && enCurso ? "siguiente" : "";
      const st = h.aprobado ? "Pagado al maestro" : i === siguiente && enCurso ? "Siguiente por aprobar" : "En custodia";
      return `<li class="hito ${cls}">
        <span class="n">${h.aprobado ? "✓" : i + 1}</span>
        <div><div>${esc(h.descripcion)}</div><div class="st">${st}</div></div>
        <span class="m">${xlm(h.monto)}</span>
      </li>`;
    })
    .join("");

  let nota = "";
  if (!enCurso) nota = "La obra está cerrada: ya no admite acciones.";
  else if (!wallet) nota = "Conectá Freighter con la cuenta del cliente o del maestro para actuar.";
  else if (!soyCliente && !soyMaestro) nota = "Tu cuenta no es ni el cliente ni el maestro de esta obra.";

  caja.innerHTML = `
    <div class="obra-head">
      <h3>Obra #${id}</h3>
      <span class="pill estado-${estado}">${estado.replace(/([a-z])([A-Z])/g, "$1 $2")}</span>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">En custodia</div><div class="v">${xlm(o.saldo)}</div><div class="s">de ${xlm(total)}</div></div>
      <div class="stat"><div class="k">Pagado al maestro</div><div class="v">${xlm(pagado)}</div><div class="s">${o.hitos.filter((h) => h.aprobado).length} de ${o.hitos.length} etapas</div></div>
      <div class="stat"><div class="k">Plazo</div><div class="v">${fecha(o.plazo)}</div><div class="s">${enCurso ? faltan(o.plazo) : "—"}</div></div>
    </div>
    <div class="partes">
      <div><span class="muted">Cliente</span>${soyCliente ? '<span class="tag">VOS</span>' : ""}<br><a class="mono" href="${EXPLORER}/account/${o.cliente}" target="_blank" rel="noopener">${o.cliente}</a></div>
      <div><span class="muted">Maestro</span>${soyMaestro ? '<span class="tag">VOS</span>' : ""}<br><a class="mono" href="${EXPLORER}/account/${o.maestro}" target="_blank" rel="noopener">${o.maestro}</a></div>
    </div>
    <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
    <div class="bar-label">${pct}% pagado</div>
    <ul class="hitos">${hitos}</ul>
    <div class="acciones">
      <button class="btn primary" id="a-aprobar" ${enCurso && soyCliente && siguiente >= 0 ? "" : "disabled"}>
        Aprobar ${siguiente >= 0 ? `"${esc(o.hitos[siguiente].descripcion)}"` : "etapa"}
      </button>
      <button class="btn danger" id="a-cancelar" ${enCurso && soyCliente && vencido ? "" : "disabled"} title="Solo el cliente, y solo después del plazo">Cancelar y recuperar saldo</button>
      <button class="btn danger" id="a-renunciar" ${enCurso && soyMaestro ? "" : "disabled"} title="Solo el maestro">Renunciar (maestro)</button>
      ${nota ? `<span class="note">${nota}</span>` : ""}
      ${enCurso && soyCliente && !vencido ? '<span class="note">Cancelar se habilita cuando se vence el plazo.</span>' : ""}
    </div>`;

  const u32 = (n) => S.nativeToScVal(n, { type: "u32" });
  $("#a-aprobar").onclick = async () => {
    if (await enviar("aprobar_hito", [u32(id), u32(siguiente)], `Aprobar etapa ${siguiente + 1}`)) refrescar(id);
  };
  $("#a-cancelar").onclick = async () => {
    if (!confirm("¿Cancelar la obra? El saldo en custodia vuelve al cliente.")) return;
    if (await enviar("cancelar", [u32(id)], "Cancelar obra")) refrescar(id);
  };
  $("#a-renunciar").onclick = async () => {
    if (!confirm("¿Renunciar a la obra? Te quedás con lo cobrado y el saldo vuelve al cliente.")) return;
    if (await enviar("renunciar", [u32(id)], "Renunciar")) refrescar(id);
  };
}

function refrescar(id) {
  consultar(id);
  cargarTotal();
  cargarEventos();
}

// ---------- Crear obra ----------
function filaHito(desc = "", monto = "") {
  const row = document.createElement("div");
  row.className = "hito-row";
  row.innerHTML = `
    <input class="h-desc" placeholder="Ej.: Piso" value="${esc(desc)}" required maxlength="60" />
    <input class="h-monto" placeholder="0" value="${esc(monto)}" inputmode="decimal" required />
    <button type="button" class="btn ghost small" aria-label="Quitar etapa">✕</button>`;
  row.querySelector("button").onclick = () => {
    if ($("#c-hitos").children.length > 1) row.remove();
    actualizarTotal();
  };
  row.querySelector(".h-monto").oninput = actualizarTotal;
  $("#c-hitos").append(row);
  actualizarTotal();
}
function actualizarTotal() {
  let t = 0n;
  for (const i of document.querySelectorAll(".h-monto")) t += aStroops(i.value) ?? 0n;
  $("#c-total").textContent = xlm(t);
}

async function crearObra(ev) {
  ev.preventDefault();
  if (!wallet) return toast("Conectá Freighter primero: tu cuenta será el cliente.", "bad");
  const maestro = $("#c-maestro").value.trim();
  if (!S.StrKey.isValidEd25519PublicKey(maestro)) return toast("La cuenta del maestro no es válida (empieza con G…).", "bad");
  const filas = [...document.querySelectorAll(".hito-row")];
  const descripciones = filas.map((f) => f.querySelector(".h-desc").value.trim());
  const montos = filas.map((f) => aStroops(f.querySelector(".h-monto").value));
  if (montos.some((m) => m === null || m <= 0n)) return toast("Revisá los montos: números mayores a cero, hasta 7 decimales.", "bad");
  const plazo = Math.floor(new Date($("#c-plazo").value + "T23:59:59").getTime() / 1000);

  const args = [
    new S.Address(wallet).toScVal(),
    new S.Address(maestro).toScVal(),
    new S.Address(TOKEN_XLM).toScVal(),
    S.xdr.ScVal.scvVec(descripciones.map((d) => S.nativeToScVal(d, { type: "string" }))),
    S.xdr.ScVal.scvVec(montos.map((m) => S.nativeToScVal(m, { type: "i128" }))),
    S.nativeToScVal(BigInt(plazo), { type: "u64" }),
  ];
  const id = await enviar("crear_obra", args, "Crear obra");
  if (id) {
    $("#obra-id").value = id;
    refrescar(Number(id));
    $("#obra").scrollIntoView({ behavior: "smooth" });
  }
}

// ---------- Historial ----------
const ICONOS = { obra_creada: "🧱", hito_pagado: "💸", saldo_devuelto: "↩️" };

async function cargarEventos() {
  const lista = $("#eventos");
  lista.innerHTML = '<li class="muted">Cargando…</li>';
  try {
    // El RPC guarda ~7 días y cada consulta escanea un tramo corto de ledgers,
    // así que se pide la ventana completa en tramos paralelos y se unen.
    const { sequence } = await server.getLatestLedger();
    const sonda = await server.getEvents({
      startLedger: sequence - 100,
      filters: [{ type: "contract", contractIds: [CONTRATO] }],
      limit: 1,
    });
    const desde = Math.max(sonda.oldestLedger ?? sequence - 110_000, sequence - 120_000) + 10;
    const TRAMO = 9_000;
    const inicios = [];
    for (let l = desde; l <= sequence; l += TRAMO) inicios.push(l);
    const respuestas = await Promise.all(
      inicios.map((startLedger) =>
        server
          .getEvents({ startLedger, filters: [{ type: "contract", contractIds: [CONTRATO] }], limit: 100 })
          .catch(() => ({ events: [] })),
      ),
    );
    const porId = new Map();
    for (const r of respuestas) for (const e of r.events ?? []) porId.set(e.id, e);
    const evs = [...porId.values()].sort((a, b) => (a.id < b.id ? 1 : -1));
    if (!evs.length) {
      lista.innerHTML = '<li class="muted">Sin eventos en la ventana que guarda el RPC (unos 7 días).</li>';
      return;
    }
    lista.innerHTML = evs
      .map((e) => {
        const topicos = e.topic.map((t) => S.scValToNative(t));
        const nombre = String(topicos[0]);
        const obraId = topicos[1];
        const d = S.scValToNative(e.value) ?? {};
        let texto;
        if (nombre === "obra_creada") texto = `Obra #${obraId} creada · ${xlm(d.total)} en custodia`;
        else if (nombre === "hito_pagado") texto = `Obra #${obraId} · etapa ${Number(d.indice) + 1} pagada · ${xlm(d.monto)}`;
        else if (nombre === "saldo_devuelto") {
          const est = Array.isArray(d.estado) ? d.estado[0] : d.estado;
          texto = `Obra #${obraId} ${String(est).toLowerCase()} · ${xlm(d.monto)} devueltos al cliente`;
        } else texto = `${nombre} · obra #${obraId}`;
        return `<li><span>${ICONOS[nombre] ?? "•"}</span>
          <a href="#" data-obra="${obraId}">${esc(texto)}</a>
          <a class="when" href="${EXPLORER}/tx/${e.txHash}" target="_blank" rel="noopener">${new Date(e.ledgerClosedAt).toLocaleString("es-CR", { dateStyle: "short", timeStyle: "short" })}</a></li>`;
      })
      .join("");
    lista.querySelectorAll("a[data-obra]").forEach((a) =>
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        $("#obra-id").value = a.dataset.obra;
        consultar(Number(a.dataset.obra));
        $("#obra").scrollIntoView({ behavior: "smooth" });
      }),
    );
  } catch (e) {
    lista.innerHTML = `<li class="muted">No se pudo leer el historial: ${esc(mensajeError(e))}</li>`;
  }
}

async function cargarTotal() {
  try {
    const n = await leer("total_obras");
    $("#total-obras").textContent = `${n} ${Number(n) === 1 ? "obra creada" : "obras creadas"}`;
  } catch {
    $("#total-obras").textContent = "sin conexión con la red";
  }
}

// ---------- Inicio ----------
$("#contract-id").textContent = CONTRATO;
$("#contract-link").href = `${EXPLORER}/contract/${CONTRATO}`;
$("#btn-wallet").onclick = conectar;
$("#btn-eventos").onclick = cargarEventos;
$("#btn-add-hito").onclick = () => filaHito();
$("#form-consulta").onsubmit = (ev) => {
  ev.preventDefault();
  const id = Number($("#obra-id").value);
  if (id >= 1) consultar(id);
};
$("#form-crear").onsubmit = crearObra;

const en30 = new Date(Date.now() + 30 * 86400_000);
$("#c-plazo").value = en30.toISOString().slice(0, 10);
$("#c-plazo").min = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
filaHito("Piso", "3");
filaHito("Paredes", "4");

cargarTotal();
consultar(1);
cargarEventos();
