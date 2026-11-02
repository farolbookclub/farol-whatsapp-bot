import { supabase } from './supabase.js'

export const TOPICOS = ['bate_papo', 'leitura', 'avisos', 'presencial']

// Qual tópico esse grupo representa (ou null, se não for um dos grupos
// configurados do Farol).
export async function identificarTopico(groupJid) {
  const { data } = await supabase.from('whatsapp_grupos').select('topico, ativo').eq('group_jid', groupJid).maybeSingle()
  if (!data || !data.ativo) return null
  return data.topico
}

export async function grupoAtivo(groupJid) {
  const { data } = await supabase.from('whatsapp_grupos').select('ativo').eq('group_jid', groupJid).maybeSingle()
  return !!data?.ativo
}
