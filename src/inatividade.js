import { supabase } from './supabase.js'
import { avisarAdminErro } from './pushAdmin.js'
import { enviarMsg } from './envio.js'
import { avisarInstagramSaiu } from './instagramAviso.js'
import { enviarAniversario } from './instagramAniversario.js'

const SITE_URL = 'https://biofarol.vercel.app'

// Verificação diária de inatividade (mesma regra do Telegram, Termo v1.1,
// Cláusulas 6.1 e 7), mais parabéns de aniversário (pessoal e tempo de
// clube) no grupo Bate-papo do WhatsApp.
//
// - Dia 10 (bot_config.lembrete_dias): lembrete no privado.
// - Depois de 15 dias (bot_config.dias_limite), e só se o lembrete já saiu:
//   remove de todos os grupos, cancela a inscrição (libera a vaga) e avisa
//   no privado.
// - Nada é dito nos grupos sobre isso.
//
// Usa os mesmos bot_config.ativo / modo_teste / dias_limite / lembrete_dias /
// isentos_inscricoes do Telegram (regra é a mesma, independe de plataforma),
// mas datas de "já postei hoje" e isentos fixos são próprios do WhatsApp
// (colunas *_whatsapp) pra não colidir com o cron do Telegram, que continua
// rodando todo dia.
//
// Roda 1x por dia (checada por data, não por intervalo) via
// processarInatividadeDiaria(sock), chamada de um setInterval mais curto.
//
// Pausa de fim de ano: bot_config.pausa_inatividade_de/ate (período em que a
// regra não vale pra ninguém) e pausa_inatividade_reinicio (piso da
// referência de "última interação" — faz a contagem recomeçar dali pra
// frente, como se todo mundo tivesse interagido nesse dia).

function hojeSP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
}

function diasEntre(de, ate) {
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86400000)
}

function maisRecente(...datas) {
  return datas.filter(Boolean).sort().at(-1)
}

function textoLembrete(nome, dias, dataLimite) {
  return `Oi, ${nome}! Sentimos sua falta 💕\n` +
    `Faz ${dias} dias que você não interage no Farol. Pelas regras, quem passa 15 dias sem interagir sai do clube.\n\n` +
    `Para continuar com a gente, é só voltar a participar das conversas em qualquer grupo até ${dataLimite}.`
}

function textoRemocao(nome, limite) {
  return `Oi, ${nome}. Como você ficou ${limite} dias sem interagir, sua participação no Farol foi encerrada, conforme as regras do clube.\n\n` +
    `Se quiser voltar, é só fazer uma nova adesão pelo site ${SITE_URL}, de acordo com as vagas disponíveis.\n\n` +
    `Obrigada por ter lido com a gente ❤️`
}

function escaparMarcacao(texto) {
  return String(texto || 'nossa membra')
}

// Busca o "Nome ou apelido de exibição" (membras.nome_exibicao) de um lote de
// inscrições — é ele que deve aparecer, não o apelido/nome do cadastro.
// Devolve uma função (signupId, fallback) -> nome pronto pra usar.
async function nomesExibicaoPorSignup(signupIds) {
  const ids = [...new Set((signupIds ?? []).filter(Boolean))]
  if (!ids.length) return (_id, fallback) => fallback
  const { data } = await supabase.from('membras').select('signup_id, nome_exibicao').in('signup_id', ids)
  const mapa = new Map((data ?? []).filter((m) => m.nome_exibicao).map((m) => [m.signup_id, m.nome_exibicao]))
  return (id, fallback) => mapa.get(id) || fallback
}

// Números (sem @sufixo) de um participante do grupo, cobrindo @lid.
function numerosDoParticipante(p) {
  const nums = new Set()
  for (const campo of [p.id, p.jid, p.lid]) {
    if (campo) nums.add(String(campo).split(':')[0].split('@')[0])
  }
  return nums
}

