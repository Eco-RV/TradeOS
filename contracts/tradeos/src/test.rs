#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env, String,
};

const DIA: u64 = 24 * 60 * 60;

struct Escenario<'a> {
    env: Env,
    contrato: TradeOsClient<'a>,
    token: TokenClient<'a>,
    cliente: Address,
    maestro: Address,
}

/// Cliente con ₡1.000.000 (en unidades del token de prueba) y una obra
/// de 3 hitos: piso 300k, paredes 400k, acabados 300k. Plazo: 30 días.
fn escenario<'a>() -> (Escenario<'a>, u32) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let cliente = Address::generate(&env);
    let maestro = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(&env, &sac.address());
    StellarAssetClient::new(&env, &sac.address()).mint(&cliente, &1_000_000);

    let id_contrato = env.register(TradeOs, ());
    let contrato = TradeOsClient::new(&env, &id_contrato);

    let descripciones = vec![
        &env,
        String::from_str(&env, "Piso"),
        String::from_str(&env, "Paredes"),
        String::from_str(&env, "Acabados"),
    ];
    let montos = vec![&env, 300_000i128, 400_000, 300_000];
    let plazo = env.ledger().timestamp() + 30 * DIA;

    let obra_id = contrato.crear_obra(
        &cliente,
        &maestro,
        &sac.address(),
        &descripciones,
        &montos,
        &plazo,
    );

    (
        Escenario {
            env,
            contrato,
            token,
            cliente,
            maestro,
        },
        obra_id,
    )
}

#[test]
fn crear_obra_deposita_el_total_en_custodia() {
    let (e, id) = escenario();
    assert_eq!(id, 1);
    assert_eq!(e.contrato.total_obras(), 1);
    assert_eq!(e.token.balance(&e.cliente), 0);
    assert_eq!(e.token.balance(&e.contrato.address), 1_000_000);

    let obra = e.contrato.obra(&id);
    assert_eq!(obra.saldo, 1_000_000);
    assert_eq!(obra.estado, Estado::EnCurso);
    assert_eq!(obra.hitos.len(), 3);
}

#[test]
fn camino_feliz_se_paga_hito_por_hito() {
    let (e, id) = escenario();

    e.contrato.aprobar_hito(&id, &0);
    assert_eq!(e.token.balance(&e.maestro), 300_000);
    assert_eq!(e.contrato.obra(&id).saldo, 700_000);

    e.contrato.aprobar_hito(&id, &1);
    e.contrato.aprobar_hito(&id, &2);

    assert_eq!(e.token.balance(&e.maestro), 1_000_000);
    assert_eq!(e.token.balance(&e.contrato.address), 0);
    let obra = e.contrato.obra(&id);
    assert_eq!(obra.saldo, 0);
    assert_eq!(obra.estado, Estado::Terminada);
}

#[test]
fn no_se_puede_saltar_un_hito() {
    let (e, id) = escenario();
    let r = e.contrato.try_aprobar_hito(&id, &1);
    assert_eq!(r, Err(Ok(Error::HitoFueraDeOrden)));
    assert_eq!(e.token.balance(&e.maestro), 0);
}

#[test]
fn no_se_puede_aprobar_dos_veces() {
    let (e, id) = escenario();
    e.contrato.aprobar_hito(&id, &0);
    let r = e.contrato.try_aprobar_hito(&id, &0);
    assert_eq!(r, Err(Ok(Error::HitoYaAprobado)));
    assert_eq!(e.token.balance(&e.maestro), 300_000);
}

#[test]
fn solo_el_cliente_aprueba() {
    let (e, id) = escenario();
    e.contrato.aprobar_hito(&id, &0);
    let auths = e.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths.first().unwrap().0, e.cliente);
}

#[test]
fn no_se_puede_cancelar_antes_del_plazo() {
    let (e, id) = escenario();
    let r = e.contrato.try_cancelar(&id);
    assert_eq!(r, Err(Ok(Error::PlazoNoVencido)));
}

#[test]
fn vencido_el_plazo_el_cliente_recupera_el_saldo() {
    let (e, id) = escenario();
    // El maestro solo hizo el piso.
    e.contrato.aprobar_hito(&id, &0);

    // Pasan 31 días y la obra no avanzó.
    e.env
        .ledger()
        .set_timestamp(e.env.ledger().timestamp() + 31 * DIA);

    let devuelto = e.contrato.cancelar(&id);
    assert_eq!(devuelto, 700_000);
    assert_eq!(e.token.balance(&e.cliente), 700_000);
    assert_eq!(e.token.balance(&e.maestro), 300_000);
    assert_eq!(e.contrato.obra(&id).estado, Estado::Cancelada);

    // Ya cancelada, no se puede aprobar nada más.
    let r = e.contrato.try_aprobar_hito(&id, &1);
    assert_eq!(r, Err(Ok(Error::ObraNoEstaEnCurso)));
}

#[test]
fn el_maestro_puede_renunciar() {
    let (e, id) = escenario();
    e.contrato.aprobar_hito(&id, &0);

    let devuelto = e.contrato.renunciar(&id);
    // La renuncia la firma el maestro, no el cliente.
    assert_eq!(e.env.auths().first().unwrap().0, e.maestro);

    assert_eq!(devuelto, 700_000);
    assert_eq!(e.token.balance(&e.cliente), 700_000);
    assert_eq!(e.token.balance(&e.maestro), 300_000);
    assert_eq!(e.contrato.obra(&id).estado, Estado::Abandonada);
}

#[test]
fn validaciones_al_crear() {
    let (e, _) = escenario();
    let token = e.token.address.clone();
    let plazo = e.env.ledger().timestamp() + DIA;
    let una = vec![&e.env, String::from_str(&e.env, "Todo")];

    // Monto en cero.
    let r = e.contrato.try_crear_obra(
        &e.cliente,
        &e.maestro,
        &token,
        &una,
        &vec![&e.env, 0i128],
        &plazo,
    );
    assert_eq!(r, Err(Ok(Error::MontoInvalido)));

    // Sin hitos.
    let r = e.contrato.try_crear_obra(
        &e.cliente,
        &e.maestro,
        &token,
        &vec![&e.env],
        &vec![&e.env],
        &plazo,
    );
    assert_eq!(r, Err(Ok(Error::SinHitos)));

    // Plazo en el pasado.
    let r = e.contrato.try_crear_obra(
        &e.cliente,
        &e.maestro,
        &token,
        &una,
        &vec![&e.env, 10i128],
        &1,
    );
    assert_eq!(r, Err(Ok(Error::PlazoInvalido)));

    // Cliente y maestro iguales.
    let r = e.contrato.try_crear_obra(
        &e.cliente,
        &e.cliente,
        &token,
        &una,
        &vec![&e.env, 10i128],
        &plazo,
    );
    assert_eq!(r, Err(Ok(Error::MismaPersona)));
}

#[test]
fn obra_inexistente() {
    let (e, _) = escenario();
    assert_eq!(e.contrato.try_obra(&99), Err(Ok(Error::ObraNoExiste)));
}
