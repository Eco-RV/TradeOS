# TradeOS 🧱

**Pagos por avance de obra en Stellar.** El dinero de una remodelación queda guardado en un contrato inteligente y se le paga al maestro de obras por partes, solo cuando el cliente aprueba cada avance.

> Tarea de la Semana 03 del Pura Vida Bootcamp (Stellar). Es un proyecto de práctica individual, no es la idea para la hackathon.

---

## El problema

En Costa Rica es muy común esto:

1. Contratás a un maestro de obras para remodelar el baño, hacer un cuarto o tapiar.
2. Te pide **la mitad por adelantado** "para comprar materiales".
3. Trabaja unos días… y después **deja de llegar**. No contesta el WhatsApp.
4. La obra queda a medias y la plata ya se fue.

Al revés también pasa: el maestro termina el trabajo y el cliente le da largas para pagarle.

**¿A quién afecta?** A familias que remodelan su casa y a maestros de obras, contratistas y chamberos que trabajan por su cuenta.

**¿Por qué duele?** Casi siempre el trato es de palabra, sin contrato escrito. Ir a un juicio por ₡500 000 no vale la pena, así que la persona pierde el dinero o el trabajo.

## La solución en una frase

> **El cliente pone toda la plata en el contrato desde el inicio, y el contrato le paga al maestro por cada etapa terminada que el cliente aprueba.**

- El maestro **ve que el dinero ya existe** y está reservado para él: no corre el riesgo de que no le paguen.
- El cliente **no adelanta nada al maestro**: solo se paga lo que ya se hizo.
- Si el maestro desaparece y se vence el plazo, el cliente **recupera lo que no se ha pagado**.

## ¿Por qué elegí este problema?

- Es real y muy tico: casi todo el mundo conoce a alguien a quien le pasó.
- Es **pequeño y concreto**: dos personas, un monto y unas pocas etapas.
- Muestra bien para qué sirve un contrato inteligente: **guardar dinero de forma neutral** y liberarlo con reglas que nadie puede cambiar a medio camino. Ninguna de las dos partes tiene que confiar en la otra.

---

## Cómo funciona

```
 Cliente                      Contrato TradeOS                    Maestro
    │  crear_obra(hitos, plazo)       │                               │
    │ ── deposita ₡1 000 000 ───────► │  (custodia)                   │
    │                                 │                               │
    │  aprobar_hito(0) "Piso" ──────► │ ── paga ₡300 000 ───────────► │
    │  aprobar_hito(1) "Paredes" ───► │ ── paga ₡400 000 ───────────► │
    │  aprobar_hito(2) "Acabados" ──► │ ── paga ₡300 000 ───────────► │
    │                                 │   estado = Terminada          │
```

Si el maestro deja la obra botada:

```
    │  (pasa el plazo sin avances)    │                               │
    │  cancelar() ──────────────────► │                               │
    │ ◄── recibe el saldo restante ── │   estado = Cancelada          │
```

### Funciones del contrato

| Función | Quién la firma | Qué hace |
|---|---|---|
| `crear_obra(cliente, maestro, token, descripciones, montos, plazo)` | Cliente | Crea la obra con sus etapas (hitos) y **deposita el total** en el contrato. Devuelve el `id` de la obra. |
| `aprobar_hito(obra_id, indice)` | Cliente | Aprueba una etapa y el contrato **le paga ese monto al maestro**. Las etapas se aprueban en orden. |
| `cancelar(obra_id)` | Cliente | Solo **después del plazo**: devuelve al cliente todo lo que no se ha pagado. |
| `renunciar(obra_id)` | Maestro | El maestro se retira. Se queda con lo que ya cobró y el resto vuelve al cliente. |
| `obra(obra_id)` | Cualquiera | Consulta el estado: etapas, saldo en custodia, plazo y estado. |
| `total_obras()` | Cualquiera | Cuántas obras se han creado. |

### Estados de una obra

- `EnCurso`: todavía hay etapas por aprobar.
- `Terminada`: todas las etapas se aprobaron y pagaron.
- `Cancelada`: se venció el plazo y el cliente recuperó el saldo.
- `Abandonada`: el maestro renunció y el saldo volvió al cliente.

### Reglas que protege el contrato

- Solo el **cliente** puede aprobar etapas o cancelar (`require_auth`).
- Solo el **maestro** puede renunciar.
- No se puede **saltar** una etapa ni aprobarla **dos veces**.
- No se puede cancelar **antes del plazo**: así el maestro tiene el tiempo pactado para trabajar.
- Los montos deben ser mayores a cero, el plazo debe estar en el futuro y el cliente y el maestro no pueden ser la misma cuenta.
- Cada acción importante emite un evento (`ObraCreada`, `HitoPagado`, `SaldoDevuelto`) para que una app pueda mostrar el historial.

---

## Pruebas

Las pruebas están en [`contracts/tradeos/src/test.rs`](contracts/tradeos/src/test.rs). Usan una obra de ejemplo con 3 etapas (Piso ₡300 000, Paredes ₡400 000, Acabados ₡300 000) y un plazo de 30 días.