// Admins de qualquer grupo ativo do WhatsApp agora (live, via Baileys), pra
// isentar a Administração da regra de inatividade. Se não conseguir ler
// algum grupo, não isenta ninguém por ele (mas não trava a checagem toda).
async function numerosAdminWhatsapp(sock, grupos) {
  const admins = new Set()
  for (const g of grupos) {
    try {
      const meta = await sock.groupMetadata(g.group_jid)
      for (const p of meta.participants) {
        if (p.admin) for (const n of numerosDoParticipante(p)) admins.add(n)
      }
    } catch (erro) {
      console.error(`numerosAdminWhatsapp (${g.nome || g.group_jid}):`, erro)
    }
  }
  return admins
}

function numeroDoJid(jid) {
  return String(jid).split('@')[0]
}

async function grupoBatePapo() {
  const { data } = await supabase.from('whatsapp_grupos').select('group_jid').eq('topico', 'bate_papo').eq('ativo', true).maybeSingle()
  return data?.group_jid || null
}

async function grupoAvisos() {
  const { data } = await supabase.from('whatsapp_grupos').select('group_jid').eq('topico', 'avisos').eq('ativo', true).maybeSingle()
  return data?.group_jid || null
}

// "A", "A e B", "A, B e C" — pra juntar nomes/menções numa frase só.
function listaDisplay(itens) {
  if (itens.length === 1) return itens[0]
  if (itens.length === 2) return `${itens[0]} e ${itens[1]}`
  return `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`
}

