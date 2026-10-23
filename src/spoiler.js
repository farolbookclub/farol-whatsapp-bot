import { supabase } from './supabase.js'

// "SPOILER capítulo 12 esse personagem morre" -> guarda o texto todo (sem a
// palavra SPOILER) pra mandar só a quem pedir no privado.
export const PADRAO_SPOILER = /^spoiler\b[:\s]*/i

export async function guardarSpoiler({ groupJid, topico, apelido, texto }) {
  const semPrefixo = texto.replace(PADRAO_SPOILER, '').trim()
  if (!semPrefixo) return
  const { error } = await supabase.from('whatsapp_spoilers').insert({ group_jid: groupJid, topico, apelido, texto: semPrefixo })
  if (error) console.error('guardarSpoiler:', error.message)
}

export async function buscarUltimoSpoiler(topico) {
  const { data } = await supabase
    .from('whatsapp_spoilers')
    .select('apelido, texto, criado_em')
    .eq('topico', topico)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data || null
}