| Prueba | Qué comprueba |
|---|---|
| `crear_obra_deposita_el_total_en_custodia` | Al crear la obra, el ₡1 000 000 sale del cliente y queda en el contrato. |
| `camino_feliz_se_paga_hito_por_hito` | Cada aprobación le paga al maestro. Al final la obra queda `Terminada` y sin saldo. |
| `no_se_puede_saltar_un_hito` | Aprobar "Paredes" antes que "Piso" falla con `HitoFueraDeOrden`. |
| `no_se_puede_aprobar_dos_veces` | Aprobar la misma etapa dos veces falla con `HitoYaAprobado`. |
| `solo_el_cliente_aprueba` | La aprobación exige la firma del cliente. |
| `no_se_puede_cancelar_antes_del_plazo` | Cancelar antes de tiempo falla con `PlazoNoVencido`. |
| `vencido_el_plazo_el_cliente_recupera_el_saldo` | El maestro hizo solo el piso. A los 31 días el cliente recupera ₡700 000 y el maestro se queda con ₡300 000. |
| `el_maestro_puede_renunciar` | Al renunciar, el saldo vuelve al cliente y la renuncia la firma el maestro. |
| `validaciones_al_crear` | Rechaza montos en cero, obras sin etapas, plazos en el pasado y cliente igual a maestro. |
| `obra_inexistente` | Consultar una obra que no existe devuelve `ObraNoExiste`. |

```
running 10 tests
test result: ok. 10 passed; 0 failed
```

---

## Desplegado en Testnet 🚀

| | |
|---|---|
| **Contrato** | [`CDEAIZUTQDNCB2DV5VLRRM27EZFNF6R5KZGMO5CH4VXJQSMAQBIZ3NJG`](https://stellar.expert/explorer/testnet/contract/CDEAIZUTQDNCB2DV5VLRRM27EZFNF6R5KZGMO5CH4VXJQSMAQBIZ3NJG) |
| **Token de pago** | XLM nativo (`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`) |
| **Obra de ejemplo** | `1`: Piso (3 XLM, ya aprobado y pagado) + Paredes (4 XLM, en custodia) |

Consultar la obra de ejemplo:

```bash
stellar contract invoke \
  --id CDEAIZUTQDNCB2DV5VLRRM27EZFNF6R5KZGMO5CH4VXJQSMAQBIZ3NJG \
  --source <tu-cuenta> --network testnet -- \
  obra --obra_id 1
```

---

## Cómo correrlo

### Requisitos

- [Rust](https://www.rust-lang.org/tools/install) con el target de WebAssembly:
  ```bash
  rustup target add wasm32v1-none
  ```
- [Stellar CLI](https://developers.stellar.org/docs/tools/cli/install-cli)

### 1. Correr las pruebas

```bash
cargo test
```

### 2. Compilar el contrato

```bash
stellar contract build
# genera target/wasm32v1-none/release/tradeos.wasm
```

### 3. Desplegar en Testnet

**Atajo en Windows:** este script compila, crea las cuentas, despliega, crea una obra de ejemplo, aprueba el primer hito y guarda los datos en `deployments/testnet.txt`.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy-testnet.ps1
```

**Paso a paso:**

```bash
# Cuentas de prueba con fondos de Friendbot
stellar keys generate cliente --network testnet --fund
stellar keys generate maestro --network testnet --fund

# Desplegar
stellar contract deploy \
  --wasm target/wasm32v1-none/release/tradeos.wasm \
  --source cliente \
  --network testnet \
  --alias tradeos

# Dirección del XLM nativo como token de pago
stellar contract id asset --asset native --network testnet
```

### 4. Probarlo en Testnet

```bash
XLM=<dirección que devolvió el comando anterior>

# Crear una obra de 2 etapas (montos en stroops: 1 XLM = 10 000 000)
# El plazo es un timestamp Unix (segundos). Ejemplo: 1 de enero de 2027.
stellar contract invoke --id tradeos --source cliente --network testnet -- \
  crear_obra \
  --cliente cliente \
  --maestro maestro \
  --token $XLM \
  --descripciones '["Piso","Paredes"]' \
  --montos '["30000000","40000000"]' \
  --plazo 1798761600

# Aprobar la primera etapa (le paga 3 XLM al maestro)
stellar contract invoke --id tradeos --source cliente --network testnet -- \
  aprobar_hito --obra_id 1 --indice 0

# Ver el estado de la obra
stellar contract invoke --id tradeos --source cliente --network testnet -- \
  obra --obra_id 1
```

### 5. Página web de demostración

En `web/` hay una página sin build (HTML + JS con `@stellar/stellar-sdk` desde CDN) conectada al contrato de Testnet:

- **Consultar una obra**: etapas, saldo en custodia, lo pagado y el plazo (lectura por simulación, no hace falta billetera).
- **Acciones con [Freighter](https://www.freighter.app)** en Testnet: crear obra, aprobar la siguiente etapa, cancelar (vencido el plazo) y renunciar. Los botones se activan según seas el cliente o el maestro.
- **Historial** de eventos del contrato (los últimos ~7 días que guarda el RPC).

```bash
python -m http.server 5173 --directory web
# abrir http://localhost:5173
```

---

## Estructura

```
TradeOS/
├── Cargo.toml                  # workspace
├── contracts/
│   └── tradeos/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs          # contrato
│           └── test.rs         # pruebas
├── web/                        # página de demostración (index.html, app.js, styles.css)
├── scripts/deploy-testnet.ps1  # despliegue + obra de ejemplo
├── deployments/testnet.txt     # direcciones del despliegue
└── README.md
```

## Ideas para después (fuera del MVP)

- Que el **maestro marque** una etapa como terminada y, si el cliente no responde en X días, se apruebe sola (para que el cliente tampoco pueda dar largas).
- Un **árbitro** (por ejemplo, un ingeniero) para resolver desacuerdos.
- Pagar en colones tokenizados o en USDC, y conectarlo con SINPE.
- Fotos de cada avance guardadas fuera de la cadena, con su hash en el contrato.

---

Hecho por **Oswald Reid Villalobos** · Pura Vida Bootcamp 2026