// Parabéns no Bate-papo pra quem faz aniversário hoje. Só aprovadas e
// vinculadas. Quem nasceu em 29/02 recebe em 28/02 nos anos não bissextos.
// Se mais de uma fizer aniversário no mesmo dia, vai tudo numa mensagem só.
async function aniversarios(sock, hoje) {
  const grupoJid = await grupoAvisos()
  if (!grupoJid) return 0

  const { data: membros, error } = await supabase
    .from('whatsapp_membros')
    .select('jid, signup_id, signups (status, apelido, nome, aniversario, instagram)')
    .is('removido_em', null)
    .not('signup_id', 'is', null)
  if (error) throw error

  const ano = Number(hoje.slice(0, 4))
  const bissexto = (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0
  const diaMes = hoje.slice(5)

  const aniversariantes = []
  for (const m of membros ?? []) {
    const s = m.signups
    if (s?.status !== 'aprovado' || !s.aniversario) continue
    let niver = String(s.aniversario).slice(5, 10)
    if (niver === '02-29' && !bissexto) niver = '02-28'
    if (niver !== diaMes) continue
    aniversariantes.push(m)
  }

  if (aniversariantes.length > 0) {
    const nomeDe = await nomesExibicaoPorSignup(aniversariantes.map((m) => m.signup_id))
    const pessoas = aniversariantes.map((m) => `*${escaparMarcacao(nomeDe(m.signup_id, m.signups.apelido || m.signups.nome))}* (@${numeroDoJid(m.jid)})`)
    const texto = aniversariantes.length === 1
      ? `🎂 Hoje é aniversário da ${pessoas[0]}! Parabéns, desejamos um ano cheio de boas histórias 💖`
      : aniversariantes.length === 2
        ? `🎂 Hoje é aniversário da ${pessoas[0]} e da ${pessoas[1]}! Parabéns, desejamos um ano cheio de boas histórias 💖`
        : `🎂 Hoje é aniversário de ${listaDisplay(pessoas)}! Parabéns, desejamos um ano cheio de boas histórias 💖`
    try {
      await enviarAniversario(sock, {
        tipo: 'pessoal',
        pessoas: aniversariantes.map((m) => ({ signupId: m.signup_id, instagram: m.signups.instagram, nome: nomeDe(m.signup_id, m.signups.apelido || m.signups.nome) })),
        texto,
        mentions: aniversariantes.map((m) => m.jid),
        grupoJid,
      })
    } catch (erro) {
      console.error('parabéns:', erro)
    }
  }

  await supabase.from('bot_config').update({ aniversarios_postados_em_whatsapp: hoje }).eq('id', 1)
  return aniversariantes.length
}

const MESES_PT = {
  janeiro: 0, fevereiro: 1, março: 2, abril: 3, maio: 4, junho: 5,
  julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11,
}

function parseEntradaAprox(txt) {
  if (!txt) return null
  const m = txt.trim().toLowerCase().match(/^([a-zçãéê]+) de (\d{4})$/)
  if (!m) return null
  const mes = MESES_PT[m[1]]
  if (mes === undefined) return null
  return `${m[2]}-${String(mes + 1).padStart(2, '0')}-15`
}

function somarMesesClamp(dataStr, meses) {
  const [y, m, d] = dataStr.split('-').map(Number)
  const total = (m - 1) + meses
  const anoAlvo = y + Math.floor(total / 12)
  const mesAlvo = (total % 12) + 1
  const ultimoDia = new Date(Date.UTC(anoAlvo, mesAlvo, 0)).getUTCDate()
  const diaAlvo = Math.min(d, ultimoDia)
  return `${anoAlvo}-${String(mesAlvo).padStart(2, '0')}-${String(diaAlvo).padStart(2, '0')}`
}

// 1 mês, 6 meses, 1 ano e depois só anualmente (2 anos, 3 anos...).
function marcoDoClube(entrouEm, hoje) {
  if (somarMesesClamp(entrouEm, 1) === hoje) return '1 mês'
  if (somarMesesClamp(entrouEm, 6) === hoje) return '6 meses'
  for (let anos = 1; anos <= 25; anos++) {
    if (somarMesesClamp(entrouEm, anos * 12) === hoje) return anos === 1 ? '1 ano' : `${anos} anos`
  }
  return null
}

// Comemoração de tempo de clube (1 mês, 6 meses, 1 ano, depois anual), com
// base em membras.entrou_em (data real de entrada no grupo, histórico
// compartilhado com o Telegram). Quem só tem entrada aproximada
// (entrada_texto, lista antiga) não entra na conta.
async function aniversariosClube(sock, hoje) {
  const grupoJid = await grupoAvisos()
  if (!grupoJid) return 0

  const { data: membros, error } = await supabase
    .from('whatsapp_membros')
    .select('jid, signup_id, signups (apelido, nome, instagram)')
    .is('removido_em', null)
    .not('signup_id', 'is', null)
  if (error) throw error

  const signupIds = (membros ?? []).map((m) => m.signup_id).filter(Boolean)
  if (signupIds.length === 0) return 0

  const { data: membrasAtivas, error: erroMembras } = await supabase
    .from('membras')
    .select('signup_id, entrou_em, entrada_texto')
    .in('signup_id', signupIds)
    .is('saiu_em', null)
  if (erroMembras) throw erroMembras

  // entrada_texto é a data aproximada que a admin confirmou na mão (ex.:
  // integrantes de antes do sistema, re-vinculadas no WhatsApp depois) —
  // tem prioridade sobre entrou_em, que o autolink pode ter sobrescrito com
  // a data da REVINCULAÇÃO em vez da entrada real (bug visto com Duda, Bel
  // e Mariana Melo: entrada_texto dizia "agosto de 2024" mas entrou_em
  // tinha sido reposto pra outubro de 2026 numa revinculação).
  const entrouPorSignup = new Map()
  for (const m of membrasAtivas ?? []) {
    const data = parseEntradaAprox(m.entrada_texto) || (m.entrou_em ? String(m.entrou_em).slice(0, 10) : null)
    if (data) entrouPorSignup.set(String(m.signup_id), data)
  }

  // Agrupa por marco igual (ex.: duas fazendo "1 mês" no mesmo dia) — cada
  // grupo de marco igual vira 1 mensagem só; marcos diferentes (uma faz 1 mês
  // e outra faz 1 ano no mesmo dia) continuam em mensagens separadas.
  const porMarco = new Map()
  for (const m of membros ?? []) {
    if (!m.signup_id) continue
    const entrou = entrouPorSignup.get(m.signup_id)
    if (!entrou) continue
    const marco = marcoDoClube(entrou, hoje)
    if (!marco) continue
    if (!porMarco.has(marco)) porMarco.set(marco, [])
    porMarco.get(marco).push(m)
  }

  let postados = 0
  for (const [marco, grupo] of porMarco) {
    const nomeDe = await nomesExibicaoPorSignup(grupo.map((m) => m.signup_id))
    const pessoas = grupo.map((m) => `*${escaparMarcacao(nomeDe(m.signup_id, m.signups?.apelido || m.signups?.nome))}* (@${numeroDoJid(m.jid)})`)
    const singular = grupo.length === 1

    const texto = singular
      ? `🎀 Hoje a ${pessoas[0]} completa ${marco} de Farol! Obrigada por fazer parte 💖`
      : grupo.length === 2
        ? `🎀 Hoje a ${pessoas[0]} e a ${pessoas[1]} completam ${marco} de Farol! Obrigada por fazerem parte 💖`
        : `🎀 Hoje ${listaDisplay(pessoas)} completam ${marco} de Farol! Obrigada por fazerem parte 💖`

    try {
      await enviarAniversario(sock, {
        tipo: 'clube',
        tempoTexto: `${marco} de Farol!`,
        pessoas: grupo.map((m) => ({ signupId: m.signup_id, instagram: m.signups?.instagram, nome: nomeDe(m.signup_id, m.signups?.apelido || m.signups?.nome) })),
        texto,
        mentions: grupo.map((m) => m.jid),
        grupoJid,
      })
      postados += grupo.length
    } catch (erro) {
      console.error(`clube ${marco}:`, erro)
    }
  }

  await supabase.from('bot_config').update({ clube_aniversarios_postados_em_whatsapp: hoje }).eq('id', 1)
  return postados
}

const FAROL_FUNDACAO = '2024-08-15'

// Aniversário do Farol (15/08, todo ano).
async function aniversarioFarol(sock, hoje) {
  if (hoje.slice(5) !== FAROL_FUNDACAO.slice(5)) return false
  const anos = Number(hoje.slice(0, 4)) - Number(FAROL_FUNDACAO.slice(0, 4))
  if (anos < 1) return false

  const grupoJid = await grupoBatePapo()
  if (!grupoJid) return false

  const { count } = await supabase
    .from('membras')
    .select('id', { count: 'exact', head: true })
    .is('saiu_em', null)
    .or('entrou_em.not.is.null,importada.eq.true')

  try {
    await enviarMsg(sock, grupoJid, {
      text: `🎀 Hoje o Farol Book Club completa ${anos} ano${anos === 1 ? '' : 's'}! 📚\n\n` +
        `Desde 15/08/2024, já somos ${count ?? 0} integrantes lendo, trocando ideias e fazendo amizades 💖\n\n` +
        'Obrigada por fazerem do Farol esse lugar especial 🫶🏻⚓\n' +
        '*Farol Book Club*',
    })
  } catch (erro) {
    console.error('aniversário do Farol:', erro)
  }

  await supabase.from('bot_config').update({ farol_aniversario_postado_em_whatsapp: hoje }).eq('id', 1)
  return true
}

// Remoção real por inatividade. Devolve o texto do resultado pro log.
async function remover(sock, jid, signupId, grupos, limite, hoje, nome) {
  // Cancela a inscrição ANTES de remover dos grupos (não depois): assim,
  // quando o group-participants.update disparar pra cada grupo (porque o
  // próprio bot removeu), o handler já vê a inscrição cancelada e não
  // confunde essa remoção automática com "removida por uma admin direto
  // no grupo" (que é só pra remoção manual mesmo, feita por uma pessoa).
  if (signupId) {
    const { error: erroSignup } = await supabase
      .from('signups')
      .update({ status: 'cancelado', cancelado_motivo: 'inatividade', cancelado_em: new Date().toISOString() })
      .eq('id', signupId)
      .neq('status', 'cancelado')
    if (erroSignup) return `erro ao cancelar inscrição: ${erroSignup.message}`
    await avisarInstagramSaiu(sock, signupId, 'inatividade')
  }

  for (const g of grupos) {
    try {
      await sock.groupParticipantsUpdate(g.group_jid, [jid], 'remove')
    } catch (erro) {
      console.error(`remover de ${g.nome || g.group_jid}:`, erro)
    }
  }

  await supabase
    .from('whatsapp_membros')
    .update({ removido_em: hoje, signup_id: null, lembrete_ref: null })
    .eq('jid', jid)

  let avisoOk = true
  try {
    await enviarMsg(sock, jid, { text: textoRemocao(nome || 'ela', limite) })
  } catch (erro) {
    avisoOk = false
    console.error(`aviso de remoção ${jid}:`, erro)
  }

  return signupId
    ? `removida; inscrição cancelada${avisoOk ? '' : ' (aviso não entregue)'}`
    : `removida; sem inscrição vinculada${avisoOk ? '' : ' (aviso não entregue)'}`
}

const CHARS_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // sem 0/O/1/I, pra não confundir no zap
function gerarCodigo() {
  let c = ''
  for (let i = 0; i < 4; i++) c += CHARS_CODIGO[Math.floor(Math.random() * CHARS_CODIGO.length)]
  return c
}

function textoAprovacao(nome, dias, codigo) {
  return `⚠️ *Remoção por inatividade*\n\n*${nome}* está há ${dias} dias sem interagir e já recebeu o lembrete. Pelas regras do clube, ela deve ser removida agora.\n\n` +
    `Responda com um destes comandos:\n• *!aprovar ${codigo}* para remover agora\n• *!adiar ${codigo} <dias>* para adiar (ex.: !adiar ${codigo} 7)`
}

// Pede aprovação da admin em vez de remover direto. Só manda de novo depois
// que ela responder (ou o prazo do adiamento passar) — nunca todo ciclo.
async function pedirAprovacaoRemocao(sock, adminJid, m, nome, dias) {
  const codigo = gerarCodigo()
  try {
    await enviarMsg(sock, adminJid, { text: textoAprovacao(nome, dias, codigo) })
  } catch (erro) {
    console.error(`pedido de aprovação de remoção ${m.jid}:`, erro)
    return 'erro ao avisar a admin'
  }
  await supabase.from('whatsapp_membros').update({ remocao_pedida_em: hojeSP(), remocao_codigo: codigo }).eq('jid', m.jid)
  return 'aprovação de remoção solicitada à admin'
}

// Chamado pelo comando "!aprovar <codigo>" no privado da admin.
export async function confirmarRemocaoPorCodigo(sock, codigo) {
  const { data: m } = await supabase
    .from('whatsapp_membros')
    .select('jid, signup_id, signups (apelido, nome)')
    .eq('remocao_codigo', codigo.toUpperCase())
    .is('removido_em', null)
    .maybeSingle()
  if (!m) return null

  const { data: config } = await supabase.from('bot_config').select('dias_limite').eq('id', 1).single()
  const { data: grupos } = await supabase.from('whatsapp_grupos').select('group_jid, nome').eq('ativo', true)
  const nomeDe = await nomesExibicaoPorSignup([m.signup_id])
  const nome = nomeDe(m.signup_id, m.signups?.apelido || m.signups?.nome || 'ela')
  const resultado = await remover(sock, m.jid, m.signup_id, grupos ?? [], config?.dias_limite ?? 30, hojeSP(), nome)
  await supabase.from('whatsapp_inatividade_log').insert({
    jid: m.jid, signup_id: m.signup_id, data_referencia: hojeSP(), modo: 'real', resultado: `aprovada pela admin; ${resultado}`,
  })
  return nome
}

// Chamado pelo comando "!adiar <codigo> <dias>" no privado da admin.
export async function adiarRemocaoPorCodigo(codigo, dias) {
  const { data: m } = await supabase
    .from('whatsapp_membros')
    .select('jid, signup_id, signups (apelido, nome)')
    .eq('remocao_codigo', codigo.toUpperCase())
    .is('removido_em', null)
    .maybeSingle()
  if (!m) return null

  const data = new Date()
  data.setDate(data.getDate() + dias)
  const adiadaAte = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(data)

  await supabase.from('whatsapp_membros')
    .update({ remocao_adiada_ate: adiadaAte, remocao_pedida_em: null, remocao_codigo: null })
    .eq('jid', m.jid)
  const nomeDe = await nomesExibicaoPorSignup([m.signup_id])
  return { nome: nomeDe(m.signup_id, m.signups?.apelido || m.signups?.nome || 'ela'), ate: adiadaAte }
}

// Roda 1x por dia (controlado por bot_config.inatividade_checada_em_whatsapp).
export async function processarInatividadeDiaria(sock) {
  const { data: config, error: erroConfig } = await supabase.from('bot_config').select('*').eq('id', 1).single()
  if (erroConfig) {
    console.error('processarInatividadeDiaria (config):', erroConfig.message)
    return
  }
  if (!config.ativo) return

  const hoje = hojeSP()

  // Parabéns (pessoal, clube, Farol) têm sua própria trava de "já postei
  // hoje" (uma por tipo) — por isso ficam ANTES do corte de
  // inatividade_checada_em_whatsapp (ver mais abaixo): senão, num dia em que
  // a checagem de inatividade já rodasse de madrugada (antes das 10h), os
  // parabéns nunca mais seriam tentados depois das 10h nesse dia. Só saem a
  // partir das 10h mesmo — horário fixo, pra não depender de quando o bot dá
  // a sorte de conferir; antes disso só pula (tenta de novo no próximo ciclo).
  const horaSP = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date()))
  const podeParabenizar = horaSP >= 10

  // Parabéns do dia (independe do resto dar certo).
  if (podeParabenizar && config.aniversarios_postados_em_whatsapp !== hoje) {
    try {
      await aniversarios(sock, hoje)
    } catch (erro) {
      console.error('aniversários (WhatsApp):', erro)
    }
  }
  if (podeParabenizar && config.clube_aniversarios_postados_em_whatsapp !== hoje) {
    try {
      await aniversariosClube(sock, hoje)
    } catch (erro) {
      console.error('aniversários de clube (WhatsApp):', erro)
    }
  }
  if (podeParabenizar && config.farol_aniversario_postado_em_whatsapp !== hoje) {
    try {
      await aniversarioFarol(sock, hoje)
    } catch (erro) {
      console.error('aniversário do Farol (WhatsApp):', erro)
    }
  }

  // Dali pra baixo é só a checagem de inatividade de verdade (mais pesada),
  // que roda só 1x por dia.
  if (config.inatividade_checada_em_whatsapp === hoje) return

  if (!config.lancamento_em) {
    await supabase.from('bot_config').update({ inatividade_checada_em_whatsapp: hoje }).eq('id', 1)
    return
  }

  // Pausa de fim de ano (bot_config.pausa_inatividade_de/ate): ignora a regra
  // pra TODAS nesse período, sem exceção (nem admin, nem isentas de sempre —
  // elas já não seriam cobradas mesmo). Nenhum lembrete nem pedido de
  // remoção sai nesses dias.
  if (config.pausa_inatividade_de && config.pausa_inatividade_ate && hoje >= config.pausa_inatividade_de && hoje <= config.pausa_inatividade_ate) {
    await supabase.from('bot_config').update({ inatividade_checada_em_whatsapp: hoje }).eq('id', 1)
    return
  }

  const teste = config.modo_teste
  const modo = teste ? 'teste' : 'real'

  const { data: grupos, error: erroGrupos } = await supabase.from('whatsapp_grupos').select('group_jid, nome').eq('ativo', true)
  if (erroGrupos) {
    console.error('processarInatividadeDiaria (grupos):', erroGrupos.message)
    return
  }

  // Isentos: administradoras ao vivo de qualquer grupo ativo do WhatsApp +
  // lista fixa (bot_config.isentos_whatsapp) + mesma isenção por inscrição
  // do Telegram (regra é a mesma, independe de plataforma).
  const adminsWhatsapp = await numerosAdminWhatsapp(sock, grupos ?? [])
  const fixosWhatsapp = new Set((config.isentos_whatsapp ?? []).map(numeroDoJid))

  const { data: membros, error: erroMembros } = await supabase
    .from('whatsapp_membros')
    .select('jid, signup_id, ultima_interacao, entrou_em, lembrete_ref, remocao_pedida_em, remocao_adiada_ate, signups (apelido, nome)')
    .is('removido_em', null)
  if (erroMembros) {
    console.error('processarInatividadeDiaria (membros):', erroMembros.message)
    return
  }

  const nomeDe = await nomesExibicaoPorSignup((membros ?? []).map((m) => m.signup_id))

  const logs = []
  for (const m of membros ?? []) {
    const numero = numeroDoJid(m.jid)
    const reinicioJaChegou = config.pausa_inatividade_reinicio && hoje >= config.pausa_inatividade_reinicio
    const referencia = maisRecente(m.ultima_interacao, m.entrou_em, config.lancamento_em, reinicioJaChegou ? config.pausa_inatividade_reinicio : null)
    const dias = diasEntre(referencia, hoje)
    const base = { jid: m.jid, signup_id: m.signup_id, ultima_interacao: m.ultima_interacao, data_referencia: referencia, modo }

    if (dias < config.lembrete_dias) continue

    if (adminsWhatsapp.has(numero) || fixosWhatsapp.has(numero)) {
      if (dias > config.dias_limite) logs.push({ ...base, resultado: 'isenta (Administração)' })
      continue
    }
    if (m.signup_id && (config.isentos_inscricoes ?? []).includes(m.signup_id)) {
      if (dias > config.dias_limite) logs.push({ ...base, resultado: 'isenta (inscrição)' })
      continue
    }

    const lembrada = m.lembrete_ref === referencia

    if (dias > config.dias_limite && (lembrada || teste)) {
      if (teste) {
        logs.push({ ...base, resultado: 'seria removida' })
        continue
      }
      // Em vez de remover direto, pede aprovação da admin — só avisa de novo
      // quando ela responder (!aprovar/!adiar) ou o prazo adiado passar.
      if (m.remocao_adiada_ate && hoje < m.remocao_adiada_ate) {
        logs.push({ ...base, resultado: `adiada até ${m.remocao_adiada_ate}` })
        continue
      }
      if (m.remocao_pedida_em === hoje) continue // já pedida hoje, esperando resposta
      if (!config.admin_jid_whatsapp) {
        await avisarAdminErro('Uma remoção por inatividade aguarda sua aprovação, mas o seu WhatsApp não está configurado. Preencha admin_jid_whatsapp em bot_config.')
        logs.push({ ...base, resultado: 'erro: admin_jid_whatsapp não configurado' })
        continue
      }
      const nome = nomeDe(m.signup_id, m.signups?.apelido || m.signups?.nome || 'ela')
      logs.push({ ...base, resultado: await pedirAprovacaoRemocao(sock, config.admin_jid_whatsapp, m, nome, dias) })
      continue
    }

    if (!lembrada) {
      if (teste) {
        logs.push({ ...base, resultado: 'receberia lembrete' })
        continue
      }
      let entregue = true
      try {
        const nome = nomeDe(m.signup_id, m.signups?.apelido || m.signups?.nome || 'ela')
        const faltam = Math.max(config.dias_limite - dias, 1)
        const dataLimite = new Date(Date.parse(`${hoje}T00:00:00Z`) + faltam * 86400000)
          .toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' })
        await enviarMsg(sock, m.jid, { text: textoLembrete(nome, dias, dataLimite) })
      } catch (erro) {
        entregue = false
        console.error(`lembrete ${m.jid}:`, erro)
      }
      await supabase.from('whatsapp_membros').update({ lembrete_ref: referencia }).eq('jid', m.jid)
      logs.push({ ...base, resultado: entregue ? 'lembrete enviado' : 'lembrete não entregue' })
    }
  }

  if (logs.length > 0) {
    const { error } = await supabase
      .from('whatsapp_inatividade_log')
      .upsert(logs, { onConflict: 'jid,data_referencia,modo,resultado', ignoreDuplicates: true })
    if (error) console.error('whatsapp_inatividade_log:', error.message)
  }

  await supabase.from('bot_config').update({ inatividade_checada_em_whatsapp: hoje }).eq('id', 1)
}
