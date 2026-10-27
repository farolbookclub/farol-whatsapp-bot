import { supabase } from './supabase.js'

// Avisos agendados pro grupo (ex.: "manda isso no Avisos quinta-feira às 18h").
// Diferente de whatsapp_avisos (que manda no privado de cada integrante), isso
// posta uma vez só no grupo certo, na hora marcada.
export async function processarAvisosAgendados(sock) {
  const { data: aviso, error } = await supabase
    .from('whatsapp_avisos_grupo_agendados')
    .select('id, topico, mensagem')
    .is('enviado_em', null)
    .lte('enviar_em', new Date().toISOString())
    .order('enviar_em', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('processarAvisosAgendados (busca):', error.message)
    return
  }
  if (!aviso) return

  const { data: grupo } = await supabase
    .from('whatsapp_grupos')
    .select('group_jid')
    .eq('topico', aviso.topico)
    .eq('ativo', true)
    .maybeSingle()

  if (!grupo) {
    await supabase
      .from('whatsapp_avisos_grupo_agendados')
      .update({ enviado_em: new Date().toISOString(), erro: `grupo do tópico "${aviso.topico}" não encontrado/ativo` })
      .eq('id', aviso.id)
    return
  }

  try {
    await sock.sendMessage(grupo.group_jid, { text: aviso.mensagem })
    await supabase.from('whatsapp_avisos_grupo_agendados').update({ enviado_em: new Date().toISOString() }).eq('id', aviso.id)
  } catch (erro) {
    console.error('processarAvisosAgendados (envio):', erro)
    await supabase
      .from('whatsapp_avisos_grupo_agendados')
      .update({ enviado_em: new Date().toISOString(), erro: erro?.message || 'falha ao enviar' })
      .eq('id', aviso.id)
  }
}
