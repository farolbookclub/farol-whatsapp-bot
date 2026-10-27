import { supabase } from './supabase.js'

// Verificação diária de inatividade (mesma regra do Telegram, Termo v1.1,
// Cláusulas 6.1 e 7), mais parabéns de aniversário (pessoal e tempo de
// clube) no grupo Bate-papo do WhatsApp.
//
// - Dia 20 (bot_config.lembrete_dias): lembrete no privado.
// - Depois de 30 dias (bot_config.dias_limite), e só se o lembrete já saiu:
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

const SITE_URL = 'https://biofarol.vercel.app'

function hojeSP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
}

function diasEntre(de, ate) {
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86400000)
}

function maisRecente(...datas) {
  return datas.filter(Boolean).sort().at(-1)
}

function textoLembrete(dias, faltam) {
  return `Sentimos sua falta por aqui! Já faz ${dias} dias desde sua última interação no Farol. ` +
    `Se ficar mais ${faltam} ${faltam === 1 ? 'dia' : 'dias'} sem interagir, você será removida dos grupos.`
}

function textoRemocao(limite) {
  return `Poxa! Você ficou ${limite} dias sem interagir nos grupos do Farol e foi removida. ` +
    'A intenção da comunidade é criar amizades e conexões através da leitura. ' +
    `Se desejar voltar, faça uma nova adesão pelo site: ${SITE_URL}`
}

