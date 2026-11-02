import { supabase } from './supabase.js'

// Confere se o código do site mudou (rotação automática semanal ou pedido
// manual) e ainda não foi postado no Avisos do WhatsApp; posta se precisar.
export async function checarCodigoPendente(sock) {
  const { data: config } = await supabase
    .from('bot_config')
    .select('codigo_atual, codigo_trocado_em, codigo_postado_whatsapp_em')
    .eq('id', 1)
    .single()
  if (!config?.codigo_atual || !config.codigo_trocado_em) return

  const jaPostado = config.codigo_postado_whatsapp_em && new Date(config.codigo_postado_whatsapp_em) >= new Date(config.codigo_trocado_em)
  if (jaPostado) return

  const { data: grupo } = await supabase.from('whatsapp_grupos').select('group_jid').eq('topico', 'avisos').eq('ativo', true).maybeSingle()
  if (!grupo) return

  await sock.sendMessage(grupo.group_jid, {
    text: `🔑 Código para acessar o site de membras (https://membrosfarol.vercel.app/):`,
  })
  await sock.sendMessage(grupo.group_jid, { text: config.codigo_atual })

  await supabase.from('bot_config').update({ codigo_postado_whatsapp_em: new Date().toISOString() }).eq('id', 1)
}
