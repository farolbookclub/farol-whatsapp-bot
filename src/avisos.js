import { supabase } from './supabase.js'

const INTERVALO_MS = 5000 // 5s entre mensagens, pra não levar ban por flood

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Pega o aviso pendente mais antigo (se tiver) e manda no privado de cada
// integrante vinculada, uma de cada vez com intervalo. Quem não tem número
// vinculado ou falhar no envio entra no relatório de falhas.
export async function processarAvisosPendentes(sock) {
  const { data: aviso } = await supabase
    .from('whatsapp_avisos')
    .select('id, mensagem')
    .eq('status', 'pendente')
    .order('criado_em', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!aviso) return

  await supabase.from('whatsapp_avisos').update({ status: 'processando' }).eq('id', aviso.id)

  const { data: signups } = await supabase.from('signups').select('id, apelido, nome').eq('status', 'aprovado')
  const { data: membros } = await supabase.from('whatsapp_membros').select('jid, signup_id').is('removido_em', null)
  const jidPorSignup = new Map((membros ?? []).map((m) => [m.signup_id, m.jid]))

  let enviados = 0
  const falhas = []

  for (const s of signups ?? []) {
    const jid = jidPorSignup.get(s.id)
    const nome = s.apelido || s.nome || s.id
    if (!jid) {
      falhas.push({ nome, motivo: 'número do WhatsApp não vinculado' })
      continue
    }
    try {
      await sock.sendMessage(jid, { text: aviso.mensagem })
      enviados++
    } catch (erro) {
      falhas.push({ nome, motivo: erro?.message || 'falha ao enviar' })
    }
    await esperar(INTERVALO_MS)
  }

  await supabase
    .from('whatsapp_avisos')
    .update({ status: 'concluido', enviados, falhas, concluido_em: new Date().toISOString() })
    .eq('id', aviso.id)
}
