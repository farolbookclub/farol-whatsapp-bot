import { supabase } from './supabase.js'

const INTERVALO_MS = 5000 // 5s entre mensagens, pra não levar ban por flood

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Manda no privado de uma lista de signups (mesma lógica do avisos.js, mas
// reaproveitável pros vários tipos de destinatário aqui).
async function enviarParaSignups(sock, mensagem, signups) {
  const { data: membros } = await supabase.from('whatsapp_membros').select('jid, signup_id').is('removido_em', null)
  const jidPorSignup = new Map((membros ?? []).map((m) => [m.signup_id, m.jid]))

  let enviados = 0
  const falhas = []

  for (const s of signups) {
    const jid = jidPorSignup.get(s.id)
    const nome = s.apelido || s.nome || s.id
    if (!jid) {
      falhas.push({ nome, motivo: 'número do WhatsApp não vinculado' })
      continue
    }
    try {
      await sock.sendMessage(jid, { text: mensagem })
      enviados++
    } catch (erro) {
      falhas.push({ nome, motivo: erro?.message || 'falha ao enviar' })
    }
    await esperar(INTERVALO_MS)
  }

  return { enviados, falhas }
}

async function signupsDoTipo(aviso) {
  if (aviso.tipo === 'selecionadas') {
    if (!aviso.signup_ids?.length) return []
    const { data } = await supabase.from('signups').select('id, apelido, nome').in('id', aviso.signup_ids)
    return data ?? []
  }
  let query = supabase.from('signups').select('id, apelido, nome').eq('status', 'aprovado')
  if (aviso.tipo === 'online' || aviso.tipo === 'presencial') query = query.eq('formato', aviso.tipo)
  const { data } = await query
  return data ?? []
}

// Pega o aviso agendado mais antigo que já passou da hora marcada (se tiver)
// e processa de acordo com o tipo: grupo (posta 1x no grupo certo) ou
// todas/online/presencial/selecionadas (manda no privado de cada uma, com
// intervalo, igual o avisos.js).
export async function processarAvisosAgendados(sock) {
  // Só processa 1 por rodada (a próxima só entra no ciclo de 1 min seguinte,
  // com os 5s de intervalo entre mensagens dentro de cada um) — nunca manda
  // tudo de uma vez. Quando duas caem no mesmo horário, o grupo vai primeiro
  // (prioridade explícita, não depende de ordem alfabética do tipo).
  const { data: candidatos, error } = await supabase
    .from('whatsapp_avisos_agendados')
    .select('id, tipo, topico, signup_ids, mensagem, enviar_em, criado_em')
    .eq('status', 'pendente')
    .lte('enviar_em', new Date().toISOString())
    .order('enviar_em', { ascending: true })
    .limit(10)
  if (error) {
    console.error('processarAvisosAgendados (busca):', error.message)
    return
  }
  if (!candidatos?.length) return

  const aviso = candidatos.sort((a, b) => {
    const prioridade = (x) => (x.tipo === 'grupo' ? 0 : 1)
    return a.enviar_em.localeCompare(b.enviar_em) || prioridade(a) - prioridade(b) || a.criado_em.localeCompare(b.criado_em)
  })[0]

  await supabase.from('whatsapp_avisos_agendados').update({ status: 'processando' }).eq('id', aviso.id)

  if (aviso.tipo === 'grupo') {
    const { data: grupo } = await supabase
      .from('whatsapp_grupos')
      .select('group_jid')
      .eq('topico', aviso.topico)
      .eq('ativo', true)
      .maybeSingle()

    if (!grupo) {
      await supabase
        .from('whatsapp_avisos_agendados')
        .update({ status: 'erro', erro: `grupo do tópico "${aviso.topico}" não encontrado/ativo`, concluido_em: new Date().toISOString() })
        .eq('id', aviso.id)
      return
    }

    try {
      await sock.sendMessage(grupo.group_jid, { text: aviso.mensagem })
      await supabase.from('whatsapp_avisos_agendados').update({ status: 'concluido', concluido_em: new Date().toISOString() }).eq('id', aviso.id)
    } catch (erro) {
      console.error('processarAvisosAgendados (grupo):', erro)
      await supabase
        .from('whatsapp_avisos_agendados')
        .update({ status: 'erro', erro: erro?.message || 'falha ao enviar', concluido_em: new Date().toISOString() })
        .eq('id', aviso.id)
    }
    return
  }

  // Tipos que mandam no privado (todas/online/presencial/selecionadas).
  try {
    const signups = await signupsDoTipo(aviso)
    const resultado = await enviarParaSignups(sock, aviso.mensagem, signups)
    await supabase
      .from('whatsapp_avisos_agendados')
      .update({ status: 'concluido', resultado, concluido_em: new Date().toISOString() })
      .eq('id', aviso.id)
  } catch (erro) {
    console.error('processarAvisosAgendados (privado):', erro)
    await supabase
      .from('whatsapp_avisos_agendados')
      .update({ status: 'erro', erro: erro?.message || 'falha desconhecida', concluido_em: new Date().toISOString() })
      .eq('id', aviso.id)
  }
}
