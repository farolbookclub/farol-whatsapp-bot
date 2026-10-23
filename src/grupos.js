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

// !configurar bate_papo|leitura|avisos|presencial — só admin do grupo, uma vez
// por tópico (tira de qualquer outro grupo que já tivesse esse tópico).
export async function configurarGrupo(groupJid, nomeGrupo, topico) {
  if (!TOPICOS.includes(topico)) return 'Tópico inválido. Use: bate_papo, leitura, avisos ou presencial.'
  await supabase.from('whatsapp_grupos').update({ topico: null }).eq('topico', topico)
  const { error } = await supabase
    .from('whatsapp_grupos')
    .upsert({ group_jid: groupJid, nome: nomeGrupo, topico, ativo: true }, { onConflict: 'group_jid' })
  if (error) throw error
  return `Pronto! Esse grupo agora é o "${topico}" 💕`
}