function escaparMarcacao(texto) {
  return String(texto || 'nossa membra')
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

// Parabéns no Bate-papo pra quem faz aniversário hoje. Só aprovadas e
// vinculadas. Quem nasceu em 29/02 recebe em 28/02 nos anos não bissextos.
async function aniversarios(sock, hoje) {
  const grupoJid = await grupoBatePapo()
  if (!grupoJid) return 0

  const { data: membros, error } = await supabase
    .from('whatsapp_membros')
    .select('jid, signups (status, apelido, nome, aniversario)')
    .is('removido_em', null)
    .not('signup_id', 'is', null)
  if (error) throw error

  const ano = Number(hoje.slice(0, 4))
  const bissexto = (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0
  const diaMes = hoje.slice(5)

  let postados = 0
  for (const m of membros ?? []) {
    const s = m.signups
    if (s?.status !== 'aprovado' || !s.aniversario) continue
    let niver = String(s.aniversario).slice(5, 10)
    if (niver === '02-29' && !bissexto) niver = '02-28'
    if (niver !== diaMes) continue

    const nome = escaparMarcacao(s.apelido || s.nome)
    try {
      await sock.sendMessage(grupoJid, {
        text: `Hoje é aniversário da @${numeroDoJid(m.jid)}! 🎂🎉 ${nome}, parabéns, que seu novo ciclo seja cheio de livros incríveis e momentos lindos! 💕`,
        mentions: [m.jid],
      })
      postados++
    } catch (erro) {
      console.error(`parabéns ${m.jid}:`, erro)
    }
  }

  await supabase.from('bot_config').update({ aniversarios_postados_em_whatsapp: hoje }).eq('id', 1)
  return postados
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
  const grupoJid = await grupoBatePapo()
  if (!grupoJid) return 0

  const { data: membros, error } = await supabase
    .from('whatsapp_membros')
    .select('jid, signup_id, signups (apelido, nome)')
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

  const entrouPorSignup = new Map()
  for (const m of membrasAtivas ?? []) {
    const data = m.entrou_em ? String(m.entrou_em).slice(0, 10) : parseEntradaAprox(m.entrada_texto)
    if (data) entrouPorSignup.set(String(m.signup_id), data)
  }

  let postados = 0
  for (const m of membros ?? []) {
    if (!m.signup_id) continue
    const entrou = entrouPorSignup.get(m.signup_id)
    if (!entrou) continue
    const marco = marcoDoClube(entrou, hoje)
    if (!marco) continue

    const s = m.signups
    const apelido = escaparMarcacao(s?.apelido || s?.nome)
    const ehMeses = marco.includes('mês') || marco.includes('meses')

    try {
      await sock.sendMessage(grupoJid, {
        text: `🎉✨ Hoje é dia de comemorar! A @${numeroDoJid(m.jid)} completa ${marco} de clubinho! 🥳💛\n\n` +
          `Parabéns, ${apelido}! 🎂🌟 Obrigada por fazer parte dessa história e por estar com a gente! Amamos ter você no nosso Farol e ficamos muito felizes em ter você por aqui! 🫶🏻💖\n\n` +
          `Que venham muitos outros ${ehMeses ? 'meses' : 'anos'} brilhando juntinhas! ⚓🌊💫`,
        mentions: [m.jid],
      })
      postados++
    } catch (erro) {
      console.error(`clube ${m.jid}:`, erro)
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
    await sock.sendMessage(grupoJid, {
      text: `✨ Hoje é dia de comemorar: o Farol Book Club completa ${anos} ano${anos === 1 ? '' : 's'}! 🎉📚\n\n` +
        `Desde 15 de agosto de 2024, reunimos divas apaixonadas por livros, compartilhamos leituras e criamos amizades lindas! 💛 Hoje somos ${count ?? 0} integrantes, e cada uma de vocês faz parte dessa história.\n\n` +
        'Obrigada por estarem aqui e fazerem do nosso Farol um lugar tão especial! Que venham muitos outros anos de leituras, histórias, conversas, amizades e momentos incríveis juntas! 🫶🏻⚓🌊\n\n' +
        'Com carinho,\n*Farol Book Club* ✨💛',
    })
  } catch (erro) {
    console.error('aniversário do Farol:', erro)
  }

  await supabase.from('bot_config').update({ farol_aniversario_postado_em_whatsapp: hoje }).eq('id', 1)
  return true
}

// Remoção real por inatividade. Devolve o texto do resultado pro log.
async function remover(sock, jid, signupId, grupos, limite, hoje) {
  for (const g of grupos) {
    try {
      await sock.groupParticipantsUpdate(g.group_jid, [jid], 'remove')
    } catch (erro) {
      console.error(`remover de ${g.nome || g.group_jid}:`, erro)
    }
  }

  if (signupId) {
    const { error: erroSignup } = await supabase
      .from('signups')
      .update({ status: 'cancelado', cancelado_motivo: 'inatividade', cancelado_em: new Date().toISOString() })
      .eq('id', signupId)
      .neq('status', 'cancelado')
    if (erroSignup) return `removida dos grupos, mas erro ao cancelar inscrição: ${erroSignup.message}`
  }

  await supabase
    .from('whatsapp_membros')
    .update({ removido_em: hoje, signup_id: null, lembrete_ref: null })
    .eq('jid', jid)

  let avisoOk = true
  try {
    await sock.sendMessage(jid, { text: textoRemocao(limite) })
  } catch (erro) {
    avisoOk = false
    console.error(`aviso de remoção ${jid}:`, erro)
  }

  return signupId
    ? `removida; inscrição cancelada${avisoOk ? '' : ' (aviso não entregue)'}`
    : `removida; sem inscrição vinculada${avisoOk ? '' : ' (aviso não entregue)'}`
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
  if (config.inatividade_checada_em_whatsapp === hoje) return

  // Parabéns do dia (independe do resto dar certo).
  if (config.aniversarios_postados_em_whatsapp !== hoje) {
    try {
      await aniversarios(sock, hoje)
    } catch (erro) {
      console.error('aniversários (WhatsApp):', erro)
    }
  }
  if (config.clube_aniversarios_postados_em_whatsapp !== hoje) {
    try {
      await aniversariosClube(sock, hoje)
    } catch (erro) {
      console.error('aniversários de clube (WhatsApp):', erro)
    }
  }
  if (config.farol_aniversario_postado_em_whatsapp !== hoje) {
    try {
      await aniversarioFarol(sock, hoje)
    } catch (erro) {
      console.error('aniversário do Farol (WhatsApp):', erro)
    }
  }

  if (!config.lancamento_em) {
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
    .select('jid, signup_id, ultima_interacao, entrou_em, lembrete_ref')
    .is('removido_em', null)
  if (erroMembros) {
    console.error('processarInatividadeDiaria (membros):', erroMembros.message)
    return
  }

  const logs = []
  for (const m of membros ?? []) {
    const numero = numeroDoJid(m.jid)
    const referencia = maisRecente(m.ultima_interacao, m.entrou_em, config.lancamento_em)
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
      logs.push({ ...base, resultado: await remover(sock, m.jid, m.signup_id, grupos ?? [], config.dias_limite, hoje) })
      continue
    }

    if (!lembrada) {
      if (teste) {
        logs.push({ ...base, resultado: 'receberia lembrete' })
        continue
      }
      let entregue = true
      try {
        await sock.sendMessage(m.jid, { text: textoLembrete(dias, Math.max(config.dias_limite - dias, 1)) })
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
