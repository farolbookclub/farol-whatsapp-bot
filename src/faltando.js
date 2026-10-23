import { supabase } from './supabase.js'

// Números de um participante do grupo (id normal, @lid ou outros campos que
// o Baileys expuser), pra comparar com o jid guardado mesmo se o WhatsApp
// mostrar um @lid em vez do número real (privacidade).
function numerosDoParticipante(p) {
  const nums = new Set()
  for (const campo of [p.id, p.jid, p.lid, p.phoneNumber]) {
    if (campo) nums.add(String(campo).split(':')[0].split('@')[0])
  }
  return nums
}

// Quem é aprovada mas não tem número de WhatsApp vinculado, e quem é
// vinculada mas não está nesse grupo específico (comparando com os
// participantes reais do WhatsApp agora).
export async function membrosFaltando(sock, groupJid) {
  const meta = await sock.groupMetadata(groupJid)
  const presentes = new Set()
  for (const p of meta.participants) for (const n of numerosDoParticipante(p)) presentes.add(n)

  const { data: signups } = await supabase.from('signups').select('id, apelido, nome').eq('status', 'aprovado')
  const { data: membros } = await supabase.from('whatsapp_membros').select('jid, signup_id').is('removido_em', null)
  const jidPorSignup = new Map((membros ?? []).map((m) => [m.signup_id, m.jid]))

  const semVinculo = []
  const naoNoGrupo = []
  for (const s of signups ?? []) {
    const jid = jidPorSignup.get(s.id)
    const nome = s.apelido || s.nome || '—'
    if (!jid) {
      semVinculo.push(nome)
      continue
    }
    const numero = jid.split('@')[0]
    if (!presentes.has(numero)) naoNoGrupo.push(nome)
  }

  return { nomeGrupo: meta.subject, semVinculo, naoNoGrupo }
}
