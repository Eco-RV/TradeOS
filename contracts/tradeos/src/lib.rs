#![no_std]

//! TradeOS — pagos por avance de obra.
//!
//! El cliente deposita el pago completo de la obra en el contrato.
//! El dinero se libera al maestro de obras hito por hito, solo cuando
//! el cliente aprueba cada avance. Si la obra no se termina a tiempo,
//! el cliente recupera lo que no se ha liberado.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
    String, Vec,
};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Hito {
    pub descripcion: String,
    pub monto: i128,
    pub aprobado: bool,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Estado {
    /// La obra está en curso y quedan hitos por aprobar.
    EnCurso,
    /// Todos los hitos fueron aprobados y pagados.
    Terminada,
    /// El cliente canceló por vencimiento y recuperó el saldo.
    Cancelada,
    /// El maestro renunció y el saldo volvió al cliente.
    Abandonada,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Obra {
    pub cliente: Address,
    pub maestro: Address,
    pub token: Address,
    pub hitos: Vec<Hito>,
    /// Fecha límite (timestamp del ledger, en segundos).
    pub plazo: u64,
    /// Dinero que sigue en custodia en el contrato.
    pub saldo: i128,
    pub estado: Estado,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ObraCreada {
    #[topic]
    pub obra_id: u32,
    pub total: i128,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct HitoPagado {
    #[topic]
    pub obra_id: u32,
    pub indice: u32,
    pub monto: i128,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct SaldoDevuelto {
    #[topic]
    pub obra_id: u32,
    pub estado: Estado,
    pub monto: i128,
}

#[contracttype]
enum DataKey {
    Contador,
    Obra(u32),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    SinHitos = 1,
    MontoInvalido = 2,
    PlazoInvalido = 3,
    ObraNoExiste = 4,
    ObraNoEstaEnCurso = 5,
    HitoNoExiste = 6,
    HitoYaAprobado = 7,
    HitoFueraDeOrden = 8,
    PlazoNoVencido = 9,
    MismaPersona = 10,
}

const TTL_UMBRAL: u32 = 100_000;
const TTL_EXTENDER: u32 = 500_000;

#[contract]
pub struct TradeOs;

#[contractimpl]
impl TradeOs {
    /// El cliente crea la obra y deposita el total de todos los hitos.
    /// Devuelve el id de la obra.
    pub fn crear_obra(
        env: Env,
        cliente: Address,
        maestro: Address,
        token: Address,
        descripciones: Vec<String>,
        montos: Vec<i128>,
        plazo: u64,
    ) -> Result<u32, Error> {
        cliente.require_auth();

        if cliente == maestro {
            return Err(Error::MismaPersona);
        }
        if descripciones.is_empty() || descripciones.len() != montos.len() {
            return Err(Error::SinHitos);
        }
        if plazo <= env.ledger().timestamp() {
            return Err(Error::PlazoInvalido);
        }

        let mut hitos = Vec::new(&env);
        let mut total: i128 = 0;
        for i in 0..montos.len() {
            let monto = montos.get_unchecked(i);
            if monto <= 0 {
                return Err(Error::MontoInvalido);
            }
            total = total.checked_add(monto).ok_or(Error::MontoInvalido)?;
            hitos.push_back(Hito {
                descripcion: descripciones.get_unchecked(i),
                monto,
                aprobado: false,
            });
        }

        // El dinero pasa del cliente al contrato (custodia).
        token::Client::new(&env, &token).transfer(
            &cliente,
            env.current_contract_address(),
            &total,
        );

        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Contador)
            .unwrap_or(0u32)
            + 1;
        env.storage().instance().set(&DataKey::Contador, &id);
        env.storage()
            .instance()
            .extend_ttl(TTL_UMBRAL, TTL_EXTENDER);

        let obra = Obra {
            cliente,
            maestro,
            token,
            hitos,
            plazo,
            saldo: total,
            estado: Estado::EnCurso,
        };
        guardar(&env, id, &obra);

        ObraCreada { obra_id: id, total }.publish(&env);
        Ok(id)
    }

    /// El cliente aprueba el siguiente hito y el contrato le paga al maestro.
    /// Los hitos se aprueban en orden.
    pub fn aprobar_hito(env: Env, obra_id: u32, indice: u32) -> Result<(), Error> {
        let mut obra = cargar(&env, obra_id)?;
        obra.cliente.require_auth();

        if obra.estado != Estado::EnCurso {
            return Err(Error::ObraNoEstaEnCurso);
        }
        let mut hito = obra.hitos.get(indice).ok_or(Error::HitoNoExiste)?;
        if hito.aprobado {
            return Err(Error::HitoYaAprobado);
        }
        if indice > 0 && !obra.hitos.get_unchecked(indice - 1).aprobado {
            return Err(Error::HitoFueraDeOrden);
        }

        token::Client::new(&env, &obra.token).transfer(
            &env.current_contract_address(),
            &obra.maestro,
            &hito.monto,
        );

        hito.aprobado = true;
        obra.saldo -= hito.monto;
        obra.hitos.set(indice, hito.clone());
        if indice == obra.hitos.len() - 1 {
            obra.estado = Estado::Terminada;
        }
        guardar(&env, obra_id, &obra);

        HitoPagado {
            obra_id,
            indice,
            monto: hito.monto,
        }
        .publish(&env);
        Ok(())
    }

    /// Si se venció el plazo y la obra no está terminada, el cliente
    /// recupera todo lo que no se ha liberado.
    pub fn cancelar(env: Env, obra_id: u32) -> Result<i128, Error> {
        let mut obra = cargar(&env, obra_id)?;
        obra.cliente.require_auth();

        if obra.estado != Estado::EnCurso {
            return Err(Error::ObraNoEstaEnCurso);
        }
        if env.ledger().timestamp() <= obra.plazo {
            return Err(Error::PlazoNoVencido);
        }

        let devuelto = devolver_saldo(&env, &mut obra);
        obra.estado = Estado::Cancelada;
        guardar(&env, obra_id, &obra);

        SaldoDevuelto {
            obra_id,
            estado: obra.estado,
            monto: devuelto,
        }
        .publish(&env);
        Ok(devuelto)
    }

    /// El maestro puede renunciar en cualquier momento. Se queda con lo
    /// que ya cobró y el saldo vuelve al cliente.
    pub fn renunciar(env: Env, obra_id: u32) -> Result<i128, Error> {
        let mut obra = cargar(&env, obra_id)?;
        obra.maestro.require_auth();

        if obra.estado != Estado::EnCurso {
            return Err(Error::ObraNoEstaEnCurso);
        }

        let devuelto = devolver_saldo(&env, &mut obra);
        obra.estado = Estado::Abandonada;
        guardar(&env, obra_id, &obra);

        SaldoDevuelto {
            obra_id,
            estado: obra.estado,
            monto: devuelto,
        }
        .publish(&env);
        Ok(devuelto)
    }

    /// Consulta pública del estado de una obra.
    pub fn obra(env: Env, obra_id: u32) -> Result<Obra, Error> {
        cargar(&env, obra_id)
    }

    /// Cuántas obras se han creado.
    pub fn total_obras(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Contador)
            .unwrap_or(0)
    }
}

fn cargar(env: &Env, id: u32) -> Result<Obra, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Obra(id))
        .ok_or(Error::ObraNoExiste)
}

fn guardar(env: &Env, id: u32, obra: &Obra) {
    let key = DataKey::Obra(id);
    env.storage().persistent().set(&key, obra);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_UMBRAL, TTL_EXTENDER);
}

fn devolver_saldo(env: &Env, obra: &mut Obra) -> i128 {
    let saldo = obra.saldo;
    if saldo > 0 {
        token::Client::new(env, &obra.token).transfer(
            &env.current_contract_address(),
            &obra.cliente,
            &saldo,
        );
    }
    obra.saldo = 0;
    saldo
}

#[cfg(test)]
mod test;
